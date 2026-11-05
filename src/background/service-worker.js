import { ALARM_NAME, ALARM_PERIOD_MINUTES, CHECKPOINT_ALARM_NAME, CHECKPOINT_PERIOD_MINUTES, RESOURCE_REVIEW_ALARM_NAME, SUSPENDED_PAGE, SUSPENSION_MODES, SUSPENSION_STATES, SUSPENSION_STRATEGIES } from "../shared/constants.js";
import { directSuspensionBlockReason, domainForUrl, isExpectedSuspensionUrl, isIdleLongEnough, isSuspendableUrl, isSuspendedUrl, normalizeDomain, planLocalOrganization, smartSuspensionBlockReason, suspensionBlockReason } from "../shared/policy.js";
import { addRecentSuspension, addRecoveryCheckpoint, addWorkspace, getActivity, getObservedAt, getRecentSuspensions, getRecord, getRecords, getRecoveryCheckpoints, getResourceReviews, getResourceSnapshots, getSettings, getWorkspaces, putRecord, removeActivity, removePrimaryRecord, removeRecentSuspension, removeRecord, removeRecordsForTab, removeResourceSnapshot, saveResourceSnapshots, saveSettings, touchTab } from "../shared/storage.js";
import { buildSuspendCandidate, createPageIndex } from "../shared/search.js";
import { buildHeapDiagnostics, buildRendererDiagnostics, summarizeHeapSnapshots } from "../shared/resource.js";
import { buildResourceReclaimPlan } from "../shared/insights.js";
import { AI_PLAN_SCHEMA, buildAiThemePrompt, publicAiSnapshot, selectAiPages, validateAiMembers, validateAiName, validateAiPlan } from "../shared/ai-analysis.js";
import { buildOllamaRequest, normalizeOllamaEndpoint, normalizeOllamaModel, ollamaCapability, OLLAMA_PROBE_SCHEMA, validateOllamaProbe } from "../shared/ollama.js";
import { buildResourceReview, findStaleWorkspaces, nextReviewAt } from "../shared/review.js";
import { getOperations, groupOperation, operationJournal, runOperation, saveWorkspaceOperation, updateWorkspaceOperation } from "./operations.js";
import { cacheAiPlan, cachedAiPlan } from "../shared/ai-cache.js";
import { getAllWorkspaces, getWorkspaceTrash, updateWorkspace, validateWorkspaceCapacity, saveResourceReviews, changeSettings, changeWorkspaces, getClosedPages, removeClosedPage, queueStorage } from "../shared/storage.js";
import { createRestorer, logicalTabs } from "./restoration.js";
import { resolveSavedResult, sourceState } from "../shared/restoration.js";
import { rotationBatch, mapConcurrent, mergeHeapSamples } from "../shared/scanning.js";
import { editWorkspace, mergeWorkspaces } from "../shared/workspaces.js";
import { createReviewRunner } from "../shared/review-runner.js";
import { buildSessionSnapshot, compareSnapshots } from "../shared/session.js";
import { createPageTracker } from "./page-tracker.js";
import { createWorkspaceUpdates } from "./workspace-updates.js";
import { buildBudget, updateHeapHistory } from "../shared/budget.js";
import { createBackupManager } from "./backup.js";
import { createBatchRunner } from "../shared/batch.js";

const extensionOrigin = chrome.runtime.getURL("").replace(/\/$/, "");
const pageTracker = createPageTracker(extensionOrigin);
const pageIndex = createPageIndex();
let searchVersion = 0;
let indexedVersion = -1;
let indexedAt = 0;
let indexBuild;
const livePorts = new Set();
let changeTimer;
function stateChanged(indexChanged = true) {
  if (indexChanged) searchVersion++;
  if (!livePorts.size || changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    for (const port of livePorts) {
      try { port.postMessage({ type: "stateChanged" }); } catch { livePorts.delete(port); }
    }
  }, 150);
}
chrome.storage.onChanged?.addListener((changes) => {
  const indexKeys = ["workspaces", "recoveryCheckpoints", "recentSuspensions", "closedPages", "suspensionRecords", "suspensionRestoreRecords", "lastActivity", "settings"];
  const displayKeys = [...indexKeys, "resourceSnapshots", "resourceReviews", "operationJournal", "restoreTasks", "batchTasks", "workspaceBindings"];
  if (Object.keys(changes).some((key) => displayKeys.includes(key))) stateChanged(Object.keys(changes).some((key) => indexKeys.includes(key)));
});
const tabQueues = new Map();
const PAGE_PROTECTION_KEY = "pageProtectionStates";
const PAGE_PROTECTION_SCRIPT_ID = "tabwise-page-protection";
const SMART_ORIGINS = ["http://*/*", "https://*/*"];
const DIAGNOSTIC_ORIGINS = ["http://*/*", "https://*/*"];
const AI_SNAPSHOTS_KEY = "aiAnalysisSnapshots";
const AI_CACHE_KEY = "aiThemeCache";
const aiControllers = new Map();
const journal = operationJournal(restoreRecord);
const restorer = createRestorer((id) => runOperation(async () => {
  const workspace = (await getWorkspaces()).find((item) => item.id === id);
  if (!workspace) return;
  if (workspace.archived) await updateWorkspaceOperation(workspace, { archived: false, resumedAt: Date.now(), lastOpenedAt: Date.now() }, journal);
  else await updateWorkspace(id, { lastOpenedAt: Date.now() });
}));
const workspaceUpdates = createWorkspaceUpdates(currentSessionSnapshot, (workspace, update) => updateWorkspaceOperation(workspace, update, journal));
const backups = createBackupManager(sanitizeSettings);
const reviewRunner = createReviewRunner({ read: getResourceReviews, write: saveResourceReviews, execute: executeResourceReview });
reviewRunner.ready.catch(console.error);
let resourceQueue = Promise.resolve();
let scheduleQueue = Promise.resolve();
const resourceVersions = new Map();
const resourceEpoch = crypto.randomUUID();
const batchRunner = createBatchRunner({
  read: async () => (await chrome.storage.session.get("batchTasks")).batchTasks || [],
  write: (batchTasks) => chrome.storage.session.set({ batchTasks }),
  execute: executeBatchItem,
  finalize: finalizeBatch
});
batchRunner.ready.catch(console.error);
async function finalizeBatch(task) {
  if (task.operationId) return {};
  const records = Object.values(await getRecords()).filter((record) => record.reason === `batch:${task.id}` && record.state === SUSPENSION_STATES.SUSPENDED);
  const items = task.kind === "group" ? task.results.flatMap((result) => result.undoItems || []).filter((item) => item.after)
    : records.map((record) => ({ kind: "suspension", recordId: record.recordId }));
  if (!items.length) return {};
  const entry = await runOperation(async () => {
    const existing = (await getOperations()).find((item) => item.batchTaskId === task.id);
    return existing || journal.record(task.name, items, "ready", task.id);
  });
  return { operationId: entry.id };
}
async function batchBlock(tab, settings, expected) {
  if (expected.budget) return budgetBlock(tab, settings, expected);
  if (tab.incognito || tab.url !== expected.url || (resourceVersions.get(tab.id) || 0) !== expected.revision) return "页面已变化。";
  const [protection, activity] = await Promise.all([getProtectionStates(), getActivity()]);
  return (expected.group
    ? directSuspensionBlockReason(tab, extensionOrigin) || (tab.pinned || tab.audible ? "页面受保护。" : "") || (tab.index !== expected.index || tab.groupId !== expected.groupId ? "页面布局已变化。" : "")
    : settings.suspensionMode === SUSPENSION_MODES.SMART ? smartSuspensionBlockReason(tab, settings, extensionOrigin, protection[tab.id]) : suspensionBlockReason(tab, settings, extensionOrigin))
    || (activity[tab.id] !== expected.lastActivity ? "页面最近已活动。" : "");
}
async function executeBatchItem(item, task, remember) {
  if (task.kind !== "group") {
    const result = await suspendTab(item.tabId, `batch:${task.id}`, false, item, true);
    return { ...result, skipped: !result.ok && !result.error };
  }
  const tabs = await Promise.all(item.pages.map((page) => chrome.tabs.get(page.tabId).catch(() => null)));
  for (let i = 0; i < tabs.length; i++) {
    if (!tabs[i] || tabs[i].windowId !== item.windowId) return { skipped: true, reason: "窗口或页面已变化。" };
    const reason = await batchBlock(tabs[i], await getSettings(), item.pages[i]);
    if (reason) return { skipped: true, reason };
  }
  return runOperation(() => groupOperation(item.pages.map((page) => page.tabId), item.title, {
    async record(label, items) { await remember({ undoItems: items }); return { id: task.id }; },
    async finish(id, items) { await remember({ undoItems: items }); }
  }));
}
async function startBatchSuspend(sender) {
  const [tabs, activity] = await Promise.all([chrome.tabs.query(sender?.tab?.windowId ? { windowId: sender.tab.windowId } : { currentWindow: true }), getActivity()]);
  return batchRunner.start({ name: "批量休眠", kind: "suspend", items: tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => ({
    tabId: tab.id, title: tab.title, url: tab.url, revision: resourceVersions.get(tab.id) || 0, lastActivity: activity[tab.id]
  })) });
}
async function groupItems(message) {
  const ids = [...new Set(message.tabIds || [])].filter(Number.isInteger);
  if (ids.length > 5000) throw new Error("每项分组任务最多包含 5000 页。");
  const [tabs, activity] = await Promise.all([Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null))), getActivity()]);
  const windows = new Map();
  for (const tab of tabs.filter(Boolean)) {
    if (!windows.has(tab.windowId)) windows.set(tab.windowId, []);
    windows.get(tab.windowId).push({ tabId: tab.id, url: tab.url, group: true, groupId: tab.groupId, index: tab.index, revision: resourceVersions.get(tab.id) || 0, lastActivity: activity[tab.id] });
  }
  const title = String(message.title || "Related tabs").slice(0, 80);
  return [...windows].filter(([, pages]) => pages.length >= 2).map(([windowId, pages]) => ({
    windowId, pages, size: pages.length, title
  }));
}
async function startBatchGroup(message) {
  const items = await groupItems(message);
  return batchRunner.start({ name: `批量分组 · ${String(message.title || "Related tabs").slice(0, 80)}`, kind: "group", items });
}
async function prepareBatch(message, sender) {
  if (!sender.documentId) throw new Error("请从 TabWise 界面预览批量操作。");
  let pages;
  if (message.kind === "group") {
    const items = await groupItems(message);
    pages = items.flatMap((item) => item.pages.map((page) => ({ ...page, title: page.url, windowId: item.windowId })));
  } else {
    const [tabs, settings, activity] = await Promise.all([chrome.tabs.query(sender.tab?.windowId ? { windowId: sender.tab.windowId } : { currentWindow: true }), getSettings(), getActivity()]);
    pages = [];
    for (const tab of tabs) {
      const page = { tabId: tab.id, title: tab.title, url: tab.url, windowId: tab.windowId, revision: resourceVersions.get(tab.id) || 0, lastActivity: activity[tab.id] };
      if (!await batchBlock(tab, settings, page)) pages.push(page);
    }
  }
  if (pages.length > 5000) throw new Error("批量预览最多包含 5000 页，请缩小范围。");
  const preview = { id: crypto.randomUUID(), owner: sender.documentId, expiresAt: Date.now() + 5 * 60_000, kind: message.kind === "group" ? "group" : "suspend", title: String(message.title || "Related tabs").slice(0, 80), pages };
  await queueStorage("session", async () => {
    const { batchPreviews = [] } = await chrome.storage.session.get("batchPreviews");
    await chrome.storage.session.set({ batchPreviews: [preview, ...batchPreviews.filter((item) => item.owner !== preview.owner && item.expiresAt > Date.now())].slice(0, 10) });
  });
  return { ok: true, previewId: preview.id, pages, kind: preview.kind };
}
async function startBatchPreview(message, sender) {
  return queueStorage("session", async () => {
    const { batchPreviews = [] } = await chrome.storage.session.get("batchPreviews");
    const preview = batchPreviews.find((item) => item.id === message.previewId && item.owner === sender.documentId && item.expiresAt > Date.now());
    if (!preview) throw new Error("预览已过期或已执行。");
    if (!Array.isArray(message.tabIds) || !message.tabIds.length || message.tabIds.some((id) => !preview.pages.some((page) => page.tabId === id))) throw new Error("请从预览中选择页面。");
    let items = preview.pages.filter((page) => message.tabIds.includes(page.tabId));
    if (preview.kind === "group") {
      const windows = new Map();
      for (const page of items) { if (!windows.has(page.windowId)) windows.set(page.windowId, []); windows.get(page.windowId).push(page); }
      items = [...windows].filter(([, pages]) => pages.length >= 2).map(([windowId, pages]) => ({ windowId, pages, size: pages.length, title: preview.title }));
    }
    const result = await batchRunner.start({ kind: preview.kind, name: preview.kind === "group" ? `批量分组 · ${preview.title}` : "批量休眠", items });
    await chrome.storage.session.set({ batchPreviews: batchPreviews.filter((item) => item.id !== preview.id) });
    return result;
  });
}
const publicTask = ({ results, ...task }) => task;
async function taskDetail(message) {
  const batch = (await batchRunner.list()).find((task) => task.id === message.taskId);
  if (!batch) return restorer.detail(message.taskId, message.offset);
  const offset = Math.max(0, Math.floor(Number(message.offset) || 0));
  return { ...publicTask(batch), ok: true, itemTotal: batch.results.length, results: batch.results.slice(offset, offset + 50) };
}
function runResource(work) {
  const next = resourceQueue.catch(() => {}).then(work);
  resourceQueue = next;
  return next;
}
const invalidatedAiTabs = new Set();
let aiQueue = Promise.resolve();

