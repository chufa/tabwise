import { DEFAULT_SETTINGS, SCHEMA_VERSION } from "./constants.js";
import { snapshotSignature } from "./session.js";
import { appendDiagnostic, diagnosticBundle } from "./diagnostics.js";
import { migrateLocalState } from "./migrations.js";
import { appendEffect, summarizeEffects } from "./effects.js";
import { packSyncMetadata, readSyncMetadata, syncFingerprint, writeSyncMetadata } from "./sync-transport.js";
import { buildSyncMetadata, createSyncHistoryEntry, nextSyncRevision, planSyncMetadata, resolveSyncPlan, validateSyncMetadata } from "./sync-metadata.js";

const queues = { local: Promise.resolve(), session: Promise.resolve() };
export function queueStorage(area, work) {
  const next = queues[area].catch(() => {}).then(work);
  queues[area] = next;
  return next;
}

const keys = Object.freeze({
  settings: "settings",
  records: "suspensionRecords",
  restoreRecords: "suspensionRestoreRecords",
  recentSuspensions: "recentSuspensions",
  recoveryCheckpoints: "recoveryCheckpoints",
  resourceReviews: "resourceReviews",
  resourceSnapshots: "resourceSnapshots",
  activity: "lastActivity",
  observedAt: "firstObservedAt",
  workspaces: "workspaces",
  syncHistory: "syncHistory"
});

export async function migrateStorage() {
  return queueStorage("local", async () => {
    const current = await chrome.storage.local.get();
    const { state, changed } = migrateLocalState(current);
    if (changed) await chrome.storage.local.set(state);
    return { changed, version: state.storageSchemaVersion };
  });
}

export async function getDiagnostics() {
  const [{ diagnostics = [] }, settings] = await Promise.all([chrome.storage.local.get("diagnostics"), getSettings()]);
  return { records: diagnostics, bundle: diagnosticBundle({ extensionVersion: chrome.runtime.getManifest().version, settings, records: diagnostics }) };
}

export async function getEffects() {
  const { effectHistory = [] } = await chrome.storage.local.get("effectHistory");
  return summarizeEffects(effectHistory);
}
export function recordEffect(event) {
  return queueStorage("local", async () => {
    const { effectHistory = [] } = await chrome.storage.local.get("effectHistory");
    await chrome.storage.local.set({ effectHistory: appendEffect(effectHistory, event) });
  });
}

export function reportDiagnostic(item) {
  return queueStorage("local", async () => {
    const { diagnostics = [] } = await chrome.storage.local.get("diagnostics");
    await chrome.storage.local.set({ diagnostics: appendDiagnostic(diagnostics, item) });
  });
}

export function clearDiagnostics() {
  return queueStorage("local", () => chrome.storage.local.set({ diagnostics: [] }));
}

export function clearLocalHistory() {
  return Promise.all([
    queueStorage("local", () => chrome.storage.local.set({
      closedPages: [],
      [keys.recentSuspensions]: [],
      [keys.recoveryCheckpoints]: [],
      [keys.resourceReviews]: [],
      effectHistory: []
    })),
    queueStorage("session", () => chrome.storage.session.set({
      [keys.resourceSnapshots]: {},
      heapHistory: {},
      aiAnalysisSnapshots: [],
      aiThemeCache: []
    }))
  ]);
}

function sortWorkspaces(workspaces) {
  workspaces.sort((left, right) => Number(Boolean(left.archived)) - Number(Boolean(right.archived))
    || Number(Boolean(right.favorite)) - Number(Boolean(left.favorite))
    || Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
    || Number(right.createdAt) - Number(left.createdAt));
}

export async function getSettings() {
  const { [keys.settings]: saved = {} } = await chrome.storage.local.get(keys.settings);
  return { ...DEFAULT_SETTINGS, ...saved };
}

export function saveSettings(settings) {
  return queueStorage("local", () => chrome.storage.local.set({ [keys.settings]: settings }));
}

export function changeSettings(update) {
  return queueStorage("local", async () => {
    const settings = update(await getSettings());
    await chrome.storage.local.set({ [keys.settings]: settings });
    return settings;
  });
}

export async function getRecords() {
  const { [keys.records]: records = {} } = await chrome.storage.local.get(keys.records);
  return records;
}

