import test from "node:test";
import assert from "node:assert/strict";

const stores = { local: {}, session: {} };
const area = (name) => ({
  async get(keys) {
    const source = stores[name];
    if (typeof keys === "string") return { [keys]: structuredClone(source[keys]) };
    if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, structuredClone(source[key])]));
    return structuredClone(source);
  },
  async set(values) {
    if (name === "local" && failFinalRecord && Object.values(values.suspensionRecords || {}).some((item) => item.reason === "direct" && item.state === "suspended")) throw new Error("post-effect quota");
    if (name === "local" && failBackupWrite && values.workspaces && values.settings) throw new Error("fixture quota failure");
    Object.assign(stores[name], structuredClone(values));
  },
  async remove(key) { delete stores[name][key]; }
});
const event = () => {
  const listeners = new Set();
  return { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener),
    emit: (...args) => [...listeners].map((listener) => listener(...args)) };
};
let tabs = [];
let measured = [];
let inFlight = 0;
let peak = 0;
let activeLoads = 0;
let peakLoads = 0;
let failCreateUrl;
let onSample;
let failBackupWrite = false;
let failFinalRecord = false;
let permissionGranted = true;
let bytesUsed = 0;
const alarms = new Map();
globalThis.chrome = {
  storage: { local: area("local"), session: area("session") },
  runtime: { id: "fixture", getURL: (path) => `chrome-extension://fixture/${path}`, onInstalled: event(), onStartup: event(), onConnect: event(), onMessage: event() },
  alarms: { onAlarm: event(), get: async (id) => alarms.get(id), clear: async (id) => alarms.delete(id), create: async (id, value) => alarms.set(id, value) },
  commands: { onCommand: event() },
  omnibox: { onInputChanged: event(), onInputEntered: event() },
  permissions: { contains: async () => permissionGranted },
  windows: { getLastFocused: async () => ({ id: 1 }), update: async () => ({}) },
  tabs: {
    onActivated: event(), onDetached: event(), onRemoved: event(), onUpdated: event(),
    query: async () => structuredClone(tabs),
    get: async (id) => { const tab = tabs.find((item) => item.id === id); if (!tab) throw new Error("closed"); return structuredClone(tab); },
    update: async (id, changes) => { const tab = tabs.find((item) => item.id === id); Object.assign(tab, changes); return structuredClone(tab); },
    create: async ({ url, windowId = 1, active = false }) => {
      if (url === failCreateUrl) throw new Error("fixture create failure");
      const tab = { id: Math.max(0, ...tabs.map((item) => item.id)) + 1, title: url, url, windowId, active, status: "loading" };
      tabs.push(tab); activeLoads++; peakLoads = Math.max(peakLoads, activeLoads);
      setTimeout(() => { tab.status = "complete"; activeLoads--; chrome.tabs.onUpdated.emit(tab.id, { status: "complete" }); }, 3);
      return structuredClone(tab);
    }
  },
  scripting: {
    async executeScript({ target }) {
      measured.push(target.tabId); inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      await onSample?.(target.tabId);
      inFlight--;
      return [{ result: { usedJSHeapSize: target.tabId * 100, totalJSHeapSize: target.tabId * 200 } }];
    }
  }
};
chrome.storage.local.getBytesInUse = async () => bytesUsed;
await import("../src/background/service-worker.js");
const sender = { id: "fixture", documentId: "document", tab: { windowId: 1 }, url: chrome.runtime.getURL("src/sidepanel/sidepanel.html") };
function message(type, payload = {}, owner = sender) {
  return new Promise((resolve) => chrome.runtime.onMessage.emit({ type, ...payload }, owner, resolve));
}
async function settle(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("mock state did not settle");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
test("worker samples 25 tabs per round with concurrency four, retains other samples and covers 123 tabs", async () => {
  tabs = Array.from({ length: 123 }, (_, index) => ({ id: index + 1, title: `Page ${index + 1}`, url: `https://fixture.test/${index + 1}`, windowId: 1, status: "complete" }));
  stores.local.settings = { autoSuspend: false, resourceSampling: true };
  stores.session = {};
  measured = []; peak = 0;
  for (let round = 0; round < 5; round++) {
    if (stores.session.heapScanState) stores.session.heapScanState.at = 0;
    const before = measured.length;
    await message("getDashboard");
    assert.equal(measured.length - before, 25);
    assert.equal(Object.keys(stores.session.resourceSnapshots).length, Math.min((round + 1) * 25, 123));
  }
  assert.equal(new Set(measured).size, 123);
  assert.equal(peak, 4);
  const before = measured.length;
  await message("getDashboard");
  assert.equal(measured.length, before, "UI refresh must not start another sampling round");
  tabs = tabs.filter((tab) => tab.id !== 1);
  tabs.find((tab) => tab.id === 2).url = "https://fixture.test/changed";
  tabs.find((tab) => tab.id === 3).discarded = true;
  stores.session.heapScanState.at = 0;
  await message("getDashboard");
  assert.equal(stores.session.resourceSnapshots[1], undefined);
  assert.equal(stores.session.resourceSnapshots[2], undefined);
  assert.equal(stores.session.resourceSnapshots[3], undefined);
});

test("backup management binds requested download to its exporting document and drill persists summaries only", async () => {
  stores.local.workspaces = [{ id: "backup-status", name: "备份管理", notes: "私有备注", tags: ["AI"], tabs: [{ url: "https://backup.test/1" }] }];
  stores.local.backupManagement = {};
  const before = structuredClone(stores.local.workspaces);
  const exported = await message("exportBackup");
  assert.equal(stores.local.backupManagement.lastDownloadRequestedAt, undefined);
  assert.equal((await message("backupDownloadRequested", { exportRequestId: exported.exportRequestId }, { ...sender, documentId: "other" })).ok, false);
  assert.equal((await message("backupDownloadRequested", { exportRequestId: exported.exportRequestId })).ok, true);
  assert.ok(stores.local.backupManagement.lastDownloadRequestedAt);
  assert.equal((await message("backupDownloadRequested", { exportRequestId: exported.exportRequestId })).ok, false);
  assert.equal((await message("drillBackup", { backup: exported })).ok, true);
  assert.deepEqual(stores.local.workspaces, before);
  assert.ok(!JSON.stringify(stores.local.backupManagement).includes("私有备注"));
  const broken = structuredClone(exported);
  broken.payload.workspaces[0].name = "corrupt";
  assert.equal((await message("drillBackup", { backup: broken })).ok, false);
  assert.equal(stores.local.backupManagement.history[0].ok, false);
});
test("sample collected during navigation is invalidated even when the URL returns to its original value", async () => {
  const tab = tabs.find((tab) => tab.id === 4);
  onSample = async (id) => {
    if (id !== 4) return;
    chrome.tabs.onUpdated.emit(id, { status: "loading" });
    onSample = null;
  };
  await message("getResourceDiagnostics");
  assert.equal(stores.session.resourceSnapshots[tab.id], undefined);
});
test("automatic idle checks rotate past the initial fifty tabs", async () => {
  tabs = Array.from({ length: 123 }, (_, index) => ({ id: index + 1, title: `Page ${index + 1}`, url: `https://fixture.test/${index + 1}`, windowId: 1, status: "complete" }));
  stores.local.settings = { autoSuspend: true, idleMinutes: 5, resourceSampling: false, trustedDomains: ["fixture.test"] };
  stores.local.suspensionRecords = {};
  stores.session.lastActivity = Object.fromEntries(tabs.map((tab) => [tab.id, Date.now() - 60 * 60_000]));
  stores.session.idleScanCursor = 0;
  for (const count of [50, 100, 123]) {
    chrome.alarms.onAlarm.emit({ name: "tabwise-idle-check" });
    await settle(() => Object.keys(stores.local.suspensionRecords).length === count);
  }
  assert.equal(Object.keys(stores.local.suspensionRecords).length, 123);
});
test("selective restoration bounds page loads to five and returns per-page failures", async () => {
  tabs = [];
  stores.local.suspensionRecords = {};
  stores.local.settings = { autoSuspend: false, resourceSampling: false };
  const source = { id: "restore", name: "Restore", tabs: Array.from({ length: 12 }, (_, index) => ({ title: `Page ${index}`, url: `https://restore.test/${index}` })) };
  stores.local.workspaces = [source];
  activeLoads = 0; peakLoads = 0;
  failCreateUrl = source.tabs[6].url;
  const preview = await message("prepareRestore", { kind: "workspace", sourceId: source.id });
  const result = await message("confirmRestore", { previewId: preview.previewId, indices: source.tabs.map((_, index) => index) });
  assert.equal(result.count, 11);
  assert.equal(result.failed, 1);
  assert.equal(result.results.length, 12);
  assert.equal(peakLoads, 5);
  assert.equal((await message("confirmRestore", { previewId: preview.previewId, indices: [0] })).ok, false);
  failCreateUrl = null;
});

test("restoration rejects another document and stops if saved content changes between batches", async () => {
  tabs = [];
  const source = { id: "changing", name: "Changing", tabs: Array.from({ length: 12 }, (_, index) => ({ title: `Page ${index}`, url: `https://changing.test/${index}` })) };
  stores.local.workspaces = [source];
  const preview = await message("prepareRestore", { kind: "workspace", sourceId: source.id });
  assert.equal((await message("confirmRestore", { previewId: preview.previewId, indices: [0] }, { ...sender, documentId: "another-document" })).ok, false);
  const change = (id, info) => {
    if (info.status !== "complete") return;
    stores.local.workspaces[0].tabs = source.tabs.slice(0, 5);
    chrome.tabs.onUpdated.removeListener(change);
  };
  chrome.tabs.onUpdated.addListener(change);
  const result = await message("confirmRestore", { previewId: preview.previewId, indices: source.tabs.map((_, index) => index) });
  assert.equal(result.count, 5);
  assert.equal(result.failed, 7);
  assert.equal(tabs.length, 5, "changed source must stop future batches");
});

test("restore tasks persist before opening, stop future batches and retry only unfinished pages", async () => {
  tabs = [];
  stores.session.restoreTasks = [];
  stores.local.workspaces = [{ id: "task", name: "Task", tabs: Array.from({ length: 12 }, (_, i) => ({ url: `https://task.test/${i}` })) }];
  const preview = await message("prepareRestore", { kind: "workspace", sourceId: "task" });
  const started = await message("startRestore", { previewId: preview.previewId, indices: Array.from({ length: 12 }, (_, i) => i) });
  assert.ok(started.taskId);
  await message("stopRestoreTask", { taskId: started.taskId });
  await settle(() => ["stopped", "completed"].includes(stores.session.restoreTasks?.find((t) => t.id === started.taskId)?.status));
  const stopped = await message("getRestoreTask", { taskId: started.taskId });
  assert.equal(stopped.status, "stopped");
  assert.ok(tabs.length <= 5);
  assert.equal(stopped.total, 12);
  const retried = await message("retryRestoreTask", { taskId: started.taskId });
  await settle(() => stores.session.restoreTasks?.find((t) => t.id === retried.taskId)?.status === "completed");
  assert.equal(new Set(tabs.map((tab) => tab.url)).size, 12);
  assert.equal(tabs.length, 12);
});

test("worker restart records interrupted opening without replay and rejects retry after source changes", async () => {
  const { createRestorer } = await import("../src/background/restoration.js");
  tabs = [];
  stores.local.workspaces = [{ id: "interrupted", tabs: [{ url: "https://interrupted.test/" }] }];
  const { sourceState } = await import("../src/shared/restoration.js");
  stores.session.restoreTasks = [{ id: "interrupted-task", kind: "workspace", sourceId: "interrupted",
    signature: sourceState(stores.local.workspaces[0]), status: "running", results: [{ index: 0, status: "opening" }], indices: [0], total: 1 }];
  stores.local.restoreTaskLedger = structuredClone(stores.session.restoreTasks);
  const restarted = createRestorer(async () => {});
  const task = await restarted.detail("interrupted-task");
  assert.equal(task.status, "interrupted");
  assert.equal(task.results[0].status, "uncertain");
  assert.equal(tabs.length, 0);
  stores.local.workspaces[0].tabs[0].url = "https://changed.test/";
  await assert.rejects(restarted.retry("interrupted-task"), /变化/);
});

test("on-demand restoration creates placeholders without loading sources and respects chosen concurrency", async () => {
  tabs = [];
  stores.session.restoreTasks = [];
  stores.local.suspensionRecords = {};
  stores.local.workspaces = [{ id: "lazy", name: "Lazy", tabs: Array.from({ length: 8 }, (_, i) => ({ title: `Lazy ${i}`, url: `https://lazy.test/${i}` })) }];
  activeLoads = 0; peakLoads = 0;
  const preview = await message("prepareRestore", { kind: "workspace", sourceId: "lazy" });
  const started = await message("startRestore", { previewId: preview.previewId, indices: Array.from({ length: 8 }, (_, i) => i), loadMode: "on-demand", concurrency: 2 });
  await settle(() => stores.session.restoreTasks.find((task) => task.id === started.taskId)?.status === "completed");
  const detail = await message("getRestoreTask", { taskId: started.taskId, offset: 5 });
  assert.equal(detail.itemTotal, 8);
  assert.equal(detail.results.length, 3);
  assert.ok(tabs.every((tab) => tab.url.includes("/suspended.html#")));
  assert.equal(Object.values(stores.local.suspensionRecords).length, 8);
  assert.ok(peakLoads <= 2);
  const archived = await message("archiveTask", { taskId: started.taskId, taskType: "restore" });
  assert.equal(archived.ok, true);
  assert.equal((await message("getTasks")).some((task) => task.id === started.taskId), false);
});

test("temporary page protection blocks previewed and direct suspensions until explicitly removed", async () => {
  tabs = [{ id: 1, url: "https://protected.test/article", title: "Protected", status: "complete", windowId: 1 }];
  stores.local.settings = { autoSuspend: false, resourceSampling: false, trustedDomains: ["protected.test"] };
  stores.local.suspensionRecords = {};
  const preview = await message("prepareBatch", { kind: "suspend" });
  assert.equal((await message("protectTab", { tabId: 1, duration: "session" })).ok, true);
  assert.equal((await message("directSuspendTab", { tabId: 1 })).ok, false);
  const task = await message("startBatchPreview", { previewId: preview.previewId, tabIds: [1] });
  await settle(() => stores.session.batchTasks.find((item) => item.id === task.taskId)?.status === "completed");
  assert.equal((await message("getTask", { taskId: task.taskId })).skipped, 1);
  assert.equal((await message("unprotectTab", { tabId: 1 })).ok, true);
  assert.equal((await message("suspendTab", { tabId: 1 })).ok, true);
});

test("extension dashboard restores the recorded tab instead of its own caller tab", async () => {
  stores.local.suspensionRecords = {};
  stores.local.suspensionRestoreRecords = {};
  tabs = [{ id: 700, windowId: 1, url: chrome.runtime.getURL("src/suspended/suspended.html") + "#restore-ui", status: "complete" }];
  stores.local.suspensionRecords["restore-ui"] = { recordId: "restore-ui", tabId: 700, originalUrl: "https://restore-ui.test/", state: "suspended" };
  const result = await message("restoreRecord", { recordId: "restore-ui" }, { ...sender, tab: { id: 800, windowId: 1 } });
  assert.equal(result.ok, true);
  assert.equal(tabs[0].url, "https://restore-ui.test/");
});

test("partially restoring an archived workspace permits retry after automatic unarchiving", async () => {
  tabs = [];
  stores.local.workspaces = [{ id: "archive-retry", name: "归档重试", archived: true,
    tabs: [{ url: "https://archive-retry.test/1" }, { url: "https://archive-retry.test/2" }] }];
  failCreateUrl = "https://archive-retry.test/2";
  const preview = await message("prepareRestore", { kind: "workspace", sourceId: "archive-retry" });
  const started = await message("startRestore", { previewId: preview.previewId, indices: [0, 1], concurrency: 1 });
  await settle(() => stores.session.restoreTasks?.find((task) => task.id === started.taskId)?.status === "completed");
  assert.equal(stores.local.workspaces[0].archived, false);
  failCreateUrl = undefined;
  const retried = await message("retryTask", { taskType: "restore", taskId: started.taskId });
  assert.equal(retried.ok, true);
  await settle(() => stores.session.restoreTasks?.find((task) => task.id === retried.taskId)?.status === "completed");
  assert.equal(tabs.length, 2);
});

test("backup preview does not mutate storage, checks ownership and imports settings/workspaces atomically", async () => {
  stores.local.workspaces = [];
  stores.local.settings = { idleMinutes: 30, autoSuspend: false, resourceSampling: false };
  const backup = { schemaVersion: 1, settings: { idleMinutes: 60 }, workspaces: [{ id: "saved", name: "Saved", tabs: [{ url: "https://backup.test/" }] }] };
  const before = structuredClone(stores.local);
  const preview = await message("prepareBackupImport", { backup });
  assert.equal(preview.ok, true);
  assert.deepEqual(stores.local, before);
  assert.equal((await message("confirmBackupImport", { previewId: preview.previewId, indices: [0] }, { ...sender, documentId: "stranger" })).ok, false);
  failBackupWrite = true;
  const failure = await message("confirmBackupImport", { previewId: preview.previewId, indices: [0], includeSettings: true });
  assert.equal(failure.ok, false);
  assert.deepEqual(stores.local, before, "failed storage write leaves both settings and workspaces unchanged");
  failBackupWrite = false;
  const imported = await message("confirmBackupImport", { previewId: preview.previewId, indices: [0], includeSettings: true });
  assert.equal(imported.count, 1);
  assert.equal(stores.local.settings.idleMinutes, 60);
  assert.equal(stores.local.workspaces[0].provenance.sourceId, "saved");
  assert.equal((await message("confirmBackupImport", { previewId: preview.previewId, indices: [0] })).ok, false);
});

test("backup import skips identical content, preserves conflicting copies, rejects stale previews and over-capacity atomically", async () => {
  stores.local.workspaces = [{ id: "existing", name: "Same", tabs: [{ title: "A", url: "https://same.test/" }] }];
  const backup = { schemaVersion: 1, settings: { idleMinutes: 7 }, workspaces: [
    { id: "existing", name: "Same", tabs: [{ title: "A", url: "https://same.test/" }] },
    { id: "existing", name: "Changed", tabs: [{ url: "https://other.test/" }] }
  ] };
  const preview = await message("prepareBackupImport", { backup });
  assert.equal(preview.workspaces[0].duplicate, true);
  assert.equal(preview.workspaces[1].conflict, true);
  const imported = await message("confirmBackupImport", { previewId: preview.previewId, indices: [0, 1] });
  assert.equal(imported.count, 1);
  assert.equal(imported.skipped, 1);
  assert.equal(new Set(stores.local.workspaces.map((w) => w.id)).size, 2);
  const stale = await message("prepareBackupImport", { backup });
  stores.local.workspaces[0].tabs[0].url = "https://changed.test/";
  assert.equal((await message("confirmBackupImport", { previewId: stale.previewId, indices: [1] })).ok, false);
  const full = await message("prepareBackupImport", { backup });
  stores.local.workspaces = Array.from({ length: 20 }, (_, i) => ({ id: `full${i}`, tabs: [] }));
  const before = structuredClone(stores.local);
  assert.equal((await message("importBackup", { backup })).ok, false);
  assert.deepEqual(stores.local, before);
  assert.ok(full.previewId);
});

test("unified batch task stops later suspensions, skips changed retry targets and creates one aggregate undo", async () => {
  stores.session = { lastActivity: {} };
  stores.local.suspensionRecords = {};
  stores.local.settings = { autoSuspend: false, resourceSampling: false, trustedDomains: ["batch.test"] };
  tabs = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, url: `https://batch.test/${i}`, windowId: 1, title: `Batch ${i}`, status: "complete" }));
  const update = chrome.tabs.update;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let startedCount = 0;
  chrome.tabs.update = async (id, changes) => {
    if (changes.url?.includes("/suspended.html")) { startedCount++; await hold; }
    return update(id, changes);
  };
  try {
    const task = await message("startBatchSuspend");
    assert.ok(task.taskId);
    await settle(() => startedCount === 5);
    const listed = await message("getTasks");
    assert.equal(listed.find((item) => item.id === task.taskId).kind, "suspend");
    await message("stopTask", { taskId: task.taskId, taskType: "batch" });
    release();
    await settle(() => stores.session.batchTasks.find((item) => item.id === task.taskId).status === "stopped");
    const stopped = await message("getTask", { taskId: task.taskId });
    assert.equal(stopped.count, 5);
    await settle(() => Boolean(stores.session.batchTasks.find((item) => item.id === task.taskId).operationId));
    assert.equal((await message("getOperations")).filter((item) => item.label.includes("批量休眠")).length, 1);
    tabs[5].url = "https://changed.test/";
    const retry = await message("retryTask", { taskId: task.taskId, taskType: "batch" });
    await settle(() => stores.session.batchTasks.find((item) => item.id === retry.taskId).status === "completed");
    const result = await message("getTask", { taskId: retry.taskId });
    assert.equal(result.count, 6);
    assert.equal(result.skipped, 1);
    assert.equal(tabs[5].url, "https://changed.test/");
  } finally { release(); chrome.tabs.update = update; }
});