function runAi(work) {
  const next = aiQueue.catch(() => {}).then(work);
  aiQueue = next;
  return next;
}

async function readAiSnapshots() {
  const data = await chrome.storage.session.get(AI_SNAPSHOTS_KEY);
  return (data[AI_SNAPSHOTS_KEY] || []).filter((snapshot) => snapshot.expiresAt > Date.now());
}

async function aiSnapshotForSender(id, sender) {
  const snapshots = await readAiSnapshots();
  const snapshot = snapshots.find((item) => item.id === id && item.owner === sender.documentId);
  if (!snapshot) throw new Error("分析输入已过期或侧栏已刷新，请重新预览。");
  snapshot.invalidatedTabIds = [...new Set([
    ...(snapshot.invalidatedTabIds || []), ...snapshot.pages.filter((page) => invalidatedAiTabs.has(page.tabId)).map((page) => page.tabId)
  ])];
  return { snapshots, snapshot };
}

function invalidateAiTab(tabId) {
  invalidatedAiTabs.add(tabId);
  runAi(async () => {
    const snapshots = await readAiSnapshots();
    let changed = false;
    for (const snapshot of snapshots) {
      if (snapshot.pages.some((page) => page.tabId === tabId)) {
        snapshot.invalidatedTabIds = [...new Set([...(snapshot.invalidatedTabIds || []), tabId])];
        changed = true;
      }
    }
    if (changed) await chrome.storage.session.set({ [AI_SNAPSHOTS_KEY]: snapshots });
    invalidatedAiTabs.delete(tabId);
  }).catch(console.error);
}

async function prepareAiAnalysis(message, sender) {
  for (const request of aiControllers.values()) {
    if (request.owner === sender.documentId) request.controller.abort();
  }
  return runAi(async () => {
    const [tabs, records, workspaces, settings, window] = await Promise.all([
      chrome.tabs.query({}), getRecords(), getWorkspaces(), getSettings(), chrome.windows.getLastFocused()
    ]);
    const recordsByTab = new Map(Object.values(records).map((record) => [record.tabId, record]));
    const pages = selectAiPages({
      ...message, windowId: sender.tab?.windowId ?? window.id, workspaces,
      tabs: tabs.map((tab) => {
        const record = recordsByTab.get(tab.id);
        const suspended = isSuspendedUrl(tab.url, extensionOrigin) || tab.discarded;
        return {
          ...tab, browserUrl: tab.url, browserTitle: tab.title,
          title: suspended && record ? record.title : tab.title,
          url: suspended && record ? record.originalUrl : tab.url,
          status: suspended ? "suspended" : (tab.active || tab.pinned || tab.audible ? "protected" : "open")
        };
      })
    });
    const now = Date.now();
    const snapshot = {
      id: crypto.randomUUID(), owner: sender.documentId, scope: message.scope,
      createdAt: now, expiresAt: now + 10 * 60_000, pages,
      request: String(message.request || "").slice(0, 240), provider: settings.aiProvider,
      endpoint: normalizeOllamaEndpoint(settings.ollamaEndpoint), model: settings.ollamaModel,
      recipient: settings.aiProvider === "ollama" ? `Ollama · ${settings.ollamaEndpoint} · ${settings.ollamaModel}` : "浏览器内置模型",
      applied: []
    };
    const snapshots = (await readAiSnapshots()).filter((item) => item.owner !== sender.documentId).slice(-4);
    snapshots.push(snapshot);
    await chrome.storage.session.set({ [AI_SNAPSHOTS_KEY]: snapshots });
    return { ok: true, snapshot: publicAiSnapshot(snapshot), provider: snapshot.provider, prompt: buildAiThemePrompt(snapshot, snapshot.request), schema: AI_PLAN_SCHEMA };
  });
}

async function acceptAiPlan(id, answer, sender) {
  return runAi(async () => {
    const { snapshots, snapshot } = await aiSnapshotForSender(id, sender);
    if (snapshot.generation === "cancelled") throw new Error("生成已取消，请重新预览。");
    if (snapshot.plan) throw new Error("此输入已经生成建议，请重新预览后重试。");
    const plan = validateAiPlan(answer, snapshot);
    validateAiMembers(snapshot, snapshot.pages.map((page) => page.pageId), await chrome.tabs.query({}), await getWorkspaces(), "save");
    snapshot.plan = plan;
    snapshot.generation = "done";
    await chrome.storage.session.set({ [AI_SNAPSHOTS_KEY]: snapshots });
    const data = await chrome.storage.session.get(AI_CACHE_KEY);
    const entry = await cacheAiPlan(snapshot, plan);
    await chrome.storage.session.set({ [AI_CACHE_KEY]: [entry, ...(data[AI_CACHE_KEY] || []).filter((item) => item.expiresAt > Date.now() && item.key !== entry.key)].slice(0, 10) });
    return { ok: true, plan };
  });
}