export function putRecord(record, reserve = false) {
  return queueStorage("local", async () => {
  const { [keys.records]: records = {}, [keys.restoreRecords]: restoreRecords = {} } = await chrome.storage.local.get([keys.records, keys.restoreRecords]);
  const nextRecord = { schemaVersion: SCHEMA_VERSION, ...record };
  records[record.recordId] = nextRecord;
  restoreRecords[record.recordId] = nextRecord;
  if (reserve && chrome.storage.local.getBytesInUse) {
    const used = await chrome.storage.local.getBytesInUse(null);
    const quota = chrome.storage.local.QUOTA_BYTES || 10 * 1024 * 1024;
    const estimate = new TextEncoder().encode(JSON.stringify(nextRecord)).length * 2 + 1024;
    if (used + estimate + 128 * 1024 > quota) throw new Error("本机存储接近上限，已暂停此次休眠。请整理历史或导出备份后再试。");
  }
  await chrome.storage.local.set({ [keys.records]: records, [keys.restoreRecords]: restoreRecords });
  });
}

export async function getRecord(recordId) {
  const { [keys.records]: records = {}, [keys.restoreRecords]: restoreRecords = {} } = await chrome.storage.local.get([keys.records, keys.restoreRecords]);
  return records[recordId] || restoreRecords[recordId];
}

export function removeRecord(recordId) {
  return queueStorage("local", async () => {
  const { [keys.records]: records = {}, [keys.restoreRecords]: restoreRecords = {} } = await chrome.storage.local.get([keys.records, keys.restoreRecords]);
  delete records[recordId];
  delete restoreRecords[recordId];
  await chrome.storage.local.set({ [keys.records]: records, [keys.restoreRecords]: restoreRecords });
  });
}

export function removePrimaryRecord(recordId) {
  return queueStorage("local", async () => {
  const records = await getRecords();
  delete records[recordId];
  await chrome.storage.local.set({ [keys.records]: records });
  });
}

export function removeRecordsForTab(tabId) {
  return queueStorage("local", async () => {
  const { [keys.records]: records = {}, [keys.restoreRecords]: restoreRecords = {} } = await chrome.storage.local.get([keys.records, keys.restoreRecords]);
  let changed = false;
  const allRecords = { ...restoreRecords, ...records };
  for (const [recordId, record] of Object.entries(allRecords)) {
    if (record.tabId === tabId) {
      delete records[recordId];
      delete restoreRecords[recordId];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [keys.records]: records, [keys.restoreRecords]: restoreRecords });
  });
}

export async function getActivity() {
  const { [keys.activity]: activity = {} } = await chrome.storage.session.get(keys.activity);
  return activity;
}

export function touchTab(tabId, at = Date.now()) {
  return queueStorage("session", async () => {
  const { [keys.activity]: activity = {}, [keys.observedAt]: observedAt = {} } = await chrome.storage.session.get([keys.activity, keys.observedAt]);
  activity[tabId] = at;
  observedAt[tabId] ||= at;
  await chrome.storage.session.set({ [keys.activity]: activity, [keys.observedAt]: observedAt });
  });
}

export async function getObservedAt() {
  const { [keys.observedAt]: observedAt = {} } = await chrome.storage.session.get(keys.observedAt);
  return observedAt;
}

export async function getResourceSnapshots() {
  const { [keys.resourceSnapshots]: snapshots = {} } = await chrome.storage.session.get(keys.resourceSnapshots);
  return snapshots;
}

export function saveResourceSnapshots(snapshots) {
  return queueStorage("session", () => chrome.storage.session.set({ [keys.resourceSnapshots]: snapshots }));
}

export function removeResourceSnapshot(tabId) {
  return queueStorage("session", async () => {
  const snapshots = await getResourceSnapshots();
  const { heapHistory = {} } = await chrome.storage.session.get("heapHistory");
  delete snapshots[tabId];
  delete heapHistory[tabId];
  await chrome.storage.session.set({ [keys.resourceSnapshots]: snapshots, heapHistory });
  });
}

export function removeActivity(tabId) {
  return queueStorage("session", async () => {
  const { [keys.activity]: activity = {}, [keys.observedAt]: observedAt = {}, [keys.resourceSnapshots]: snapshots = {}, heapHistory = {} } = await chrome.storage.session.get([keys.activity, keys.observedAt, keys.resourceSnapshots, "heapHistory"]);
  delete activity[tabId];
  delete observedAt[tabId];
  delete snapshots[tabId];
  delete heapHistory[tabId];
  await chrome.storage.session.set({ [keys.activity]: activity, [keys.observedAt]: observedAt, [keys.resourceSnapshots]: snapshots, heapHistory });
  });
}

