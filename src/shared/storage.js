import { DEFAULT_SETTINGS, SCHEMA_VERSION } from "./constants.js";

const keys = Object.freeze({
  settings: "settings",
  records: "suspensionRecords",
  activity: "lastActivity",
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
  const records = await getRecords();
  records[record.recordId] = { schemaVersion: SCHEMA_VERSION, ...record };
  await chrome.storage.local.set({ [keys.records]: records });
}

export async function getRecord(recordId) {
  return (await getRecords())[recordId];
}

export async function removeRecord(recordId) {
  const records = await getRecords();
  delete records[recordId];
  await chrome.storage.local.set({ [keys.records]: records });
}

export async function removeRecordsForTab(tabId) {
  const records = await getRecords();
  let changed = false;
  for (const [recordId, record] of Object.entries(records)) {
    if (record.tabId === tabId) {
      delete records[recordId];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [keys.records]: records });
}

export async function getActivity() {
  const { [keys.activity]: activity = {} } = await chrome.storage.session.get(keys.activity);
  return activity;
}

export async function touchTab(tabId, at = Date.now()) {
  const activity = await getActivity();
  activity[tabId] = at;
  await chrome.storage.session.set({ [keys.activity]: activity });
}

export async function removeActivity(tabId) {
  const activity = await getActivity();
  delete activity[tabId];
  await chrome.storage.session.set({ [keys.activity]: activity });
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