async function applyAiGroup(message, sender) {
  return runAi(async () => {
    const { snapshots, snapshot } = await aiSnapshotForSender(message.snapshotId, sender);
    if (snapshot.generation === "cancelled") throw new Error("此次分析已取消，请重新预览。");
    const group = Number.isInteger(message.groupIndex) && snapshot.plan?.groups[message.groupIndex];
    if (!group || !Array.isArray(message.pageIds) || message.pageIds.some((id) => !group.pageIds.includes(id))) throw new Error("成员必须属于原始主题建议。");
    const name = validateAiName(message.name);
    const actionKey = `${message.groupIndex}:${message.action}`;
    if (snapshot.applied.includes(actionKey)) throw new Error("此建议动作已完成，不能重复应用。");
    const members = validateAiMembers(snapshot, message.pageIds, await chrome.tabs.query({}), await getWorkspaces(), message.action);
    // Reserve before touching browser state, including across worker restarts.
    snapshot.applied.push(actionKey);
    await chrome.storage.session.set({ [AI_SNAPSHOTS_KEY]: snapshots });
    try {
      if (message.action === "save") {
        await runOperation(async () => {
          validateAiMembers({ ...snapshot, invalidatedTabIds: [...(snapshot.invalidatedTabIds || []), ...invalidatedAiTabs] }, message.pageIds, await chrome.tabs.query({}), await getWorkspaces(), "save");
          await saveWorkspaceOperation({
            id: crypto.randomUUID(), name, createdAt: Date.now(), archived: false,
            tabs: members.map((page) => ({ title: page.sourceTitle ?? page.title, url: page.url }))
          }, journal);
        });
      } else {
        const current = await Promise.all(members.map((page) => chrome.tabs.get(page.tabId)));
        validateAiMembers({ ...snapshot, invalidatedTabIds: [...(snapshot.invalidatedTabIds || []), ...invalidatedAiTabs] }, message.pageIds, current, [], "group");
        await runOperation(async () => {
          validateAiMembers({ ...snapshot, invalidatedTabIds: [...(snapshot.invalidatedTabIds || []), ...invalidatedAiTabs] }, message.pageIds, await chrome.tabs.query({}), [], "group");
          return groupOperation(members.map((page) => page.tabId), name, journal);
        });
      }
    } catch (error) {
      // An API may have applied a change before rejecting; don't replay it.
      throw new Error(`应用未全部完成：${error.message}。请检查当前状态后重新分析。`);
    }
    return { ok: true, count: members.length };
  });
}

function escapeOmniboxText(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function runForTab(tabId, work) {
  const previous = tabQueues.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  const tracked = next.finally(() => {
    if (tabQueues.get(tabId) === tracked) tabQueues.delete(tabId);
  });
  tabQueues.set(tabId, tracked);
  return next;
}

function sanitizeSettings(current, update) {
  const normalizeList = (values) => [...new Set((Array.isArray(values) ? values : []).map(normalizeDomain).filter((value) => /^[a-z0-9.-]+$/i.test(value)))];
  const idleMinutes = Number(update.idleMinutes);
  const pauseUntil = Number(update.pauseUntil);
  return {
    idleMinutes: Number.isFinite(idleMinutes) ? Math.min(1440, Math.max(5, Math.round(idleMinutes))) : current.idleMinutes,
    autoSuspend: typeof update.autoSuspend === "boolean" ? update.autoSuspend : current.autoSuspend,
    suspensionMode: update.suspensionMode === SUSPENSION_MODES.SMART || update.suspensionMode === SUSPENSION_MODES.CONSERVATIVE
      ? update.suspensionMode
      : current.suspensionMode,
    suspensionStrategy: update.suspensionStrategy === SUSPENSION_STRATEGIES.NATIVE_DISCARD || update.suspensionStrategy === SUSPENSION_STRATEGIES.PLACEHOLDER
      ? update.suspensionStrategy
      : current.suspensionStrategy,
    semanticSearch: typeof update.semanticSearch === "boolean" ? update.semanticSearch : current.semanticSearch,
    aiProvider: update.aiProvider === "ollama" || update.aiProvider === "browser" ? update.aiProvider : current.aiProvider,
    ollamaEndpoint: typeof update.ollamaEndpoint === "string"
      ? normalizeOllamaEndpoint(update.ollamaEndpoint, current.ollamaEndpoint)
      : current.ollamaEndpoint,
    ollamaModel: typeof update.ollamaModel === "string"
      ? normalizeOllamaModel(update.ollamaModel, current.ollamaModel)
      : current.ollamaModel,
    scheduledReviewEnabled: typeof update.scheduledReviewEnabled === "boolean" ? update.scheduledReviewEnabled : current.scheduledReviewEnabled,
    scheduledReviewHour: Number.isFinite(Number(update.scheduledReviewHour))
      ? Math.min(23, Math.max(0, Math.round(Number(update.scheduledReviewHour))))
      : current.scheduledReviewHour,
    scheduledReviewMinute: Number.isFinite(Number(update.scheduledReviewMinute))
      ? Math.min(59, Math.max(0, Math.round(Number(update.scheduledReviewMinute))))
      : current.scheduledReviewMinute,
    scheduledArchiveEnabled: typeof update.scheduledArchiveEnabled === "boolean" ? update.scheduledArchiveEnabled : current.scheduledArchiveEnabled,
    scheduledArchiveDays: Number.isFinite(Number(update.scheduledArchiveDays))
      ? Math.min(365, Math.max(7, Math.round(Number(update.scheduledArchiveDays))))
      : current.scheduledArchiveDays,
    resourceSampling: typeof update.resourceSampling === "boolean" ? update.resourceSampling : current.resourceSampling,
    resourceBudgetEnabled: typeof update.resourceBudgetEnabled === "boolean" ? update.resourceBudgetEnabled : current.resourceBudgetEnabled,
    resourceBudgetTabs: Number.isFinite(Number(update.resourceBudgetTabs)) ? Math.min(1000, Math.max(1, Math.round(Number(update.resourceBudgetTabs)))) : current.resourceBudgetTabs,
    resourceBudgetHeapMB: Number.isFinite(Number(update.resourceBudgetHeapMB)) ? Math.min(65536, Math.max(64, Math.round(Number(update.resourceBudgetHeapMB)))) : current.resourceBudgetHeapMB,
    closedHistoryEnabled: typeof update.closedHistoryEnabled === "boolean" ? update.closedHistoryEnabled : current.closedHistoryEnabled,
    closedHistoryDays: Number.isFinite(Number(update.closedHistoryDays)) ? Math.min(30, Math.max(1, Math.round(Number(update.closedHistoryDays)))) : current.closedHistoryDays,
    trustedDomains: Array.isArray(update.trustedDomains) ? normalizeList(update.trustedDomains) : current.trustedDomains,
    blockedDomains: Array.isArray(update.blockedDomains) ? normalizeList(update.blockedDomains) : current.blockedDomains,
    pauseUntil: Number.isFinite(pauseUntil) && pauseUntil > Date.now() ? pauseUntil : 0
  };
}

async function getProtectionStates() {
  const { [PAGE_PROTECTION_KEY]: states = {} } = await chrome.storage.session.get(PAGE_PROTECTION_KEY);
  return states;
}

async function setProtectionState(tabId, state) {
  const states = await getProtectionStates();
  states[tabId] = { ...state, updatedAt: Date.now() };
  await chrome.storage.session.set({ [PAGE_PROTECTION_KEY]: states });
}

async function removeProtectionState(tabId) {
  const states = await getProtectionStates();
  delete states[tabId];
  await chrome.storage.session.set({ [PAGE_PROTECTION_KEY]: states });
}

async function registerProtectionScript() {
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [PAGE_PROTECTION_SCRIPT_ID] });
  if (scripts.length) return;
  await chrome.scripting.registerContentScripts([{
    id: PAGE_PROTECTION_SCRIPT_ID,
    js: ["src/content/protection.js"],
    matches: SMART_ORIGINS,
    runAt: "document_start",
    allFrames: false,
    persistAcrossSessions: true
  }]);
}

async function initializeExistingProtection() {
  const tabs = await chrome.tabs.query({});
  await mapConcurrent(tabs.filter((tab) => tab.id && isSuspendableUrl(tab.url)), 4,
    (tab) => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content/protection.js"] }).catch(() => {}));
}

async function setSuspensionMode(mode) {
  const settings = await getSettings();
  if (mode === SUSPENSION_MODES.SMART) {
    const granted = await chrome.permissions.contains({ origins: SMART_ORIGINS });
    if (!granted) return { ok: false, reason: "未授予网页保护权限，已保留保守模式" };
    await registerProtectionScript();
    await initializeExistingProtection();
  } else {
    await chrome.scripting.unregisterContentScripts({ ids: [PAGE_PROTECTION_SCRIPT_ID] }).catch(() => {});
    await chrome.storage.session.remove(PAGE_PROTECTION_KEY);
  }
  await saveSettings({ ...settings, suspensionMode: mode });
  return { ok: true, mode };
}

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
}

async function ensureCheckpointAlarm() {
  const alarm = await chrome.alarms.get(CHECKPOINT_ALARM_NAME);
  if (!alarm) await chrome.alarms.create(CHECKPOINT_ALARM_NAME, { periodInMinutes: CHECKPOINT_PERIOD_MINUTES });
}

function scheduleResourceReview() {
  const next = scheduleQueue.catch(() => {}).then(async () => {
    const settings = await getSettings();
    await chrome.alarms.clear(RESOURCE_REVIEW_ALARM_NAME);
    if (!settings.scheduledReviewEnabled) {
      await chrome.storage.local.remove("resourceReviewSchedule");
      return;
    }
    const signature = `${settings.scheduledReviewHour}:${settings.scheduledReviewMinute || 0}`;
    const { resourceReviewSchedule: saved } = await chrome.storage.local.get("resourceReviewSchedule");
    const now = Date.now();
    if (saved?.signature === signature && saved.dueAt <= now) {
      // At most one catch-up after sleep; no replay of failed/uncertain slots.
      await runResourceReview("scheduled", { scheduledSlot: saved.dueAt, caughtUp: now - saved.dueAt > 60_000 });
    }
    const dueAt = saved?.signature === signature && saved.dueAt > now
      ? saved.dueAt : nextReviewAt(settings.scheduledReviewHour, Date.now(), settings.scheduledReviewMinute);
    await chrome.storage.local.set({ resourceReviewSchedule: { signature, dueAt } });
    await chrome.alarms.create(RESOURCE_REVIEW_ALARM_NAME, { when: dueAt });
  });
  scheduleQueue = next;
  return next;
}