export async function getAllWorkspaces() {
  const { [keys.workspaces]: workspaces = [] } = await chrome.storage.local.get(keys.workspaces);
  return workspaces;
}

export async function previewSyncMetadata() {
  const [allWorkspaces, settings, { syncRevision = 0, pendingSync }] = await Promise.all([getAllWorkspaces(), getSettings(), chrome.storage.local.get(["syncRevision", "pendingSync"])]);
  const workspaces = allWorkspaces.filter((item) => !item.deletedAt);
  const local = buildSyncMetadata({ workspaces, settings }, { revision: syncRevision });
  const { metadata: rawRemote, token } = await readSyncMetadata();
  const remote = rawRemote && validateSyncMetadata(rawRemote);
  const deletedIds = new Set(allWorkspaces.filter((item) => item.deletedAt).map((item) => item.id));
  if (remote) remote.workspaces = remote.workspaces.filter((item) => !deletedIds.has(item.id));
  const previewId = crypto.randomUUID();
  await chrome.storage.session.set({ syncPreview: { id: previewId, at: Date.now(), token,
    localToken: syncFingerprint({ workspaces: allWorkspaces, settings }) } });
  let capacity;
  try { capacity = { bytes: packSyncMetadata(local).totalBytes, limit: 45000 }; }
  catch (error) { capacity = { limit: 45000, reason: error.message }; }
  const choices = [...new Map([...workspaces, ...(remote?.workspaces || [])].map((item) => [item.id, { id: item.id, name: item.name, pages: item.tabs?.length || 0 }])).values()];
  return { ok: true, previewId, capacity, choices, pending: Boolean(pendingSync), direction: remote ? "merge" : "upload",
    ...(remote ? planSyncMetadata({ workspaces, settings }, remote) : { conflicts: [], local }) };
}

async function commitSyncState(prepared, action) {
  const { syncHistory = [] } = await chrome.storage.local.get("syncHistory");
  const entry = createSyncHistoryEntry(prepared.metadata, action);
  await chrome.storage.local.set({ workspaces: prepared.workspaces, settings: prepared.settings, syncRevision: entry.revision,
    syncHistory: [entry, ...syncHistory].slice(0, 20), pendingSync: null });
}

export async function applySyncMetadata(resolutions = {}, options = {}) {
  return queueStorage("local", async () => {
  const [allWorkspaces, settings, { syncRevision = 0 }] = await Promise.all([getAllWorkspaces(), getSettings(), chrome.storage.local.get("syncRevision")]);
  const workspaces = allWorkspaces.filter((item) => !item.deletedAt);
  const localToken = syncFingerprint({ workspaces: allWorkspaces, settings });
  const { metadata: rawRemote, token } = await readSyncMetadata();
  const remote = rawRemote && validateSyncMetadata(rawRemote);
  const deletedIds = new Set(allWorkspaces.filter((item) => item.deletedAt).map((item) => item.id));
  if (remote) remote.workspaces = remote.workspaces.filter((item) => !deletedIds.has(item.id));
  if (options.previewId) {
    const { syncPreview: preview } = await chrome.storage.session.get("syncPreview");
    if (!preview || preview.id !== options.previewId || Date.now() - preview.at > 300000
      || preview.token !== token || preview.localToken !== localToken) throw new Error("同步预览已变化或过期，请重新预览。");
  }
  if (options.workspaceIds !== undefined && (!Array.isArray(options.workspaceIds) || options.workspaceIds.some((id) => typeof id !== "string"))) throw new Error("同步选择无效。");
  const { pendingSync } = await chrome.storage.local.get("pendingSync");
  const sameSelection = options.workspaceIds === undefined || syncFingerprint([...new Set(options.workspaceIds)].sort()) === syncFingerprint((pendingSync?.metadata?.workspaces || []).map((item) => item.id).sort());
  if (pendingSync?.metadata && sameSelection && pendingSync.localToken === localToken
    && syncFingerprint(rawRemote) === syncFingerprint(pendingSync.metadata)) {
    await commitSyncState(pendingSync, "merged");
    return { ok: true, direction: "merged", conflicts: 0, recovered: true };
  }
  const selected = options.workspaceIds ? new Set(options.workspaceIds) : null;
  const included = (item) => !selected || selected.has(item.id);
  const plan = planSyncMetadata({ workspaces: workspaces.filter(included), settings },
    remote ? { ...remote, workspaces: remote.workspaces.filter(included) } : {});
  const resolved = remote ? resolveSyncPlan(plan, resolutions) : { workspaces: workspaces.filter(included), sitePolicies: {} };
  const nextSettings = { ...settings, ...resolved.sitePolicies };
  const nextWorkspaces = [...resolved.workspaces, ...workspaces.filter((item) => !included(item)),
    ...allWorkspaces.filter((item) => item.deletedAt)];
  validateWorkspaceCapacity(nextWorkspaces);
  sortWorkspaces(nextWorkspaces);
  const metadata = buildSyncMetadata({ workspaces: resolved.workspaces, settings: nextSettings },
    { revision: nextSyncRevision(syncRevision, remote?.version?.revision), parentRevision: remote?.version?.revision });
  packSyncMetadata(metadata);
  // Durable preparation before remote writes; local data changes in one final set.
  const prepared = { at: Date.now(), metadata, workspaces: nextWorkspaces, settings: nextSettings,
    localToken };
  await chrome.storage.local.set({ pendingSync: prepared });
  await writeSyncMetadata(metadata, token);
  await commitSyncState(prepared, remote ? "merged" : "uploaded");
  return { ok: true, direction: remote ? "merged" : "uploaded", conflicts: plan.conflicts.length, bytes: packSyncMetadata(metadata).totalBytes };
  });
}

