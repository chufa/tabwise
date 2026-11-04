import { DEFAULT_SETTINGS, SCHEMA_VERSION } from "./constants.js";

const keys = Object.freeze({
  settings: "settings",
  records: "suspensionRecords",
  restoreRecords: "suspensionRestoreRecords",
  recentSuspensions: "recentSuspensions",
  recoveryCheckpoints: "recoveryCheckpoints",
  resourceSnapshots: "resourceSnapshots",
  activity: "lastActivity",
  observedAt: "firstObservedAt",
  workspaces: "workspaces"
});

export async function getSettings() {
  const { [keys.settings]: saved = {} } = await chrome.storage.local.get(keys.settings);
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ [keys.settings]: settings });
}

export async function getRecords() {
  const { [keys.records]: records = {} } = await chrome.storage.local.get(keys.records);
  return records;
}

export async function putRecord(record) {
  const { [keys.records]: records = {}, [keys.restoreRecords]: restoreRecords = {} } = await chrome.storage.local.get([keys.records, keys.restoreRecords]);
  const nextRecord = { schemaVersion: SCHEMA_VERSION, ...record };
  records[record.recordId] = nextRecord;
  restoreRecords[record.recordId] = nextRecord;
  await chrome.storage.local.set({ [keys.records]: records, [keys.restoreRecords]: restoreRecords });
}

export async function getRecord(recordId) {
  const { [keys.records]: records = {}, [keys.restoreRecords]: restoreRecords = {} } = await chrome.storage.local.get([keys.records, keys.restoreRecords]);
  return records[recordId] || restoreRecords[recordId];
}

export async function removeRecord(recordId) {
  const { [keys.records]: records = {}, [keys.restoreRecords]: restoreRecords = {} } = await chrome.storage.local.get([keys.records, keys.restoreRecords]);
  delete records[recordId];
  delete restoreRecords[recordId];
  await chrome.storage.local.set({ [keys.records]: records, [keys.restoreRecords]: restoreRecords });
}

export async function removePrimaryRecord(recordId) {
  const records = await getRecords();
  delete records[recordId];
  await chrome.storage.local.set({ [keys.records]: records });
}

export async function removeRecordsForTab(tabId) {
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
}

export async function getActivity() {
  const { [keys.activity]: activity = {} } = await chrome.storage.session.get(keys.activity);
  return activity;
}

export async function touchTab(tabId, at = Date.now()) {
  const { [keys.activity]: activity = {}, [keys.observedAt]: observedAt = {} } = await chrome.storage.session.get([keys.activity, keys.observedAt]);
  activity[tabId] = at;
  observedAt[tabId] ||= at;
  await chrome.storage.session.set({ [keys.activity]: activity, [keys.observedAt]: observedAt });
}

export async function getObservedAt() {
  const { [keys.observedAt]: observedAt = {} } = await chrome.storage.session.get(keys.observedAt);
  return observedAt;
}

export async function getResourceSnapshots() {
  const { [keys.resourceSnapshots]: snapshots = {} } = await chrome.storage.session.get(keys.resourceSnapshots);
  return snapshots;
}

export async function saveResourceSnapshots(snapshots) {
  await chrome.storage.session.set({ [keys.resourceSnapshots]: snapshots });
}

export async function removeResourceSnapshot(tabId) {
  const snapshots = await getResourceSnapshots();
  delete snapshots[tabId];
  await saveResourceSnapshots(snapshots);
}

export async function removeActivity(tabId) {
  const { [keys.activity]: activity = {}, [keys.observedAt]: observedAt = {}, [keys.resourceSnapshots]: snapshots = {} } = await chrome.storage.session.get([keys.activity, keys.observedAt, keys.resourceSnapshots]);
  delete activity[tabId];
  delete observedAt[tabId];
  delete snapshots[tabId];
  await chrome.storage.session.set({ [keys.activity]: activity, [keys.observedAt]: observedAt, [keys.resourceSnapshots]: snapshots });
}

export async function getWorkspaces() {
  const { [keys.workspaces]: workspaces = [] } = await chrome.storage.local.get(keys.workspaces);
  return workspaces;
}

export async function addWorkspace(workspace) {
  const workspaces = await getWorkspaces();
  workspaces.unshift(workspace);
  workspaces.sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || right.createdAt - left.createdAt);
  await chrome.storage.local.set({ [keys.workspaces]: workspaces.slice(0, 20) });
}

export async function updateWorkspace(workspaceId, update) {
  const workspaces = await getWorkspaces();
  const index = workspaces.findIndex((workspace) => workspace.id === workspaceId);
  if (index === -1) return null;
  workspaces[index] = { ...workspaces[index], ...update };
  workspaces.sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || right.createdAt - left.createdAt);
  await chrome.storage.local.set({ [keys.workspaces]: workspaces });
  return workspaces.find((workspace) => workspace.id === workspaceId);
}

export async function getRecentSuspensions() {
  const { [keys.recentSuspensions]: recent = [] } = await chrome.storage.local.get(keys.recentSuspensions);
  return recent;
}

export async function addRecentSuspension(record) {
  const recent = await getRecentSuspensions();
  const next = [record, ...recent.filter((item) => item.recordId !== record.recordId)].slice(0, 20);
  await chrome.storage.local.set({ [keys.recentSuspensions]: next });
  return next;
}

export async function removeRecentSuspension(recordId) {
  const recent = await getRecentSuspensions();
  await chrome.storage.local.set({ [keys.recentSuspensions]: recent.filter((item) => item.recordId !== recordId) });
}

export async function getRecoveryCheckpoints() {
  const { [keys.recoveryCheckpoints]: checkpoints = [] } = await chrome.storage.local.get(keys.recoveryCheckpoints);
  return checkpoints;
}

export async function addRecoveryCheckpoint(checkpoint) {
  const checkpoints = await getRecoveryCheckpoints();
  const signature = checkpoint.tabs.map((tab) => tab.url).sort().join("\n");
  const duplicate = checkpoints.some((item) => item.tabs.map((tab) => tab.url).sort().join("\n") === signature);
  if (duplicate) return checkpoints;
  const next = [checkpoint, ...checkpoints].slice(0, 10);
  await chrome.storage.local.set({ [keys.recoveryCheckpoints]: next });
  return next;
}