async function recordExistingTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id && !isSuspendedUrl(tab.url, extensionOrigin)) await touchTab(tab.id);
  }
}

async function rebindSuspendedTabs() {
  const records = await getRecords();
  const tabs = await chrome.tabs.query({});
  const currentByRecord = new Map();
  for (const tab of tabs) {
    const recordId = new URL(tab.url || "https://invalid.local").hash.slice(1);
    if (isSuspendedUrl(tab.url, extensionOrigin) && recordId) currentByRecord.set(recordId, tab);
  }
  await Promise.all(Object.entries(records).map(async ([recordId, record]) => {
    const tab = currentByRecord.get(recordId);
    if (tab) await putRecord({ ...record, tabId: tab.id, windowId: tab.windowId, state: SUSPENSION_STATES.SUSPENDED });
  }));
}

async function budgetBlock(tab, settings, expected) {
  if (!settings.resourceBudgetEnabled) return "资源预算已关闭。";
  if (tab.incognito || tab.url !== expected.url || (resourceVersions.get(tab.id) || 0) !== expected.revision) return "页面已变化。";
  const [protection, activity] = await Promise.all([getProtectionStates(), getActivity()]);
  return (settings.suspensionMode === SUSPENSION_MODES.SMART ? "" : suspensionBlockReason(tab, settings, extensionOrigin))
    || smartSuspensionBlockReason(tab, settings, extensionOrigin, protection[tab.id])
    || (activity[tab.id] !== expected.lastActivity || !isIdleLongEnough(activity, tab.id, settings.idleMinutes * 60_000) ? "页面最近已活动。" : "");
}
async function suspendTab(tabId, reason = "manual", allowProtected = false, expected, aggregate = false) {
  return runForTab(tabId, async () => {
    let recordId;
    try {
      const [settings, tab] = await Promise.all([getSettings(), chrome.tabs.get(tabId)]);
      const blockReason = expected ? await batchBlock(tab, settings, expected) : allowProtected
        ? directSuspensionBlockReason(tab, extensionOrigin)
        : suspensionBlockReason(tab, settings, extensionOrigin);
      if (blockReason) return { ok: false, reason: blockReason };

      recordId = crypto.randomUUID();
      const record = {
        recordId,
        tabId,
        windowId: tab.windowId,
        originalUrl: tab.url,
        title: tab.title || domainForUrl(tab.url),
        suspendedAt: Date.now(),
        state: SUSPENSION_STATES.SUSPENDING,
        reason
      };
      await putRecord(record);

      const freshTab = await chrome.tabs.get(tabId);
      const freshBlock = expected ? await batchBlock(freshTab, await getSettings(), expected) : "";
      if (freshTab.url !== tab.url || freshTab.active || freshBlock) {
        await removeRecord(recordId);
        return { ok: false, reason: "Tab changed before suspension" };
      }

      let mode = SUSPENSION_STRATEGIES.PLACEHOLDER;
      if (settings.suspensionStrategy === SUSPENSION_STRATEGIES.NATIVE_DISCARD) {
        const discarded = await chrome.tabs.discard(tabId);
        if (!discarded?.discarded) {
          await removeRecord(recordId);
          return { ok: false, reason: "浏览器拒绝卸载该标签页" };
        }
        mode = SUSPENSION_STRATEGIES.NATIVE_DISCARD;
      } else {
        const expectedUrl = `${chrome.runtime.getURL(SUSPENDED_PAGE)}#${recordId}`;
        await chrome.tabs.update(tabId, { url: expectedUrl });
      }
      await removeResourceSnapshot(tabId).catch(console.error);
      const suspendedRecord = { ...record, mode, state: SUSPENSION_STATES.SUSPENDED };
      await putRecord(suspendedRecord);
      await addRecentSuspension(suspendedRecord);
      if (!aggregate) await journal.record(`休眠 · ${suspendedRecord.title}`, [{ kind: "suspension", recordId }]).catch(console.error);
      return { ok: true, recordId };
    } catch (error) {
      if (recordId) await removeRecord(recordId);
      return { ok: false, error: true, reason: error.message || "休眠操作失败" };
    }
  });
}

async function restoreRecord(recordId, senderTabId) {
  const record = await getRecord(recordId);
  if (!record) return { ok: false, reason: "Suspension record no longer exists" };
  const tabId = senderTabId || record.tabId;

  return runForTab(tabId, async () => {
    const current = await chrome.tabs.get(tabId);
    if (record.mode === "native-discard") {
      if (current.url !== record.originalUrl) return { ok: false, reason: "标签页已导航到其他地址" };
      if (!current.discarded) {
        await removeRecord(recordId);
        return { ok: true };
      }
      await chrome.tabs.reload(tabId);
      await removeRecord(recordId);
      await removeRecentSuspension(recordId);
      await touchTab(tabId);
      return { ok: true };
    }

    const expected = `${chrome.runtime.getURL(SUSPENDED_PAGE)}#${recordId}`;
    if (current.url !== expected) return { ok: false, reason: "This tab no longer matches the suspended page" };
    if (!isSuspendableUrl(record.originalUrl)) return { ok: false, reason: "The original URL is no longer supported" };

    await putRecord({ ...record, state: SUSPENSION_STATES.RESTORING, tabId });
    await chrome.tabs.update(tabId, { url: record.originalUrl });
    // Keep the recovery copy until the URL actually leaves the placeholder.
    await touchTab(tabId);
    return { ok: true };
  });
}

async function processIdleTabs() {
  const settings = await getSettings();
  if (!settings.autoSuspend || settings.pauseUntil > Date.now()) return;

  const tabs = await chrome.tabs.query({});
  const protectionStates = settings.suspensionMode === SUSPENSION_MODES.SMART ? await getProtectionStates() : {};
  const activity = await getActivity();
  const thresholdMs = settings.idleMinutes * 60_000;
  const { idleScanCursor = 0 } = await chrome.storage.session.get("idleScanCursor");
  const batch = rotationBatch(tabs, idleScanCursor, 50);
  await chrome.storage.session.set({ idleScanCursor: batch.cursor });
  for (const tab of batch.items) {
    const blockReason = settings.suspensionMode === SUSPENSION_MODES.SMART
      ? smartSuspensionBlockReason(tab, settings, extensionOrigin, protectionStates[tab.id])
      : suspensionBlockReason(tab, settings, extensionOrigin);
    if (!tab.id || blockReason) continue;
    if (isIdleLongEnough(activity, tab.id, thresholdMs)) await suspendTab(tab.id, "idle");
  }
}

async function createRecoveryCheckpoint() {
  const snapshot = await currentSessionSnapshot();
  if (!snapshot.tabs.length) return { ok: true, count: 0 };
  const checkpoints = await addRecoveryCheckpoint({
    ...snapshot,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  });
  return { ok: true, count: snapshot.tabs.length, checkpoints: checkpoints.length };
}

async function currentSessionSnapshot(query = {}) {
  const [tabs, records, groups] = await Promise.all([chrome.tabs.query(query), getRecords(), chrome.tabGroups?.query({}).catch(() => []) || []]);
  return buildSessionSnapshot(tabs, records, groups, extensionOrigin);
}

async function compareCheckpoint(message) {
  const checkpoints = await getRecoveryCheckpoints();
  const before = checkpoints.find((item) => item.id === message.beforeId);
  const after = message.afterId === "current" ? await currentSessionSnapshot() : checkpoints.find((item) => item.id === message.afterId);
  if (!before || !after) throw new Error("恢复点已移除，请刷新后重新选择。");
  return { ok: true, beforeId: before.id, signature: sourceState(before), ...compareSnapshots(before, after) };
}

function runResourceReview(trigger = "manual", details = {}) {
  return reviewRunner.run(trigger, details);
}

async function executeResourceReview(run, progress) {
  const trigger = run.retryTrigger || run.trigger;
  const settings = await getSettings();
  await progress({ stage: "更新资源采样" });
  await refreshResourceSnapshots(true);
  await progress({ stage: "保存恢复点" });
  const checkpoint = await createRecoveryCheckpoint();
  await progress({ checkpointTabCount: checkpoint.count, stage: "检查工作区" });
  let archivedWorkspaceCount = 0;
  if (trigger === "scheduled" && settings.scheduledArchiveEnabled) {
    const staleWorkspaces = findStaleWorkspaces(await getWorkspaces(), Date.now(), settings.scheduledArchiveDays);
    for (const workspace of staleWorkspaces) {
      await runOperation(() => updateWorkspaceOperation(workspace, { archived: true, archivedAt: Date.now(), autoArchived: true }, journal));
      archivedWorkspaceCount += 1;
      await progress({ archivedWorkspaceCount });
    }
  }
  const dashboard = await getDashboard();
  const duplicateCount = dashboard.organization.duplicates.reduce((total, group) => total + group.tabIds.length - 1, 0);
  return buildResourceReview(dashboard, checkpoint, run.trigger, run.createdAt, { duplicateCount, archivedWorkspaceCount });
}

async function restoreRecentSuspension(recordId) {
  const recent = await getRecentSuspensions();
  const record = recent.find((item) => item.recordId === recordId);
  if (!record) return { ok: false, reason: "最近休眠记录不存在" };
  const tab = await chrome.tabs.get(record.tabId).catch(() => null);
  if (tab && record.mode === "placeholder" && isExpectedSuspensionUrl(tab.url, extensionOrigin, record.recordId)) {
    await chrome.tabs.update(tab.id, { url: record.originalUrl });
  } else if (tab && tab.url === record.originalUrl && tab.discarded) {
    await chrome.tabs.reload(tab.id);
  } else {
    await chrome.tabs.create({ url: record.originalUrl, active: true });
  }
  await removeRecentSuspension(recordId);
  await removeRecord(recordId);
  return { ok: true };
}