test("batch preview owns its targets, keeps changed pages open and cannot be replayed", async () => {
  stores.session = {};
  stores.local.settings = { autoSuspend: false, resourceSampling: false, trustedDomains: ["preview.test"] };
  stores.local.suspensionRecords = {};
  tabs = [1, 2].map((id) => ({ id, url: `https://preview.test/${id}`, title: `Preview ${id}`, windowId: 1, status: "complete" }));
  const preview = await message("prepareBatch", { kind: "suspend" });
  assert.equal(preview.pages.length, 2);
  assert.equal((await message("startBatchPreview", { previewId: preview.previewId, tabIds: [1] }, { ...sender, documentId: "other" })).ok, false);
  tabs[0].url = "https://changed.test/";
  const started = await message("startBatchPreview", { previewId: preview.previewId, tabIds: [1, 2] });
  assert.ok(started.taskId);
  await settle(() => stores.session.batchTasks.find((task) => task.id === started.taskId)?.status === "completed");
  const detail = await message("getTask", { taskId: started.taskId });
  assert.equal(detail.count, 1);
  assert.equal(detail.skipped, 1);
  assert.equal(tabs[0].url, "https://changed.test/");
  assert.equal((await message("startBatchPreview", { previewId: preview.previewId, tabIds: [1] })).ok, false);
});

