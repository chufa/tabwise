import { ALARM_NAME, ALARM_PERIOD_MINUTES, SUSPENDED_PAGE, SUSPENSION_STATES } from "../shared/constants.js";
import { domainForUrl, isSuspendableUrl, isSuspendedUrl, normalizeDomain, planLocalOrganization, suspensionBlockReason } from "../shared/policy.js";
import { addWorkspace, getActivity, getRecord, getRecords, getSettings, getWorkspaces, putRecord, removeActivity, removeRecord, removeRecordsForTab, saveSettings, touchTab, updateWorkspace } from "../shared/storage.js";

const extensionOrigin = chrome.runtime.getURL("").replace(/\/$/, "");
const tabQueues = new Map();

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
    trustedDomains: Array.isArray(update.trustedDomains) ? normalizeList(update.trustedDomains) : current.trustedDomains,
    blockedDomains: Array.isArray(update.blockedDomains) ? normalizeList(update.blockedDomains) : current.blockedDomains,
    pauseUntil: Number.isFinite(pauseUntil) && pauseUntil > Date.now() ? pauseUntil : 0
  };
}

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
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

async function suspendTab(tabId, reason = "manual") {
  return runForTab(tabId, async () => {
    const [settings, tab] = await Promise.all([getSettings(), chrome.tabs.get(tabId)]);
    const blockReason = suspensionBlockReason(tab, settings, extensionOrigin);
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

    const expectedUrl = `${chrome.runtime.getURL(SUSPENDED_PAGE)}#${recordId}`;
    const updatedTab = await chrome.tabs.update(tabId, { url: expectedUrl });
    if (updatedTab.url !== expectedUrl) {
      await removeRecord(recordId);
      return { ok: false, reason: "Browser did not open the suspension page" };
    }
    await putRecord({ ...record, state: SUSPENSION_STATES.SUSPENDED });
    return { ok: true, recordId };
  });
}

async function restoreRecord(recordId, senderTabId) {
  const record = await getRecord(recordId);
  if (!record) return { ok: false, reason: "Suspension record no longer exists" };
  const tabId = senderTabId || record.tabId;

  return runForTab(tabId, async () => {
    const current = await chrome.tabs.get(tabId);
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
  const thresholdMs = settings.idleMinutes * 60_000;
  for (const tab of tabs.slice(0, 50)) {
    if (!tab.id || suspensionBlockReason(tab, settings, extensionOrigin)) continue;
    if (await isIdleEnough(tab.id, thresholdMs)) await suspendTab(tab.id, "idle");
  }
}

async function getDashboard() {
  const [settings, records, tabs, activity] = await Promise.all([getSettings(), getRecords(), chrome.tabs.query({}), getActivity()]);
  const recordsByTab = new Map(Object.values(records).map((record) => [record.tabId, record]));
  const rows = tabs.map((tab) => {
    const record = recordsByTab.get(tab.id);
    const blockReason = record ? "" : suspensionBlockReason(tab, settings, extensionOrigin);
    return {
      id: tab.id,
      title: record?.title || tab.title || "Untitled tab",
      url: record?.originalUrl || tab.url || "",
      domain: domainForUrl(record?.originalUrl || tab.url || ""),
      active: Boolean(tab.active),
      suspended: Boolean(record && isSuspendedUrl(tab.url, extensionOrigin)),
      status: record?.state || (blockReason ? "protected" : "live"),
      reason: record?.reason || blockReason,
      recordId: record?.recordId || "",
      suspendedAt: record?.suspendedAt || 0,
      lastActivity: activity[tab.id] || 0
    };
  });
  const liveTabs = tabs.filter((tab) => !isSuspendedUrl(tab.url, extensionOrigin));
  return {
    settings,
    tabs: rows,
    organization: planLocalOrganization(liveTabs),
    summary: {
      eligible: rows.filter((row) => row.status === "live").length,
      protected: rows.filter((row) => row.status === "protected").length
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
  await recordExistingTabs();
});
chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await rebindSuspendedTabs();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) processIdleTabs().catch(console.error);
});
chrome.tabs.onActivated.addListener(({ tabId }) => touchTab(tabId));
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await Promise.all([removeActivity(tabId), removeRecordsForTab(tabId)]);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url || isSuspendedUrl(changeInfo.url, extensionOrigin)) return;
  Promise.all([touchTab(tabId), removeRecordsForTab(tabId)]).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tasks = {
    getDashboard,
    getSuspendedRecord: () => getSuspendedRecordForSender(message.recordId, sender),
    suspendTab: () => suspendTab(message.tabId),
    restoreRecord: () => restoreRecord(message.recordId, sender.tab?.id),
    updateSettings: async () => {
      const current = await getSettings();
      const next = sanitizeSettings(current, message.settings || {});
      await saveSettings(next);
      return next;
    },
    pauseAutomation: () => pauseAutomation(message.minutes),
    trustDomain: () => trustDomain(message.url),
    focusTab: () => focusTab(message.tabId),
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

  const task = tasks[message.type];
  if (!task) return false;
  task().then(sendResponse).catch((error) => sendResponse({ ok: false, reason: error.message }));
  return true;
});