export async function getSyncHistory() {
  const { [keys.syncHistory]: history = [] } = await chrome.storage.local.get(keys.syncHistory);
  return history.map(({ metadata, ...entry }) => entry);
}

export async function restoreSyncHistory(id) {
  return queueStorage("local", async () => {
  const { [keys.syncHistory]: history = [] } = await chrome.storage.local.get(keys.syncHistory);
  const entry = history.find((item) => item.id === id);
  if (!entry?.metadata) throw new Error("同步历史不存在或已过期。");
  const { syncRevision = 0 } = await chrome.storage.local.get("syncRevision");
  const existing = await getAllWorkspaces();
  const restoredIds = new Set((entry.metadata.workspaces || []).map((item) => item.id));
  const workspaces = [...structuredClone(entry.metadata.workspaces || []).map((workspace) => ({
    ...workspace, notes: existing.find((item) => item.id === workspace.id)?.notes || "",
    versions: existing.find((item) => item.id === workspace.id)?.versions || [],
    ...(existing.find((item) => item.id === workspace.id)?.mergeSources ? { mergeSources: existing.find((item) => item.id === workspace.id).mergeSources } : {})
  })), ...existing.filter((workspace) => !restoredIds.has(workspace.id))];
  validateWorkspaceCapacity(workspaces);
  const settings = { ...await getSettings(), ...(entry.metadata.sitePolicies || {}) };
  const metadata = buildSyncMetadata({ workspaces: entry.metadata.workspaces || [], settings }, { revision: nextSyncRevision(syncRevision, entry.revision), parentRevision: entry.revision });
  const { token } = await readSyncMetadata();
  packSyncMetadata(metadata);
  const prepared = { at: Date.now(), metadata, workspaces, settings,
    localToken: syncFingerprint({ workspaces: existing, settings: await getSettings() }) };
  await chrome.storage.local.set({ pendingSync: prepared });
  await writeSyncMetadata(metadata, token);
  await commitSyncState(prepared, "restored");
  return { ok: true, revision: metadata.version.revision };
  });
}

export async function syncMetadata() {
  const preview = await previewSyncMetadata();
  if (preview.direction === "upload") return applySyncMetadata();
  return applySyncMetadata(Object.fromEntries((preview.conflicts || []).map((conflict) => [conflict.id, conflict.kind === "workspace" ? "copy" : "local"])));
}

export async function getWorkspaces() {
  return (await getAllWorkspaces()).filter((workspace) => !workspace.deletedAt);
}

export async function getWorkspaceTrash() {
  return (await getAllWorkspaces()).filter((workspace) => workspace.deletedAt);
}

export function validateWorkspaceCapacity(workspaces) {
  if (workspaces.filter((workspace) => !workspace.deletedAt).length > 20) throw new Error("工作区已达 20 个，请先移入回收站。");
  if (workspaces.filter((workspace) => workspace.deletedAt).length > 20) throw new Error("回收站已达 20 个，请先整理回收站。");
}