async function restoreCheckpoint(checkpointId) {
  return restorer.all("checkpoint", checkpointId);
}

async function getDashboard() {
  await refreshResourceSnapshots();
  const [settings, records, tabs, activity, observedAt, protectionStates, resourceSnapshots] = await Promise.all([getSettings(), getRecords(), chrome.tabs.query({}), getActivity(), getObservedAt(), getProtectionStates(), getResourceSnapshots()]);
  const recordsByTab = new Map(Object.values(records).map((record) => [record.tabId, record]));
  const rows = tabs.map((tab) => {
    const record = recordsByTab.get(tab.id);
    const legacySuspended = Boolean(record && isSuspendedUrl(tab.url, extensionOrigin));
    const nativeSuspended = Boolean(tab.discarded && (record?.mode === "native-discard" || !record));
    const blockReason = record
      ? ""
      : settings.suspensionMode === SUSPENSION_MODES.SMART
        ? smartSuspensionBlockReason(tab, settings, extensionOrigin, protectionStates[tab.id])
        : suspensionBlockReason(tab, settings, extensionOrigin);
    return {
      id: tab.id,
      title: record?.title || tab.title || "Untitled tab",
      url: record?.originalUrl || tab.url || "",
      domain: domainForUrl(record?.originalUrl || tab.url || ""),
      active: Boolean(tab.active),
      incognito: Boolean(tab.incognito),
      suspended: legacySuspended || nativeSuspended,
      status: legacySuspended || nativeSuspended ? SUSPENSION_STATES.SUSPENDED : (record?.state || (blockReason ? "protected" : "live")),
      reason: record?.reason || blockReason,
      recordId: record?.recordId || "",
      suspendedAt: record?.suspendedAt || 0,
      lastActivity: activity[tab.id] || 0,
      observedAt: observedAt[tab.id] || 0,
      lastAccessed: tab.lastAccessed || activity[tab.id] || 0,
      windowId: tab.windowId,
      memory: resourceSnapshots[tab.id] || null,
      budgetEligible: !tab.incognito && !blockReason && !smartSuspensionBlockReason(tab, settings, extensionOrigin, protectionStates[tab.id])
        && isIdleLongEnough(activity, tab.id, settings.idleMinutes * 60_000)
    };
  });
  const liveTabs = tabs.filter((tab) => !isSuspendedUrl(tab.url, extensionOrigin));
  const candidates = rows
    .map((row) => buildSuspendCandidate(row, Date.now(), settings.idleMinutes))
    .filter((candidate) => candidate.eligible)
    .sort((left, right) => right.score - left.score)
    .slice(0, 12);
  const reclaimPlan = buildResourceReclaimPlan(rows, candidates);
  const { heapHistory = {} } = await chrome.storage.session.get("heapHistory");
  return {
    settings,
    tabs: rows,
    budget: buildBudget(rows, settings, heapHistory),
    organization: planLocalOrganization(liveTabs),
    summary: {
      eligible: rows.filter((row) => row.status === "live").length,
      protected: rows.filter((row) => row.status === "protected").length,
      unloaded: rows.filter((row) => row.suspended).length,
      ...summarizeHeapSnapshots(resourceSnapshots),
      jsHeapEligibleTabs: tabs.filter((tab) => isSuspendableUrl(tab.url) && !tab.discarded).length,
      reclaimableJSHeap: reclaimPlan.reclaimableJSHeap,
      reclaimableMeasuredTabs: reclaimPlan.reclaimableMeasuredTabs
    },
    candidates: reclaimPlan.candidates
  };
}

async function prepareBudgetReclaim(sender) {
  if (!sender.documentId) throw new Error("请从 TabWise 界面预览回收。");
  const dashboard = await getDashboard();
  if (!dashboard.budget.enabled) throw new Error("请先在设置中开启资源预算。");
  const pages = dashboard.budget.candidates.map((page) => ({ ...page, revision: resourceVersions.get(page.tabId) || 0 }));
  const preview = { id: crypto.randomUUID(), owner: sender.documentId, expiresAt: Date.now() + 5 * 60_000, pages };
  await queueStorage("session", async () => {
    const { budgetPreviews = [] } = await chrome.storage.session.get("budgetPreviews");
    await chrome.storage.session.set({ budgetPreviews: [preview, ...budgetPreviews.filter((item) => item.owner !== preview.owner && item.expiresAt > Date.now())].slice(0, 10) });
  });
  return { ok: true, previewId: preview.id, pages };
}
async function confirmBudgetReclaim(message, sender, wait = true) {
  const preview = await queueStorage("session", async () => {
    const { budgetPreviews = [] } = await chrome.storage.session.get("budgetPreviews");
    const item = budgetPreviews.find((item) => item.id === message.previewId && item.owner === sender.documentId && item.expiresAt > Date.now());
    if (!item) throw new Error("回收预览已过期或已执行。");
    if (!Array.isArray(message.tabIds) || !message.tabIds.length || message.tabIds.some((id) => !item.pages.some((page) => page.tabId === id))) throw new Error("请从预览中选择页面。");
    await chrome.storage.session.set({ budgetPreviews: budgetPreviews.filter((page) => page.id !== item.id) });
    return item;
  });
  const started = await batchRunner.start({ name: "资源预算回收", kind: "budget", items: preview.pages.filter((page) => message.tabIds.includes(page.tabId)).map((page) => ({ ...page, budget: true })) });
  if (!wait) return started;
  return { ...await batchRunner.wait(started.taskId), ok: true };
}

function buildPageMemory(dashboard, workspaces, checkpoints, recent, closed = []) {
  const pages = dashboard.tabs.map((tab) => ({
    id: tab.suspended && tab.recordId ? `record:${tab.recordId}` : `tab:${tab.id}`,
    title: tab.title,
    url: tab.url,
    domain: tab.domain,
    status: tab.suspended ? "suspended" : tab.status,
    source: tab.suspended ? "suspended" : "open",
    tabId: tab.id,
    recordId: tab.recordId,
    lastAccessed: tab.lastAccessed,
    windowId: tab.windowId
  }));
  for (const workspace of workspaces) {
    workspace.tabs.forEach((tab, index) => pages.push({
      id: `workspace:${workspace.id}:${index}`,
      title: tab.title || workspace.name,
      url: tab.url,
      domain: domainForUrl(tab.url),
      status: "saved",
      source: "workspace",
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      itemIndex: index,
      lastAccessed: workspace.lastOpenedAt || workspace.createdAt
    }));
  }
  for (const checkpoint of checkpoints) {
    checkpoint.tabs.forEach((tab, index) => pages.push({
      id: `checkpoint:${checkpoint.id}:${index}`,
      title: tab.title || "恢复点页面",
      url: tab.url,
      domain: domainForUrl(tab.url),
      status: "saved",
      source: "checkpoint",
      checkpointId: checkpoint.id,
      itemIndex: index,
      lastAccessed: checkpoint.createdAt
    }));
  }
  for (const record of recent) {
    pages.push({
      id: `recent:${record.recordId}`,
      title: record.title || record.originalUrl,
      url: record.originalUrl,
      domain: domainForUrl(record.originalUrl),
      status: "suspended",
      source: "recent",
      recordId: record.recordId,
      tabId: record.tabId,
      lastAccessed: record.suspendedAt
    });
  }
  for (const page of closed) pages.push({ id: `closed:${page.id}`, closedId: page.id, title: page.title, url: page.url, domain: domainForUrl(page.url), source: "closed", status: "saved", lastAccessed: page.closedAt });
  return [...new Map(pages.map((page) => [`${page.source}:${page.id}`, page])).values()];
}

async function searchPages(query, limit, options = {}) {
  const settings = await getSettings();
  if (indexedVersion !== searchVersion || Date.now() - indexedAt >= 60_000) {
    if (!indexBuild) indexBuild = (async () => {
    const version = searchVersion;
    const [tabs, workspaces, checkpoints, recent, closed] = await Promise.all([logicalTabs(), getWorkspaces(), getRecoveryCheckpoints(), getRecentSuspensions(), getClosedPages()]);
    const dashboard = { tabs: tabs.filter((tab) => !tab.incognito).map((tab) => ({
      ...tab, url: tab.logicalUrl, domain: domainForUrl(tab.logicalUrl), suspended: Boolean(tab.recordId || tab.discarded),
      status: tab.recordId || tab.discarded ? "suspended" : tab.active || tab.pinned || tab.audible ? "protected" : "open"
    })) };
    pageIndex.replace(buildPageMemory(dashboard, workspaces, checkpoints, recent, closed));
    indexedVersion = version;
    indexedAt = Date.now();
    })().finally(() => { indexBuild = null; });
    await indexBuild;
  }
  return pageIndex.search(query, limit, { ...options, semantic: settings.semanticSearch, deduplicate: options.deduplicate === true });
}

