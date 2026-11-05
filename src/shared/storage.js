import { DEFAULT_SETTINGS, SCHEMA_VERSION } from "./constants.js";
import { snapshotSignature } from "./session.js";

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
  workspaces: "workspaces"
});

function sortWorkspaces(workspaces) {
  workspaces.sort((left, right) => Number(Boolean(left.archived)) - Number(Boolean(right.archived))
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

export function putRecord(record) {
  return queueStorage("local", async () => {
  const { [keys.records]: records = {}, [keys.restoreRecords]: restoreRecords = {} } = await chrome.storage.local.get([keys.records, keys.restoreRecords]);
  const nextRecord = { schemaVersion: SCHEMA_VERSION, ...record };
  records[record.recordId] = nextRecord;
  restoreRecords[record.recordId] = nextRecord;
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