export function addWorkspace(workspace) {
  return queueStorage("local", async () => {
  const workspaces = await getAllWorkspaces();
  if (workspaces.some((item) => item.id === workspace.id)) throw new Error("工作区已存在。");
  workspaces.unshift(workspace);
  validateWorkspaceCapacity(workspaces);
  sortWorkspaces(workspaces);
  await chrome.storage.local.set({ [keys.workspaces]: workspaces });
  });
}

export function updateWorkspace(workspaceId, update) {
  return queueStorage("local", async () => {
  const workspaces = await getAllWorkspaces();
  const index = workspaces.findIndex((workspace) => workspace.id === workspaceId);
  if (index === -1) return null;
  workspaces[index] = { ...workspaces[index], ...update };
  validateWorkspaceCapacity(workspaces);
  sortWorkspaces(workspaces);
  await chrome.storage.local.set({ [keys.workspaces]: workspaces });
  return workspaces.find((workspace) => workspace.id === workspaceId);
  });
}

export function changeWorkspaces(update) {
  return queueStorage("local", async () => {
    const workspaces = update(await getAllWorkspaces());
    validateWorkspaceCapacity(workspaces);
    await chrome.storage.local.set({ [keys.workspaces]: workspaces });
  });
}

export async function getRecentSuspensions() {
  const { [keys.recentSuspensions]: recent = [] } = await chrome.storage.local.get(keys.recentSuspensions);
  return recent;
}

export function addRecentSuspension(record) {
  return queueStorage("local", async () => {
  const recent = await getRecentSuspensions();
  const next = [record, ...recent.filter((item) => item.recordId !== record.recordId)].slice(0, 20);
  await chrome.storage.local.set({ [keys.recentSuspensions]: next });
  return next;
  });
}

export function removeRecentSuspension(recordId) {
  return queueStorage("local", async () => {
  const recent = await getRecentSuspensions();
  await chrome.storage.local.set({ [keys.recentSuspensions]: recent.filter((item) => item.recordId !== recordId) });
  });
}

export async function getRecoveryCheckpoints() {
  const { [keys.recoveryCheckpoints]: checkpoints = [] } = await chrome.storage.local.get(keys.recoveryCheckpoints);
  return checkpoints;
}

export function addRecoveryCheckpoint(checkpoint) {
  return queueStorage("local", async () => {
  const checkpoints = await getRecoveryCheckpoints();
  const signature = snapshotSignature(checkpoint);
  const duplicate = checkpoints[0] && snapshotSignature(checkpoints[0]) === signature;
  if (duplicate) return checkpoints;
  const next = [checkpoint, ...checkpoints].slice(0, 10);
  await chrome.storage.local.set({ [keys.recoveryCheckpoints]: next });
  return next;
  });
}

export async function getResourceReviews() {
  const { [keys.resourceReviews]: reviews = [] } = await chrome.storage.local.get(keys.resourceReviews);
  return reviews;
}

export function addResourceReview(review) {
  return queueStorage("local", async () => {
  const reviews = await getResourceReviews();
  const next = [review, ...reviews].slice(0, 20);
  await chrome.storage.local.set({ [keys.resourceReviews]: next });
  return next;
  });
}

export function saveResourceReviews(reviews) {
  return queueStorage("local", () => chrome.storage.local.set({ [keys.resourceReviews]: reviews.slice(0, 20) }));
}

async function readClosedPages(now = Date.now()) {
  const { closedPages = [] } = await chrome.storage.local.get("closedPages");
  const settings = await getSettings();
  const pages = settings.closedHistoryEnabled ? closedPages.filter((page) => page.closedAt > now - settings.closedHistoryDays * 86_400_000).slice(0, 100) : [];
  if (pages.length !== closedPages.length) await chrome.storage.local.set({ closedPages: pages });
  return pages;
}

export function getClosedPages(now = Date.now()) {
  return queueStorage("local", () => readClosedPages(now));
}

export function addClosedPage(page) {
  return queueStorage("local", async () => {
    const settings = await getSettings();
    if (!settings.closedHistoryEnabled || !/^https?:\/\//.test(page.url) || page.incognito) return;
    const pages = await readClosedPages();
    await chrome.storage.local.set({ closedPages: [{ id: crypto.randomUUID(), title: page.title || page.url, url: page.url, closedAt: Date.now() }, ...pages].slice(0, 100) });
  });
}

export function removeClosedPage(id) {
  return queueStorage("local", async () => {
    const pages = await readClosedPages();
    await chrome.storage.local.set({ closedPages: id ? pages.filter((page) => page.id !== id) : [] });
  });
}