test("group tasks finish one window before stopping, persist undo evidence and retry remaining windows", async () => {
  stores.session = {};
  stores.local.settings = { autoSuspend: false, resourceSampling: false };
  tabs = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, title: `Group ${i}`, url: `https://group.test/${i}`, windowId: i < 3 ? 1 : 2, index: i % 3, groupId: -1, status: "complete" }));
  const originalQuery = chrome.tabs.query, originalGroups = chrome.tabGroups, originalGroup = chrome.tabs.group;
  let groupId = 0, calls = 0, release;
  const groups = [];
  const hold = new Promise((resolve) => { release = resolve; });
  chrome.tabs.query = async (query = {}) => structuredClone(tabs.filter((tab) => !query.windowId || tab.windowId === query.windowId));
  chrome.tabGroups = { query: async ({ windowId }) => structuredClone(groups.filter((group) => group.windowId === windowId)),
    update: async (id, update) => Object.assign(groups.find((group) => group.id === id), update) };
  chrome.tabs.group = async ({ tabIds, createProperties }) => {
    calls++; if (calls === 1) await hold;
    const id = ++groupId; groups.push({ id, windowId: createProperties.windowId, title: "", color: "grey", collapsed: false });
    tabs.filter((tab) => tabIds.includes(tab.id)).forEach((tab) => { tab.groupId = id; });
    return id;
  };
  try {
    const started = await message("startBatchGroup", { tabIds: tabs.map((tab) => tab.id), title: "Groups" });
    await settle(() => calls === 1);
    assert.equal(stores.session.batchTasks[0].results[0].undoItems[0].before.tabs.length, 3);
    await message("stopTask", { taskId: started.taskId, taskType: "batch" });
    release();
    await settle(() => Boolean(stores.session.batchTasks.find((task) => task.id === started.taskId).operationId));
    const result = await message("getTask", { taskId: started.taskId });
    assert.equal(result.status, "stopped");
    assert.equal(result.count, 3);
    assert.equal(calls, 1);
    const retry = await message("retryTask", { taskId: started.taskId, taskType: "batch" });
    await settle(() => Boolean(stores.session.batchTasks.find((task) => task.id === retry.taskId).operationId));
    assert.equal((await message("getTask", { taskId: retry.taskId })).count, 3);
    assert.equal(calls, 2);
    assert.equal((await message("getOperations")).length, 2);
  } finally { release(); chrome.tabs.query = originalQuery; chrome.tabGroups = originalGroups; chrome.tabs.group = originalGroup; }
});