async function openSearchResult(result) {
  if (!result || typeof result !== "object") return { ok: false, reason: "搜索结果无效" };
  if (result.source === "open") {
    const tab = await chrome.tabs.get(result.tabId);
    if (result.url && tab.url !== result.url) throw new Error("标签页已导航到其他页面，请重新搜索。");
    return focusTab(result.tabId);
  }
  if (result.source === "suspended" && result.recordId) {
    const restored = await restoreRecord(result.recordId);
    if (restored.ok) await focusTab(result.tabId);
    return restored;
  }
  if (result.source === "recent" && result.recordId) return restoreRecentSuspension(result.recordId);
  if (result.source === "closed" && result.closedId) {
    const page = (await getClosedPages()).find((item) => item.id === result.closedId);
    if (!page || page.url !== result.url) throw new Error("关闭记录已过期，请刷新列表。");
    const opened = await openSavedPage(page);
    if (opened.ok) await removeClosedPage(page.id);
    return opened;
  }
  if (result.source === "suspended" && result.tabId) return restoreTab(result.tabId);
  if (result.source === "workspace" && result.workspaceId) {
    const workspace = (await getWorkspaces()).find((item) => item.id === result.workspaceId);
    if (!workspace) return { ok: false, reason: "工作区不存在" };
    const page = resolveSavedResult(result, workspace);
    const opened = await openSavedPage(page);
    if (opened.ok) await runOperation(async () => {
      if ((await getWorkspaces()).some((item) => item.id === workspace.id)) await updateWorkspace(workspace.id, { lastOpenedAt: Date.now() });
    });
    return opened;
  }
  if (result.source === "checkpoint" && result.checkpointId) {
    const checkpoint = (await getRecoveryCheckpoints()).find((item) => item.id === result.checkpointId);
    if (!checkpoint) throw new Error("恢复点不存在");
    return openSavedPage(resolveSavedResult(result, checkpoint));
  }
  return { ok: false, reason: "暂不支持打开该搜索结果" };
}

async function openSavedPage(page) {
  const existing = (await logicalTabs()).find((tab) => tab.logicalUrl === page.url);
  if (existing) {
    if (existing.recordId) {
      const result = await restoreRecord(existing.recordId);
      if (!result.ok) return result;
    } else if (existing.discarded) await chrome.tabs.reload(existing.id);
    await focusTab(existing.id);
    return { ok: true, count: 0, focused: true };
  }
  if (!isSuspendableUrl(page.url)) throw new Error("保存的地址不受支持。");
  await chrome.tabs.create({ url: page.url, active: true });
  return { ok: true, count: 1 };
}

async function getResourceDiagnostics() {
  const tabs = (await chrome.tabs.query({})).filter((tab) => tab.id && isSuspendableUrl(tab.url) && !tab.discarded);
  const hasProcessApi = Boolean(chrome.processes?.getProcessIdForTab && chrome.processes?.getProcessInfo);
  const hasProcessPermission = hasProcessApi && await chrome.permissions.contains({ permissions: ["processes"] });
  if (hasProcessPermission) {
    await runResource(() => collectPageHeapDiagnostics(tabs, true));
    const entries = await Promise.all(tabs.map(async (tab) => [tab, await chrome.processes.getProcessIdForTab(tab.id).catch(() => null)]));
    const processIdByTab = new Map(entries.filter(([, processId]) => Number.isInteger(processId)).map(([tab, processId]) => [tab.id, processId]));
    const processIds = [...new Set(processIdByTab.values())];
    if (!processIds.length) return { ok: true, mode: "renderer", measuredAt: Date.now(), renderers: [] };
    const processInfo = await chrome.processes.getProcessInfo(processIds, true);
    return {
      ok: true,
      mode: "renderer",
      measuredAt: Date.now(),
      renderers: buildRendererDiagnostics(tabs, processIdByTab, processInfo)
    };
  }

  return runResource(() => collectPageHeapDiagnostics(tabs, true));
}

async function collectPageHeapDiagnostics(tabs, persist) {
  const hostsGranted = await chrome.permissions.contains({ origins: DIAGNOSTIC_ORIGINS });
  if (!hostsGranted) return {
    ok: false,
    permissionRequest: { origins: DIAGNOSTIC_ORIGINS },
    reason: "请允许网页访问权限，以测量各网页的 JavaScript 堆内存。"
  };
  const measurements = await mapConcurrent(tabs, 4, async (tab) => {
    const version = resourceVersions.get(tab.id) || 0;
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const memory = performance.memory;
        return memory ? {
          usedJSHeapSize: memory.usedJSHeapSize,
          totalJSHeapSize: memory.totalJSHeapSize
        } : null;
      }
    }).catch(() => []);
    return { tabId: tab.id, url: tab.url, heap: version === (resourceVersions.get(tab.id) || 0) && result[0]?.result
      ? { ...result[0].result, revision: `${resourceEpoch}:${version}` } : null };
  });
  const current = await chrome.tabs.query({});
  const previous = Object.fromEntries(Object.entries(await getResourceSnapshots()).filter(([id, sample]) => {
    const version = resourceVersions.get(Number(id));
    return version === undefined || sample.revision === `${resourceEpoch}:${version}`;
  }));
  const snapshots = mergeHeapSamples(previous, current, measurements, Date.now());
  const heapByTab = new Map(tabs.filter((tab) => snapshots[tab.id]?.url === tab.url).map((tab) => [tab.id, snapshots[tab.id]]));
  const measuredAt = Date.now();
  if (persist) {
    await saveResourceSnapshots(snapshots);
    await queueStorage("session", async () => {
      const { heapHistory = {} } = await chrome.storage.session.get("heapHistory");
      await chrome.storage.session.set({ heapHistory: updateHeapHistory(heapHistory, snapshots) });
    });
  }
  return {
    ok: true,
    mode: "heap",
    measuredAt,
    renderers: buildHeapDiagnostics(tabs, heapByTab)
  };
}

function refreshResourceSnapshots(force = false) {
  return runResource(async () => {
  const settings = await getSettings();
  if (!settings.resourceSampling) return;
  const { heapScanState = {} } = await chrome.storage.session.get("heapScanState");
  if (!force && Date.now() - (heapScanState.at || 0) < ALARM_PERIOD_MINUTES * 60_000) return;
  const tabs = (await chrome.tabs.query({})).filter((tab) => tab.id && isSuspendableUrl(tab.url) && !tab.discarded);
  const batch = rotationBatch(tabs, heapScanState.cursor, 25);
  await chrome.storage.session.set({ heapScanState: { at: Date.now(), cursor: batch.cursor } });
  await collectPageHeapDiagnostics(force ? tabs : batch.items, true);
  });
}

async function enableResourceSampling() {
  const settings = await getSettings();
  await saveSettings({ ...settings, resourceSampling: true });
  return { ok: true };
}

async function fetchOllama(endpoint, path, init = {}, timeoutMs = 30_000, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint}${path}`, { ...init, signal: controller.signal, cache: "no-store", redirect: "error" });
    const body = await response.json().catch((error) => {
      if (controller.signal.aborted) throw error;
      return null;
    });
    if (response.status === 403) throw new Error(`Ollama 拒绝扩展来源（403）。请将 OLLAMA_ORIGINS 设为 ${extensionOrigin} 并重启本地服务。`);
    if (!response.ok) throw new Error(body?.error || `Ollama 返回 HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function testOllamaConnection(message = {}) {
  const settings = await getSettings();
  const endpoint = normalizeOllamaEndpoint(message.endpoint ?? settings.ollamaEndpoint);
  const model = normalizeOllamaModel(message.model ?? settings.ollamaModel);
  if (!endpoint) return { ok: false, reason: "Ollama 地址必须是本机 loopback HTTP 地址。" };
  const started = performance.now();
  const details = [];
  let stage = "连接";
  try {
    const body = await fetchOllama(endpoint, "/api/tags");
    const installed = Array.isArray(body?.models) ? [...new Set(body.models.map((item) => normalizeOllamaModel(item?.name)).filter(Boolean))] : [];
    const selectedName = installed.find((name) => name === model || name === `${model}:latest`);
    const models = installed.slice(0, 20);
    if (selectedName && !models.includes(selectedName)) models[models.length - 1] = selectedName;
    if (!message.deep) return { ok: true, models };
    stage = "模型能力";
    for (const name of models) {
      try {
        const info = await fetchOllama(endpoint, "/api/show", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name }) }, 5_000);
        details.push({ name, completion: ollamaCapability(info) });
      } catch { details.push({ name, completion: null }); }
    }
    const chosen = details.find((item) => item.name === selectedName);
    if (!chosen) throw new Error(model ? `模型 ${model} 未安装，请选择列表中的模型。` : "请选择一个已安装的模型再运行自检。");
    if (chosen.completion === false) throw new Error(`模型 ${model} 不支持文本生成，请选择支持 completion 的模型。`);
    stage = "JSON 推理";
    const response = await fetchOllama(endpoint, "/api/generate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...buildOllamaRequest('仅输出 JSON {"ok":true}。这是模型自检，不涉及网页数据。', model, OLLAMA_PROBE_SCHEMA), options: { temperature: 0, num_predict: 32 } })
    }, 90_000);
    validateOllamaProbe(response?.response);
    return { ok: true, models, details, model, endpoint, origin: extensionOrigin, latencyMs: Math.round(performance.now() - started), stage };
  } catch (error) {
    return { ok: false, details, origin: extensionOrigin, stage, latencyMs: Math.round(performance.now() - started),
      reason: error.name === "AbortError" ? `${stage}超时，请确认模型和本地服务状态。` : error.message === "Failed to fetch" ? "无法连接 Ollama，请确认服务正在运行。" : error.message };
  }
}

async function beginAiGeneration(id, sender) {
  return runAi(async () => {
    const { snapshot, snapshots } = await aiSnapshotForSender(id, sender);
    if (snapshot.plan || snapshot.generation) throw new Error("此输入已生成、取消或正在处理，请重新预览。");
    validateAiMembers(snapshot, snapshot.pages.map((page) => page.pageId), await chrome.tabs.query({}), await getWorkspaces(), "save");
    const data = await chrome.storage.session.get(AI_CACHE_KEY);
    const plan = await cachedAiPlan(data[AI_CACHE_KEY] || [], snapshot);
    if (plan) {
      snapshot.plan = validateAiPlan(plan, snapshot);
      snapshot.generation = "done";
    } else snapshot.generation = "running";
    await chrome.storage.session.set({ [AI_SNAPSHOTS_KEY]: snapshots });
    return { ok: true, plan: snapshot.plan, cached: Boolean(plan) };
  });
}

