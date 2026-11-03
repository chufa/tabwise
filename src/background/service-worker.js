import { ALARM_NAME, ALARM_PERIOD_MINUTES, CHECKPOINT_ALARM_NAME, CHECKPOINT_PERIOD_MINUTES, SUSPENDED_PAGE, SUSPENSION_MODES, SUSPENSION_STATES } from "../shared/constants.js";
import { directSuspensionBlockReason, domainForUrl, isExpectedSuspensionUrl, isSuspendableUrl, isSuspendedUrl, normalizeDomain, planLocalOrganization, smartSuspensionBlockReason, suspensionBlockReason } from "../shared/policy.js";
import { addRecentSuspension, addRecoveryCheckpoint, addWorkspace, getActivity, getObservedAt, getRecentSuspensions, getRecord, getRecords, getRecoveryCheckpoints, getSettings, getWorkspaces, putRecord, removeActivity, removePrimaryRecord, removeRecentSuspension, removeRecord, removeRecordsForTab, saveSettings, touchTab, updateWorkspace } from "../shared/storage.js";

const extensionOrigin = chrome.runtime.getURL("").replace(/\/$/, "");
const tabQueues = new Map();
const PAGE_PROTECTION_KEY = "pageProtectionStates";
const PAGE_PROTECTION_SCRIPT_ID = "tabwise-page-protection";
const SMART_ORIGINS = ["http://*/*", "https://*/*"];

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

async function isIdleEnough(tabId, thresholdMs) {
  const activity = await getActivity();
  const lastActive = activity[tabId];
  return Boolean(lastActive && Date.now() - lastActive >= thresholdMs);
}

async function suspendTab(tabId, reason = "manual", allowProtected = false) {
  return runForTab(tabId, async () => {
    const [settings, tab] = await Promise.all([getSettings(), chrome.tabs.get(tabId)]);
    const blockReason = allowProtected
      ? directSuspensionBlockReason(tab, extensionOrigin)
      : suspensionBlockReason(tab, settings, extensionOrigin);
    if (blockReason) return { ok: false, reason: blockReason };

    const recordId = crypto.randomUUID();
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

    const discardedTab = await chrome.tabs.discard(tabId);
    if (!discardedTab?.discarded) {
      await removeRecord(recordId);
      return { ok: false, reason: "浏览器未能卸载该标签页" };
    }
    const suspendedRecord = { ...record, mode: "native-discard", state: SUSPENSION_STATES.SUSPENDED };
    await putRecord(suspendedRecord);
    await addRecentSuspension(suspendedRecord);
    return { ok: true, recordId };
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
  const thresholdMs = settings.idleMinutes * 60_000;
  for (const tab of tabs.slice(0, 50)) {
    const blockReason = settings.suspensionMode === SUSPENSION_MODES.SMART
      ? smartSuspensionBlockReason(tab, settings, extensionOrigin, protectionStates[tab.id])
      : suspensionBlockReason(tab, settings, extensionOrigin);
    if (!tab.id || blockReason) continue;
    if (await isIdleEnough(tab.id, thresholdMs)) await suspendTab(tab.id, "idle");
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
  if (tab && tab.url === record.originalUrl && tab.discarded) {
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
      observedAt: observedAt[tab.id] || 0
    };
  });
  const liveTabs = tabs.filter((tab) => !isSuspendedUrl(tab.url, extensionOrigin));
  return {
    settings,
    tabs: rows,
    organization: planLocalOrganization(liveTabs),
    summary: {
      eligible: rows.filter((row) => row.status === "live").length,
      protected: rows.filter((row) => row.status === "protected").length,
      unloaded: rows.filter((row) => row.suspended).length
    }
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