test("workspace incremental update binds window, previews diff, retains versions and rejects stale confirmation", async () => {
  stores.local.workspaces = [{ id: "incremental", name: "My work", tabs: [{ url: "https://work.test/old", title: "Old" }], createdAt: 1, pinned: true }];
  tabs = [{ id: 1, url: "https://work.test/new", title: "New", windowId: 1, index: 0, status: "complete" }];
  assert.equal((await message("bindWorkspace", { workspaceId: "incremental" })).ok, true);
  const preview = await message("prepareWorkspaceUpdate", { workspaceId: "incremental" });
  assert.equal(preview.added.length, 1);
  assert.equal(preview.removed.length, 1);
  tabs[0].url = "https://work.test/changed";
  assert.equal((await message("confirmWorkspaceUpdate", { previewId: preview.previewId })).ok, false);
  const current = await message("prepareWorkspaceUpdate", { workspaceId: "incremental" });
  assert.equal((await message("confirmWorkspaceUpdate", { previewId: current.previewId })).ok, true);
  assert.equal(stores.local.workspaces[0].id, "incremental");
  assert.equal(stores.local.workspaces[0].pinned, true);
  const versions = await message("getWorkspaceVersions", { workspaceId: "incremental" });
  assert.equal(versions.length, 1);
  const rollback = await message("prepareWorkspaceUpdate", { workspaceId: "incremental", versionId: versions[0].id });
  assert.equal(rollback.rollback, true);
  assert.equal((await message("confirmWorkspaceUpdate", { previewId: rollback.previewId }, { ...sender, documentId: "stranger" })).ok, false);
  assert.equal((await message("confirmWorkspaceUpdate", { previewId: rollback.previewId })).ok, true);
  assert.equal(stores.local.workspaces[0].tabs[0].url, "https://work.test/old");
  assert.equal(stores.local.workspaces[0].versions.length, 2);
  assert.equal(tabs[0].url, "https://work.test/changed");
});