async function cancelAiGeneration(id, sender, onlyRunning = false) {
  const running = aiControllers.get(id);
  if (running?.owner === sender.documentId) running.controller.abort();
  return runAi(async () => {
    const { snapshot, snapshots } = await aiSnapshotForSender(id, sender);
    if (onlyRunning && snapshot.generation !== "running") return { ok: true };
    snapshot.generation = "cancelled";
    await chrome.storage.session.set({ [AI_SNAPSHOTS_KEY]: snapshots });
    return { ok: true };
  });
}

async function generateAiThemes(id, sender) {
  const started = await beginAiGeneration(id, sender);
  if (started.cached) return started;
  const controller = new AbortController();
  aiControllers.set(id, { controller, owner: sender.documentId });
  try {
    const { snapshot } = await runAi(() => aiSnapshotForSender(id, sender));
    if (snapshot.provider !== "ollama") throw new Error("本次预览选择的是浏览器内置模型。");
    if (!snapshot.endpoint || !snapshot.model) throw new Error("请在设置中填写本地 Ollama 地址和模型名。");
    if (snapshot.generation === "cancelled") controller.abort();
    const body = await fetchOllama(snapshot.endpoint, "/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildOllamaRequest(buildAiThemePrompt(snapshot, snapshot.request), snapshot.model, AI_PLAN_SCHEMA))
    }, 90_000, controller.signal);
    if (controller.signal.aborted) throw new Error("生成已取消，请重新预览。");
    return await acceptAiPlan(id, String(body?.response || ""), sender);
  } catch (error) {
    return { ok: false, reason: controller.signal.aborted ? "生成已取消，请重新预览。" : error.name === "AbortError" ? "Ollama 生成超时，请重新预览后重试。" : error.message };
  } finally {
    if (aiControllers.get(id)?.controller === controller) aiControllers.delete(id);
  }
}

async function getSuspendedRecordForSender(recordId, sender) {
  const record = await getRecord(recordId);
  const expected = `${chrome.runtime.getURL(SUSPENDED_PAGE)}#${recordId}`;
  if (!record || !sender.tab || sender.tab.id !== record.tabId || sender.tab.url !== expected) return null;
  return record;
}

async function suspendEligibleTabsInCurrentWindow() {
  const task = await startBatchSuspend();
  return { ...await batchRunner.wait(task.taskId), ok: true };
}

async function pauseAutomation(minutes) {
  const pauseUntil = minutes ? Date.now() + minutes * 60_000 : 0;
  await changeSettings((settings) => ({ ...settings, pauseUntil }));
  return { ok: true, pauseUntil };
}

async function trustDomain(url) {
  const domain = domainForUrl(url);
  if (!domain) return { ok: false, reason: "Only websites can be trusted" };
  await changeSettings((settings) => ({ ...settings,
    trustedDomains: [...new Set([...settings.trustedDomains, normalizeDomain(domain)])],
    blockedDomains: settings.blockedDomains.filter((entry) => normalizeDomain(entry) !== normalizeDomain(domain))
  }));
  return { ok: true, domain };
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    return { ok: true };
  } catch {
    return { ok: false, reason: "标签页已关闭或不可用" };
  }
}

async function restoreTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.discarded) await chrome.tabs.reload(tabId);
    return { ok: true };
  } catch {
    return { ok: false, reason: "标签页已关闭或不可用" };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  await ensureCheckpointAlarm();
  await scheduleResourceReview();
  await recordExistingTabs();
  await refreshResourceSnapshots();
  await chrome.omnibox.setDefaultSuggestion({ description: "搜索 TabWise 本地页面记忆" });
  if ((await getSettings()).suspensionMode === SUSPENSION_MODES.SMART) {
    await registerProtectionScript();
    await initializeExistingProtection();
  }
});
chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await ensureCheckpointAlarm();
  await scheduleResourceReview();
  await rebindSuspendedTabs();
  await refreshResourceSnapshots();
  if ((await getSettings()).suspensionMode === SUSPENSION_MODES.SMART) {
    await registerProtectionScript();
    await initializeExistingProtection();
  }
});
chrome.commands.onCommand.addListener((command) => {
  if (command === "open-tabwise") {
    chrome.windows.getLastFocused().then((window) => chrome.sidePanel.open({ windowId: window.id })).catch(console.error);
  }
  if (command === "save-workspace") {
    currentSessionSnapshot({ currentWindow: true }).then(async (snapshot) => {
      await runOperation(() => saveWorkspaceOperation({
        ...snapshot,
        id: crypto.randomUUID(),
        name: `Workspace ${new Date().toLocaleDateString()}`,
        createdAt: Date.now(),
      }, journal));
    }).catch(console.error);
  }
});
chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  searchPages(text, 6)
    .then((results) => suggest(results.map((result) => ({
      content: JSON.stringify({ id: result.id, source: result.source, url: result.url, tabId: result.tabId, recordId: result.recordId, workspaceId: result.workspaceId, checkpointId: result.checkpointId, closedId: result.closedId }),
      description: `<match>${escapeOmniboxText(result.title)}</match> <dim>${escapeOmniboxText(result.domain || result.source)}</dim>`
    }))))
    .catch(() => suggest([]));
});
chrome.omnibox.onInputEntered.addListener((text) => {
  try {
    const result = JSON.parse(text);
    openSearchResult(result).catch(console.error);
  } catch {
    searchPages(text, 1).then((results) => results[0] && openSearchResult(results[0])).catch(console.error);
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    (async () => {
      await processIdleTabs();
      await refreshResourceSnapshots();
      await scheduleResourceReview();
    })().catch(console.error);
  }
  if (alarm.name === CHECKPOINT_ALARM_NAME) createRecoveryCheckpoint().catch(console.error);
  if (alarm.name === RESOURCE_REVIEW_ALARM_NAME) scheduleResourceReview().catch(console.error);
});
chrome.tabs.onActivated.addListener(({ tabId }) => { touchTab(tabId); stateChanged(); });
chrome.tabs.onCreated?.addListener((tab) => { pageTracker.remember(tab).catch(console.error); stateChanged(); });
chrome.tabs.onMoved?.addListener(() => stateChanged());
chrome.tabs.onAttached?.addListener(() => stateChanged());
chrome.tabGroups?.onUpdated?.addListener(() => stateChanged());
chrome.tabGroups?.onCreated?.addListener(() => stateChanged());
chrome.tabGroups?.onRemoved?.addListener(() => stateChanged());
chrome.tabs.onDetached.addListener((tabId) => { invalidateAiTab(tabId); stateChanged(); });
chrome.tabs.onRemoved.addListener(async (tabId) => {
  resourceVersions.set(tabId, (resourceVersions.get(tabId) || 0) + 1);
  invalidateAiTab(tabId);
  await pageTracker.close(tabId);
  await Promise.all([removeActivity(tabId), removeRecordsForTab(tabId), removeProtectionState(tabId)]);
  stateChanged();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab) pageTracker.remember(tab).catch(console.error);
  stateChanged(Boolean(changeInfo.url || changeInfo.title !== undefined || changeInfo.discarded !== undefined || changeInfo.pinned !== undefined));
  if (changeInfo.url || changeInfo.title !== undefined || changeInfo.status === "loading") invalidateAiTab(tabId);
  if (changeInfo.url || changeInfo.discarded !== undefined || changeInfo.status === "loading") {
    resourceVersions.set(tabId, (resourceVersions.get(tabId) || 0) + 1);
    Promise.all([removeProtectionState(tabId), runResource(() => removeResourceSnapshot(tabId))]).catch(console.error);
  }
  if (changeInfo.status !== "complete") return;
  (async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    const records = await getRecords();
    const record = Object.values(records).find((item) => item.tabId === tabId);
    if (record && isExpectedSuspensionUrl(tab.url, extensionOrigin, record.recordId)) return;
    if (isSuspendedUrl(tab.url, extensionOrigin)) return;
    if (record) {
      if (record.state === SUSPENSION_STATES.RESTORING) await removeRecord(record.recordId);
      else await removePrimaryRecord(record.recordId);
      if (record.mode === "native-discard") await removeRecentSuspension(record.recordId);
    }
    await touchTab(tabId);
  })().catch(console.error);
});

