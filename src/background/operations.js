import { createOperationJournal, sameOperationState } from "../shared/operations.js";
import { addWorkspace, changeWorkspaces, getAllWorkspaces, getWorkspaces, updateWorkspace, validateWorkspaceCapacity } from "../shared/storage.js";

const KEY = "operationJournal";
let queue = Promise.resolve();
export function runOperation(work) {
  const next = queue.catch(() => {}).then(work);
  queue = next;
  return next;
}
export async function getOperations() {
  const data = await chrome.storage.session.get(KEY);
  return data[KEY] || [];
}
const same = sameOperationState;
function sameLayout(current, expected, tabIds) {
  const comparable = (value) => ({
    ...value, tabs: value.tabs.map((tab) => ({ ...tab, url: tabIds.includes(tab.id) ? tab.url : "" }))
  });
  return same(comparable(current), comparable(expected));
}

async function layout(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const groups = await chrome.tabGroups.query({ windowId });
  return {
    tabs: tabs.sort((a, b) => a.index - b.index).map(({ id, url, index, windowId, groupId, pinned }) => ({ id, url, index, windowId, groupId, pinned })),
    groups: groups.sort((a, b) => a.id - b.id).map(({ id, title, color, collapsed }) => ({ id, title, color, collapsed }))
  };
}

export function operationJournal(restoreSuspension) {
  return createOperationJournal({
    read: getOperations,
    write: (entries) => chrome.storage.session.set({ [KEY]: entries }),
    undoItem: async (item) => {
      if (item.kind === "suspension") {
        const result = await restoreSuspension(item.recordId);
        if (!result.ok) throw new Error(result.reason);
        return "已恢复网页";
      }
      if (item.kind === "workspace") {
        const workspaces = await getAllWorkspaces();
        const current = workspaces.find((workspace) => workspace.id === item.after.id);
        if (!same(current, item.after)) throw new Error("工作区已修改或移除，已跳过。");
        const next = item.before
          ? workspaces.map((workspace) => workspace.id === current.id ? item.before : workspace)
          : workspaces.filter((workspace) => workspace.id !== current.id);
        validateWorkspaceCapacity(next);
        await changeWorkspaces(() => next);
        return item.before ? "已恢复工作区状态" : "已撤销保存，标签保持打开";
      }
      if (item.kind !== "group" || !item.after || !sameLayout(await layout(item.windowId), item.after, item.tabIds)) throw new Error("标签顺序、分组或目标页面已变化，已跳过此窗口。");
      const groupMap = new Map();
      await chrome.tabs.ungroup(item.tabIds);
      for (const group of item.before.groups) {
        const ids = item.before.tabs.filter((tab) => tab.groupId === group.id).map((tab) => tab.id);
        const exists = await chrome.tabGroups.get(group.id).catch(() => null);
        const groupId = await chrome.tabs.group(exists ? { tabIds: ids, groupId: group.id } : { tabIds: ids, createProperties: { windowId: item.windowId } });
        if (!exists) await chrome.tabGroups.update(groupId, { title: group.title, color: group.color, collapsed: group.collapsed });
        groupMap.set(group.id, groupId);
      }
      const moved = new Set();
      for (const tab of item.before.tabs) {
        if (tab.groupId === -1) await chrome.tabs.move(tab.id, { index: tab.index });
        else if (!moved.has(tab.groupId)) {
          await chrome.tabGroups.move(groupMap.get(tab.groupId), { index: tab.index });
          moved.add(tab.groupId);
        }
      }
      // Restore member order inside each original group.
      for (const tab of item.before.tabs.filter((tab) => tab.groupId !== -1)) await chrome.tabs.move(tab.id, { index: tab.index });
      return `已恢复 ${item.tabIds.length} 页的分组与顺序`;
    }
  });
}

export async function saveWorkspaceOperation(workspace, journal) {
  if ((await getWorkspaces()).length >= 20) throw new Error("工作区已达 20 个，请先整理已有工作区；此次保存未执行。");
  const entry = await journal.record(`保存工作区 · ${workspace.name}`, [{ kind: "workspace", after: workspace }], "pending");
  await addWorkspace(workspace);
  await journal.finish(entry.id, entry.items);
  return workspace;
}

export async function updateWorkspaceOperation(workspace, update, journal) {
  if (!same((await getAllWorkspaces()).find((item) => item.id === workspace.id), workspace)) throw new Error("工作区已变化，请重试。");
  const after = { ...workspace, ...update };
  validateWorkspaceCapacity((await getAllWorkspaces()).map((item) => item.id === workspace.id ? after : item));
  const entry = await journal.record(`${update.archived ? "归档" : "更新"}工作区 · ${workspace.name}`, [{ kind: "workspace", before: workspace, after }], "pending");
  await updateWorkspace(workspace.id, update);
  await journal.finish(entry.id, entry.items);
  return after;
}

export async function groupOperation(tabIds, title, journal) {
  const tabs = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
  const byWindow = new Map();
  for (const tab of tabs) {
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
    byWindow.get(tab.windowId).push(tab.id);
  }
  const items = [];
  for (const [windowId, ids] of byWindow) {
    if (ids.length >= 2) items.push({ kind: "group", windowId, tabIds: ids, before: await layout(windowId) });
  }
  if (!items.length) return { ok: false, reason: "分组需要同一窗口中的至少两个页面。" };
  const entry = await journal.record(`标签分组 · ${title}`, items, "pending");
  let failure;
  for (const item of items) {
    try {
      const fresh = await Promise.all(item.tabIds.map((id) => chrome.tabs.get(id)));
      if (fresh.some((tab) => tab.pendingUrl || tab.status === "loading" || tab.active || tab.pinned || tab.audible || !/^https?:\/\//.test(tab.url))) throw new Error("页面状态已变化或受保护，未分组。");
      if (!sameLayout(await layout(item.windowId), item.before, item.tabIds)) throw new Error("标签布局已变化，请重试。");
      const groupId = await chrome.tabs.group({ tabIds: item.tabIds, createProperties: { windowId: item.windowId } });
      await chrome.tabGroups.update(groupId, { title, color: "green" });
    } catch (error) { failure = error; }
    item.after = await layout(item.windowId);
  }
  await journal.finish(entry.id, items);
  if (failure) throw new Error(`部分分组未完成：${failure.message} 可在最近操作中撤销。`);
  return { ok: true, count: items.reduce((count, item) => count + item.tabIds.length, 0), operationId: entry.id };
}