test("budget preview rechecks current page activity, protection and URL before any reclaim", async () => {
  stores.session = { lastActivity: { 1: Date.now() - 3600000, 2: Date.now() - 3600000 },
    pageProtectionStates: { 1: { ready: true }, 2: { ready: true } } };
  stores.local.settings = { autoSuspend: false, resourceSampling: false, suspensionMode: "smart", resourceBudgetEnabled: true, resourceBudgetTabs: 1, resourceBudgetHeapMB: 1024 };
  stores.local.suspensionRecords = {};
  tabs = [1, 2].map((id) => ({ id, title: `Budget ${id}`, url: `https://budget.test/${id}`, windowId: 1, status: "complete" }));
  const preview = await message("prepareBudgetReclaim");
  assert.ok(preview.ok);
  assert.equal(preview.pages.length, 1);
  const id = preview.pages[0].tabId;
  tabs.find((tab) => tab.id === id).active = true;
  const result = await message("confirmBudgetReclaim", { previewId: preview.previewId, tabIds: [id] });
  assert.equal(result.count, 0);
  assert.equal(Object.keys(stores.local.suspensionRecords).length, 0);
  assert.equal((await message("confirmBudgetReclaim", { previewId: preview.previewId, tabIds: [id] })).ok, false);
  tabs.forEach((tab) => { tab.active = false; });
  const next = await message("prepareBudgetReclaim");
  stores.session.pageProtectionStates[next.pages[0].tabId] = { ready: true, dirty: true };
  assert.equal((await message("confirmBudgetReclaim", { previewId: next.previewId, tabIds: [next.pages[0].tabId] })).count, 0);
});