chrome.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  if (port.name === "tabwise-live" && sender?.id === chrome.runtime.id
    && [chrome.runtime.getURL("src/sidepanel/sidepanel.html"), chrome.runtime.getURL("src/popup/popup.html")].includes(sender.url)) {
    livePorts.add(port);
    port.onDisconnect.addListener(() => livePorts.delete(port));
    pageTracker.initialize().catch(console.error);
    return;
  }
  if (port.name !== "tabwise-ai" || sender?.id !== chrome.runtime.id
    || sender.url !== chrome.runtime.getURL("src/sidepanel/sidepanel.html") || !sender.documentId) return;
  let snapshotId;
  port.onMessage.addListener((message) => { if (typeof message.snapshotId === "string") snapshotId = message.snapshotId; });
  port.onDisconnect.addListener(() => {
    if (snapshotId) cancelAiGeneration(snapshotId, sender, true).catch(() => {});
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const aiTasks = {
    prepareAiAnalysis: () => prepareAiAnalysis(message, sender),
    beginAiGeneration: () => beginAiGeneration(message.snapshotId, sender),
    cancelAiGeneration: () => cancelAiGeneration(message.snapshotId, sender),
    clearAiCache: () => runAi(async () => { await chrome.storage.session.remove(AI_CACHE_KEY); return { ok: true }; }),
    generateAiThemes: () => generateAiThemes(message.snapshotId, sender),
    acceptAiPlan: () => acceptAiPlan(message.snapshotId, message.answer, sender),
    applyAiGroup: () => applyAiGroup(message, sender)
  };
  if (Object.hasOwn(aiTasks, message.type)) {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("src/sidepanel/sidepanel.html") || !sender.documentId) {
      sendResponse({ ok: false, reason: "AI 整理仅可从 TabWise 侧栏操作。" });
      return false;
    }
    aiTasks[message.type]().then(sendResponse).catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }
  const tasks = {
    getDashboard,
    prepareBudgetReclaim: () => prepareBudgetReclaim(sender),
    confirmBudgetReclaim: () => confirmBudgetReclaim(message, sender),
    startBudgetReclaim: () => confirmBudgetReclaim(message, sender, false),
    startBatchSuspend: () => startBatchSuspend(sender),
    prepareBatch: () => prepareBatch(message, sender),
    startBatchPreview: () => startBatchPreview(message, sender),
    startBatchGroup: () => startBatchGroup(message),
    getTasks: async () => [...(await batchRunner.list()).map(publicTask), ...(await restorer.list()).map((task) => ({ ...task, kind: "restore" }))].sort((a, b) => b.createdAt - a.createdAt),
    getTask: () => taskDetail(message),
    stopTask: async () => (await batchRunner.list()).some((task) => task.id === message.taskId) ? batchRunner.stop(message.taskId) : restorer.stop(message.taskId),
    retryTask: async () => (await batchRunner.list()).some((task) => task.id === message.taskId) ? batchRunner.retry(message.taskId) : restorer.retry(message.taskId),
    getResourceDiagnostics,
    getOperations: async () => (await getOperations()).map(({ id, label, createdAt, status, results, items }) => ({ id, label, createdAt, status, results, count: items.length })),
    undoOperation: () => runOperation(() => journal.undo(message.operationId)),
    enableResourceSampling,
    testOllamaConnection: () => testOllamaConnection(message),
    searchPages: () => searchPages(message.query, message.limit, message.filters || {
      source: message.source, status: message.status, workspaceId: message.workspaceId, windowId: message.windowId, deduplicate: message.deduplicate
    }),
    openSearchResult: () => openSearchResult(message.result),
    getSuspendedRecord: () => getSuspendedRecordForSender(message.recordId, sender),
    suspendTab: () => suspendTab(message.tabId),
    directSuspendTab: () => suspendTab(message.tabId, "direct", true),
    restoreRecord: () => restoreRecord(message.recordId, sender.tab?.id),
    updateSettings: async () => {
      const next = await changeSettings((current) => sanitizeSettings(current, message.settings || {}));
      if (!next.closedHistoryEnabled) await removeClosedPage();
      await scheduleResourceReview();
      return next;
    },
    setSuspensionMode: () => setSuspensionMode(message.mode),
    pauseAutomation: () => pauseAutomation(message.minutes),
    trustDomain: () => trustDomain(message.url),
    focusTab: () => focusTab(message.tabId),
    restoreTab: () => restoreTab(message.tabId),
    suspendEligibleTabs: suspendEligibleTabsInCurrentWindow,
    saveWorkspace: () => runOperation(async () => {
      const snapshot = await currentSessionSnapshot({ currentWindow: true });
      const workspace = {
        ...snapshot,
        id: crypto.randomUUID(),
        name: message.name?.trim().slice(0, 80) || `Workspace ${new Date().toLocaleDateString()}`,
        createdAt: Date.now(),
        archived: false,
      };
      await saveWorkspaceOperation(workspace, journal);
      return workspace;
    }),
    getWorkspaces,
    getRecentSuspensions,
    getRecoveryCheckpoints,
    getClosedPages: async () => { await pageTracker.initialize(); return getClosedPages(); },
    clearClosedPages: async () => { await removeClosedPage(); return { ok: true }; },
    compareCheckpoint: () => compareCheckpoint(message),
    getResourceReviews: async () => { await reviewRunner.ready; return getResourceReviews(); },
    retryResourceReview: () => runResourceReview("retry", { retryOf: message.reviewId }),
    createRecoveryCheckpoint,
    runResourceReview: () => runResourceReview("manual"),
    restoreRecentSuspension: () => restoreRecentSuspension(message.recordId),
    restoreCheckpoint: () => restoreCheckpoint(message.checkpointId),
    exportBackup: () => backups.export(),
    prepareBackupImport: () => backups.prepare(message.backup, sender),
    confirmBackupImport: async () => {
      const result = await runOperation(() => backups.confirm(message, sender));
      if (message.includeSettings) await scheduleResourceReview();
      return result;
    },
    importBackup: async () => {
      const result = await runOperation(() => backups.import(message.backup));
      if (result.ok) await scheduleResourceReview();
      return result;
    },
    openWorkspace: () => restorer.all("workspace", message.workspaceId),
    prepareRestore: () => restorer.prepare(message.kind, message.sourceId, sender, message.signature),
    confirmRestore: () => restorer.confirm(message, sender),
    startRestore: () => restorer.start(message, sender),
    getRestoreTasks: () => restorer.list(),
    getRestoreTask: () => restorer.detail(message.taskId, message.offset),
    stopRestoreTask: () => restorer.stop(message.taskId),
    retryRestoreTask: () => restorer.retry(message.taskId),
    getWorkspaceTrash,
    bindWorkspace: () => runOperation(() => workspaceUpdates.bind(message.workspaceId, sender)),
    getWorkspaceBindings: () => workspaceUpdates.bindings(),
    getWorkspaceVersions: () => workspaceUpdates.versions(message.workspaceId),
    prepareWorkspaceUpdate: () => runOperation(() => workspaceUpdates.prepare(message, sender)),
    confirmWorkspaceUpdate: () => runOperation(() => workspaceUpdates.confirm(message.previewId, sender)),
    editWorkspace: () => runOperation(async () => {
      const workspace = (await getWorkspaces()).find((item) => item.id === message.workspaceId);
      if (!workspace || sourceState(workspace) !== message.signature) throw new Error("工作区已变化，请重新编辑。");
      const update = editWorkspace(workspace, message.name, message.indices);
      await updateWorkspaceOperation(workspace, update, journal);
      return { ok: true };
    }),
    mergeWorkspaces: () => runOperation(async () => {
      const workspaces = await getWorkspaces();
      const ids = [...new Set(message.workspaceIds || [])];
      const selected = ids.map((id) => workspaces.find((item) => item.id === id));
      if (selected.some((item) => !item || sourceState(item) !== message.signatures?.[item.id])) throw new Error("所选工作区已变化，请刷新后重试。");
      const workspace = await saveWorkspaceOperation(mergeWorkspaces(selected, message.name), journal);
      return { ok: true, workspace };
    }),
    trashWorkspace: () => runOperation(async () => {
      const workspace = (await getWorkspaces()).find((item) => item.id === message.workspaceId);
      if (!workspace) throw new Error("工作区不存在。");
      await updateWorkspaceOperation(workspace, { deletedAt: Date.now() }, journal);
      return { ok: true };
    }),
    restoreWorkspaceTrash: () => runOperation(async () => {
      const workspace = (await getWorkspaceTrash()).find((item) => item.id === message.workspaceId);
      if (!workspace) throw new Error("工作区不在回收站中。");
      await updateWorkspaceOperation(workspace, { deletedAt: 0 }, journal);
      return { ok: true };
    }),
    deleteWorkspacePermanently: () => runOperation(async () => {
      const workspaces = await getAllWorkspaces();
      const workspace = workspaces.find((item) => item.id === message.workspaceId && item.deletedAt);
      if (!workspace || sourceState(workspace) !== message.signature || message.confirm !== true) throw new Error("请在回收站确认要永久删除的工作区。");
      await changeWorkspaces((items) => items.filter((item) => item.id !== workspace.id));
      return { ok: true };
    }),
    toggleWorkspacePinned: () => runOperation(async () => {
      const workspaces = await getWorkspaces();
      const workspace = workspaces.find((item) => item.id === message.workspaceId);
      if (!workspace) throw new Error("工作区不存在");
      const updated = await updateWorkspaceOperation(workspace, { pinned: !workspace.pinned }, journal);
      return { ok: true, pinned: updated.pinned };
    }),
    toggleWorkspaceArchived: () => runOperation(async () => {
      const workspaces = await getWorkspaces();
      const workspace = workspaces.find((item) => item.id === message.workspaceId);
      if (!workspace) throw new Error("工作区不存在");
      const archived = !workspace.archived;
      const updated = await updateWorkspaceOperation(workspace, { archived, archivedAt: archived ? Date.now() : 0 }, journal);
      return { ok: true, archived: updated.archived };
    }),
    groupTabs: async () => {
      const task = await startBatchGroup(message);
      return { ...await batchRunner.wait(task.taskId), ok: true };
    }
  };

  if (message.type === "pageProtection") {
    if (!sender.tab || !message.state || sender.tab.url !== message.state.url) return false;
    setProtectionState(sender.tab.id, {
      ready: Boolean(message.state.ready),
      dirty: Boolean(message.state.dirty),
      upload: Boolean(message.state.upload),
      media: Boolean(message.state.media)
    }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  const task = tasks[message.type];
  if (!task) return false;
  task().then(sendResponse).catch((error) => sendResponse({ ok: false, reason: error.message }));
  return true;
});
