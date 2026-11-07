import { isTaskActive } from "./task-state.js";

export function retainTasks(tasks, limit = 10) {
  const active = tasks.filter((task) => isTaskActive(task.status));
  if (active.length > limit) throw new Error("进行中的任务超过容量限制。");
  const recent = tasks.filter((task) => !isTaskActive(task.status)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return [...active, ...recent.slice(0, limit - active.length)].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

const pick = (value, fields) => Object.fromEntries(fields.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
export const batchLedgerSnapshot = (tasks) => tasks.map((task) => ({
  ...pick(task, ["id", "name", "kind", "status", "createdAt", "updatedAt", "archivedAt", "resolvedBy", "retryOf", "reason", "sessionExpired"]),
  results: task.results.map((item) => pick(item, ["index", "size", "status", "title", "reason"]))
}));

export function rehydrateTask(task, taskType) {
  const next = structuredClone(task);
  delete next.windowId;
  delete next.operationId;
  if (taskType === "batch") next.sessionExpired = true;
  if (isTaskActive(next.status)) next.status = "interrupted";
  next.reason = taskType === "batch" ? "浏览器会话已结束；仅保留结果摘要，请重新预览当前页面后操作。" : "浏览器会话已结束；继续前会重新检查保存来源和当前页面。";
  next.results = next.results.map((item) => {
    const result = { ...item };
    for (const key of ["tabId", "windowId", "recordId", "undoItems"]) delete result[key];
    if (["opening", "executing"].includes(result.status)) result.status = "uncertain";
    return result;
  });
  return next;
}

export function archiveTaskRecord(task) {
  if (isTaskActive(task.status)) throw new Error("请先停止或等待任务结束后归档。");
  task.archivedAt = Date.now();
}
