import { ALARM_NAME, ALARM_PERIOD_MINUTES, CHECKPOINT_ALARM_NAME, CHECKPOINT_PERIOD_MINUTES, SUSPENDED_PAGE, SUSPENSION_MODES, SUSPENSION_STATES, SUSPENSION_STRATEGIES } from "../shared/constants.js";
import { directSuspensionBlockReason, domainForUrl, isExpectedSuspensionUrl, isIdleLongEnough, isSuspendableUrl, isSuspendedUrl, normalizeDomain, planLocalOrganization, smartSuspensionBlockReason, suspensionBlockReason } from "../shared/policy.js";
import { addRecentSuspension, addRecoveryCheckpoint, addWorkspace, getActivity, getObservedAt, getRecentSuspensions, getRecord, getRecords, getRecoveryCheckpoints, getSettings, getWorkspaces, putRecord, removeActivity, removePrimaryRecord, removeRecentSuspension, removeRecord, removeRecordsForTab, saveSettings, touchTab, updateWorkspace } from "../shared/storage.js";
import { buildSuspendCandidate, searchPageMemory } from "../shared/search.js";
import { buildRendererDiagnostics } from "../shared/resource.js";

const extensionOrigin = chrome.runtime.getURL("").replace(/\/$/, "");
const tabQueues = new Map();
const PAGE_PROTECTION_KEY = "pageProtectionStates";
const PAGE_PROTECTION_SCRIPT_ID = "tabwise-page-protection";
const SMART_ORIGINS = ["http://*/*", "https://*/*"];

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
  await Promise.all(tabs
    .filter((tab) => tab.id && isSuspendableUrl(tab.url))
    .map((tab) => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content/protection.js"] }).catch(() => {})));
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

async function suspendTab(tabId, reason = "manual", allowProtected = false) {
  return runForTab(tabId, async () => {
    let recordId;
    try {
      const [settings, tab] = await Promise.all([getSettings(), chrome.tabs.get(tabId)]);
      const blockReason = allowProtected
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
      if (freshTab.url !== tab.url || freshTab.active) {
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
      const suspendedRecord = { ...record, mode, state: SUSPENSION_STATES.SUSPENDED };
      await putRecord(suspendedRecord);
      await addRecentSuspension(suspendedRecord);
      return { ok: true, recordId };
    } catch (error) {
      if (recordId) await removeRecord(recordId);
      return { ok: false, reason: error.message || "休眠操作失败" };
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
    await removeRecord(recordId);
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
  for (const tab of tabs.slice(0, 50)) {
    const blockReason = settings.suspensionMode === SUSPENSION_MODES.SMART
      ? smartSuspensionBlockReason(tab, settings, extensionOrigin, protectionStates[tab.id])
      : suspensionBlockReason(tab, settings, extensionOrigin);
    if (!tab.id || blockReason) continue;
    if (isIdleLongEnough(activity, tab.id, thresholdMs)) await suspendTab(tab.id, "idle");
  }
}

async function createRecoveryCheckpoint() {
  const tabs = await chrome.tabs.query({});
  const checkpointTabs = tabs
    .filter((tab) => isSuspendableUrl(tab.url))
    .map((tab) => ({ title: tab.title || domainForUrl(tab.url), url: tab.url }));
  if (!checkpointTabs.length) return { ok: true, count: 0 };
  const checkpoints = await addRecoveryCheckpoint({
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    tabs: checkpointTabs
  });
  return { ok: true, count: checkpointTabs.length, checkpoints: checkpoints.length };
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
  const checkpoints = await getRecoveryCheckpoints();
  const checkpoint = checkpoints.find((item) => item.id === checkpointId);
  if (!checkpoint) return { ok: false, reason: "恢复点不存在" };
  for (const item of checkpoint.tabs) await chrome.tabs.create({ url: item.url, active: false });
  return { ok: true, count: checkpoint.tabs.length };
}

async function getDashboard() {
  const [settings, records, tabs, activity, observedAt, protectionStates] = await Promise.all([getSettings(), getRecords(), chrome.tabs.query({}), getActivity(), getObservedAt(), getProtectionStates()]);
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
      suspended: legacySuspended || nativeSuspended,
      status: legacySuspended || nativeSuspended ? SUSPENSION_STATES.SUSPENDED : (record?.state || (blockReason ? "protected" : "live")),
      reason: record?.reason || blockReason,
      recordId: record?.recordId || "",
      suspendedAt: record?.suspendedAt || 0,
      lastActivity: activity[tab.id] || 0,
      observedAt: observedAt[tab.id] || 0,
      lastAccessed: tab.lastAccessed || activity[tab.id] || 0,
      windowId: tab.windowId
    };
  });
  const liveTabs = tabs.filter((tab) => !isSuspendedUrl(tab.url, extensionOrigin));
  const candidates = rows
    .map((row) => buildSuspendCandidate(row, Date.now(), settings.idleMinutes))
    .filter((candidate) => candidate.eligible)
    .sort((left, right) => right.score - left.score)
    .slice(0, 12);
  return {
    settings,
    tabs: rows,
    organization: planLocalOrganization(liveTabs),
    summary: {
      eligible: rows.filter((row) => row.status === "live").length,
      protected: rows.filter((row) => row.status === "protected").length,
      unloaded: rows.filter((row) => row.suspended).length
    },
    candidates
  };
}

function buildPageMemory(dashboard, workspaces, checkpoints, recent) {
  const pages = dashboard.tabs.map((tab) => ({
    id: tab.suspended && tab.recordId ? `record:${tab.recordId}` : `tab:${tab.id}`,
    title: tab.title,
    url: tab.url,
    domain: tab.domain,
    status: tab.suspended ? "suspended" : tab.status,
    source: tab.suspended ? "suspended" : "open",
    tabId: tab.id,
    recordId: tab.recordId,
    lastAccessed: tab.lastAccessed
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
      lastAccessed: workspace.createdAt
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
  return [...new Map(pages.map((page) => [`${page.source}:${page.id}`, page])).values()];
}

async function searchPages(query, limit) {
  const [dashboard, workspaces, checkpoints, recent, settings] = await Promise.all([
    getDashboard(),
    getWorkspaces(),
    getRecoveryCheckpoints(),
    getRecentSuspensions(),
    getSettings()
  ]);
  return searchPageMemory(buildPageMemory(dashboard, workspaces, checkpoints, recent), query, limit, { semantic: settings.semanticSearch });
}

async function openSearchResult(result) {
  if (!result || typeof result !== "object") return { ok: false, reason: "搜索结果无效" };
  if (result.source === "open") return focusTab(result.tabId);
  if (result.source === "suspended" && result.recordId) {
    const restored = await restoreRecord(result.recordId);
    if (restored.ok) await focusTab(result.tabId);
    return restored;
  }
  if (result.source === "recent" && result.recordId) return restoreRecentSuspension(result.recordId);
  if (result.source === "workspace" && result.workspaceId) {
    const workspace = (await getWorkspaces()).find((item) => item.id === result.workspaceId);
    if (!workspace) return { ok: false, reason: "工作区不存在" };
    for (const item of workspace.tabs) await chrome.tabs.create({ url: item.url, active: false });
    return { ok: true, count: workspace.tabs.length };
  }
  if (result.source === "checkpoint" && result.checkpointId) return restoreCheckpoint(result.checkpointId);
  return { ok: false, reason: "暂不支持打开该搜索结果" };
}

async function getResourceDiagnostics() {
  if (!chrome.processes?.getProcessIdForTab || !chrome.processes?.getProcessInfo) {
    return { ok: false, supported: false, reason: "资源诊断仅支持 Chrome Dev 或 Canary。" };
  }
  const granted = await chrome.permissions.contains({ permissions: ["processes"] });
  if (!granted) return { ok: false, supported: true, permissionRequired: true };

  const tabs = (await chrome.tabs.query({})).filter((tab) => tab.id && isSuspendableUrl(tab.url) && !tab.discarded);
  const entries = await Promise.all(tabs.map(async (tab) => [tab, await chrome.processes.getProcessIdForTab(tab.id).catch(() => null)]));
  const processIdByTab = new Map(entries.filter(([, processId]) => Number.isInteger(processId)).map(([tab, processId]) => [tab.id, processId]));
  const processIds = [...new Set(processIdByTab.values())];
  if (!processIds.length) return { ok: true, measuredAt: Date.now(), renderers: [] };
  const processInfo = await chrome.processes.getProcessInfo(processIds, true);
  return {
    ok: true,
    measuredAt: Date.now(),
    renderers: buildRendererDiagnostics(tabs, processIdByTab, processInfo)
  };
}

async function getSuspendedRecordForSender(recordId, sender) {
  const record = await getRecord(recordId);
  const expected = `${chrome.runtime.getURL(SUSPENDED_PAGE)}#${recordId}`;
  if (!record || !sender.tab || sender.tab.id !== record.tabId || sender.tab.url !== expected) return null;
  return record;
}

async function suspendEligibleTabsInCurrentWindow() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const results = await Promise.all(tabs.map((tab) => tab.id ? suspendTab(tab.id, "batch") : null));
  return { ok: true, count: results.filter((result) => result?.ok).length };
}

async function pauseAutomation(minutes) {
  const settings = await getSettings();
  const pauseUntil = minutes ? Date.now() + minutes * 60_000 : 0;
  await saveSettings({ ...settings, pauseUntil });
  return { ok: true, pauseUntil };
}

async function trustDomain(url) {
  const domain = domainForUrl(url);
  if (!domain) return { ok: false, reason: "Only websites can be trusted" };
  const settings = await getSettings();
  const trustedDomains = [...new Set([...settings.trustedDomains, normalizeDomain(domain)])];
  const blockedDomains = settings.blockedDomains.filter((entry) => normalizeDomain(entry) !== normalizeDomain(domain));
  await saveSettings({ ...settings, trustedDomains, blockedDomains });
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

function backupWorkspace(workspace) {
  const tabs = Array.isArray(workspace?.tabs) ? workspace.tabs
    .filter((tab) => isSuspendableUrl(tab.url))
    .slice(0, 200)
    .map((tab) => ({ title: String(tab.title || "").slice(0, 300), url: tab.url })) : [];
  return {
    id: crypto.randomUUID(),
    name: String(workspace?.name || "导入的工作区").trim().slice(0, 80) || "导入的工作区",
    createdAt: Number.isFinite(workspace?.createdAt) ? workspace.createdAt : Date.now(),
    pinned: Boolean(workspace?.pinned),
    tabs
  };
}

async function importBackup(backup) {
  if (!backup || backup.schemaVersion !== 1 || !Array.isArray(backup.workspaces)) {
    return { ok: false, reason: "备份文件格式不受支持" };
  }
  const workspaces = backup.workspaces.slice(0, 20).map(backupWorkspace).filter((workspace) => workspace.tabs.length);
  if (backup.settings && typeof backup.settings === "object") {
    await saveSettings(sanitizeSettings(await getSettings(), backup.settings));
  }
  for (const workspace of workspaces.reverse()) await addWorkspace(workspace);
  return { ok: true, count: workspaces.length };
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  await ensureCheckpointAlarm();
  await recordExistingTabs();
  await chrome.omnibox.setDefaultSuggestion({ description: "搜索 TabWise 本地页面记忆" });
  if ((await getSettings()).suspensionMode === SUSPENSION_MODES.SMART) {
    await registerProtectionScript();
    await initializeExistingProtection();
  }
});
chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await ensureCheckpointAlarm();
  await rebindSuspendedTabs();
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
    chrome.tabs.query({ currentWindow: true }).then(async (tabs) => {
      await addWorkspace({
        id: crypto.randomUUID(),
        name: `Workspace ${new Date().toLocaleDateString()}`,
        createdAt: Date.now(),
        tabs: tabs.filter((tab) => isSuspendableUrl(tab.url)).map((tab) => ({ title: tab.title || "", url: tab.url }))
      });
    }).catch(console.error);
  }
});
chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  searchPages(text, 6)
    .then((results) => suggest(results.map((result) => ({
      content: JSON.stringify({ id: result.id, source: result.source, tabId: result.tabId, recordId: result.recordId, workspaceId: result.workspaceId, checkpointId: result.checkpointId }),
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
  if (alarm.name === ALARM_NAME) processIdleTabs().catch(console.error);
  if (alarm.name === CHECKPOINT_ALARM_NAME) createRecoveryCheckpoint().catch(console.error);
});
chrome.tabs.onActivated.addListener(({ tabId }) => touchTab(tabId));
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await Promise.all([removeActivity(tabId), removeRecordsForTab(tabId), removeProtectionState(tabId)]);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) removeProtectionState(tabId).catch(console.error);
  if (changeInfo.status !== "complete") return;
  (async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    const records = await getRecords();
    const record = Object.values(records).find((item) => item.tabId === tabId);
    if (record && isExpectedSuspensionUrl(tab.url, extensionOrigin, record.recordId)) return;
    if (isSuspendedUrl(tab.url, extensionOrigin)) return;
    if (record) {
      await removePrimaryRecord(record.recordId);
      if (record.mode === "native-discard") await removeRecentSuspension(record.recordId);
    }
    await touchTab(tabId);
  })().catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tasks = {
    getDashboard,
    getResourceDiagnostics,
    searchPages: () => searchPages(message.query, message.limit),
    openSearchResult: () => openSearchResult(message.result),
    getSuspendedRecord: () => getSuspendedRecordForSender(message.recordId, sender),
    suspendTab: () => suspendTab(message.tabId),
    directSuspendTab: () => suspendTab(message.tabId, "direct", true),
    restoreRecord: () => restoreRecord(message.recordId, sender.tab?.id),
    updateSettings: async () => {
      const current = await getSettings();
      const next = sanitizeSettings(current, message.settings || {});
      await saveSettings(next);
      return next;
    },
    setSuspensionMode: () => setSuspensionMode(message.mode),
    pauseAutomation: () => pauseAutomation(message.minutes),
    trustDomain: () => trustDomain(message.url),
    focusTab: () => focusTab(message.tabId),
    restoreTab: () => restoreTab(message.tabId),
    suspendEligibleTabs: suspendEligibleTabsInCurrentWindow,
    saveWorkspace: async () => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const workspace = {
        id: crypto.randomUUID(),
        name: message.name?.trim().slice(0, 80) || `Workspace ${new Date().toLocaleDateString()}`,
        createdAt: Date.now(),
        tabs: tabs.filter((tab) => /^https?:/.test(tab.url || "")).map((tab) => ({ title: tab.title || "", url: tab.url }))
      };
      await addWorkspace(workspace);
      return workspace;
    },
    getWorkspaces,
    getRecentSuspensions,
    getRecoveryCheckpoints,
    createRecoveryCheckpoint,
    restoreRecentSuspension: () => restoreRecentSuspension(message.recordId),
    restoreCheckpoint: () => restoreCheckpoint(message.checkpointId),
    exportBackup: async () => ({
      schemaVersion: 1,
      exportedAt: Date.now(),
      settings: await getSettings(),
      workspaces: await getWorkspaces()
    }),
    importBackup: () => importBackup(message.backup),
    openWorkspace: async () => {
      const workspaces = await getWorkspaces();
      const workspace = workspaces.find((item) => item.id === message.workspaceId);
      if (!workspace) throw new Error("Workspace was not found");
      for (const item of workspace.tabs) await chrome.tabs.create({ url: item.url, active: false });
      return { ok: true, count: workspace.tabs.length };
    },
    toggleWorkspacePinned: async () => {
      const workspaces = await getWorkspaces();
      const workspace = workspaces.find((item) => item.id === message.workspaceId);
      if (!workspace) throw new Error("工作区不存在");
      const updated = await updateWorkspace(workspace.id, { pinned: !workspace.pinned });
      return { ok: true, pinned: updated.pinned };
    },
    groupTabs: async () => {
      const requestedIds = [...new Set(message.tabIds || [])].filter(Number.isInteger);
      const tabs = await Promise.all(requestedIds.map((tabId) => chrome.tabs.get(tabId).catch(() => null)));
      const byWindow = new Map();
      for (const tab of tabs.filter((tab) => tab && /^https?:/.test(tab.url || ""))) {
        if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
        byWindow.get(tab.windowId).push(tab.id);
      }
      let grouped = 0;
      for (const [windowId, tabIds] of byWindow) {
        if (tabIds.length < 2) continue;
        const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
        await chrome.tabGroups.update(groupId, { title: message.title?.slice(0, 80) || "Related tabs", color: "green" });
        grouped += tabIds.length;
      }
      return grouped ? { ok: true, count: grouped } : { ok: false, reason: "At least two eligible tabs in one window are required" };
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
