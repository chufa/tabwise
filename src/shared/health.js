import { taskNeedsAttention } from "./task-state.js";

const DEFAULT_QUOTA = 10 * 1024 * 1024;

export function buildHealth({ bytesInUse = 0, quotaBytes = DEFAULT_QUOTA, sync = {}, tasks = [], restoreTasks = [] } = {}) {
  const ratio = quotaBytes ? bytesInUse / quotaBytes : 0;
  const taskList = tasks.length ? tasks : restoreTasks.map((task) => ({ ...task, taskType: "restore" }));
  const pendingTasks = taskList.filter(taskNeedsAttention);
  const pending = pendingTasks.filter((task) => task.taskType === "restore").length;
  const pendingBatch = pendingTasks.filter((task) => task.taskType === "batch").length;
  return {
    storage: { bytesInUse, quotaBytes, ratio, level: ratio >= .9 ? "critical" : ratio >= .75 ? "warning" : "ok" },
    sync: { revision: Number(sync.revision) || 0, updatedAt: Number(sync.updatedAt) || 0 },
    restore: { pending, level: pending ? "warning" : "ok" },
    tasks: { pending: pendingTasks.length, batch: pendingBatch, restore: pending, level: pendingTasks.length ? "warning" : "ok" }
  };
}