test("real worker search route applies flat sidebar filters and deduplicates only after filtering", async () => {
  stores.local.workspaces = [{ id: "filter", name: "Filter", tabs: [{ title: "Unique filter needle", url: "https://filter.test/a" }] }];
  tabs = [{ id: 1, title: "Unique filter needle", url: "https://filter.test/a", windowId: 1 },
    { id: 2, title: "Unique filter needle", url: "https://filter.test/b", windowId: 2, active: true }];
  chrome.tabs.onUpdated.emit(1, { title: "Unique filter needle" }, tabs[0]);
  const saved = await message("searchPages", { query: "unique filter needle", source: "workspace", workspaceId: "filter", deduplicate: true });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].source, "workspace");
  const live = await message("searchPages", { query: "unique filter needle", source: "open", windowId: 2, status: "protected", deduplicate: true });
  assert.equal(live.length, 1);
  assert.equal(live[0].tabId, 2);
});
test("post-effect storage failure keeps a restorable URL and quota pressure prevents new suspensions", async () => {
  tabs = [{ id: 801, windowId: 1, url: "https://fault.test/a", title: "Fault", status: "complete", active: false }];
  stores.local.settings = { autoSuspend: false, resourceSampling: false };
  failFinalRecord = true;
  const result = await message("directSuspendTab", { tabId: 801 });
  failFinalRecord = false;
  assert.equal(result.ok, true);
  assert.equal(result.recoveryRetained, true);
  assert.equal(stores.local.suspensionRestoreRecords[result.recordId].originalUrl, "https://fault.test/a");
  assert.equal((await message("restoreRecord", { recordId: result.recordId })).ok, true);
  tabs = [{ id: 802, windowId: 1, url: "https://fault.test/b", status: "complete", active: false }];
  bytesUsed = 10 * 1024 * 1024 - 1000;
  const rejected = await message("directSuspendTab", { tabId: 802 });
  bytesUsed = 0;
  assert.equal(rejected.ok, false);
  assert.equal(tabs[0].url, "https://fault.test/b");
});
test("permission revocation and disabled sampling prevent script injection", async () => {
  tabs = [{ id: 803, windowId: 1, url: "https://permission.test/a", status: "complete" }];
  stores.local.settings = { autoSuspend: false, resourceSampling: true, resourceSamplingMode: "off" };
  const before = measured.length;
  await message("getDashboard");
  assert.equal(measured.length, before);
  permissionGranted = false;
  const result = await message("getResourceDiagnostics");
  permissionGranted = true;
  assert.equal(result.ok, false);
  assert.ok(result.permissionRequest);
  assert.equal(measured.length, before);
});
test("concurrent restore retry and resume create only one successor and do not reopen settled pages", async () => {
  tabs = [];
  stores.local.workspaces = [{ id: "concurrent", name: "Concurrent", tabs: [{ url: "https://concurrent.test/a" }] }];
  const { sourceState } = await import("../src/shared/restoration.js");
  stores.session.restoreTasks = [{ id: "concurrent-parent", kind: "workspace", sourceId: "concurrent", status: "stopped",
    signature: sourceState(stores.local.workspaces[0]), results: [{ index: 0, status: "pending" }], indices: [0], total: 1 }];
  const results = await Promise.all([message("retryRestoreTask", { taskId: "concurrent-parent" }),
    message("resumeRestoreTask", { taskId: "concurrent-parent", taskType: "restore" }), message("retryRestoreTask", { taskId: "concurrent-parent" })]);
  assert.equal(results.filter((item) => item.ok).length, 1);
  const child = results.find((item) => item.ok);
  await settle(() => stores.session.restoreTasks.find((item) => item.id === child.taskId)?.status === "completed");
  assert.equal(tabs.length, 1);
  assert.equal((await message("getRestoreTask", { taskId: "concurrent-parent" })).retryable, false);
});
