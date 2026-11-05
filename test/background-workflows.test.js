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
  async set(values) { Object.assign(stores[name], structuredClone(values)); },
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
const alarms = new Map();
globalThis.chrome = {
  storage: { local: area("local"), session: area("session") },
  runtime: { id: "fixture", getURL: (path) => `chrome-extension://fixture/${path}`, onInstalled: event(), onStartup: event(), onConnect: event(), onMessage: event() },
  alarms: { onAlarm: event(), get: async (id) => alarms.get(id), clear: async (id) => alarms.delete(id), create: async (id, value) => alarms.set(id, value) },
  commands: { onCommand: event() },
  omnibox: { onInputChanged: event(), onInputEntered: event() },
  permissions: { contains: async () => true },
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
  const restarted = createRestorer(async () => {});
  const task = await restarted.detail("interrupted-task");
  assert.equal(task.status, "interrupted");
  assert.equal(task.results[0].status, "uncertain");
  assert.equal(tabs.length, 0);
  stores.local.workspaces[0].tabs[0].url = "https://changed.test/";
  await assert.rejects(restarted.retry("interrupted-task"), /变化/);
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
