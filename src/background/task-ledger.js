import { queueStorage } from "../shared/storage.js";
import { batchLedgerSnapshot, rehydrateTask, retainTasks } from "../shared/task-ledger.js";
import { canonicalJSON } from "../shared/backup.js";

// local is the durable authority; session keeps current-session browser bindings.
export function createTaskLedger(taskType) {
  const sessionKey = taskType === "batch" ? "batchTasks" : "restoreTasks";
  const localKey = taskType === "batch" ? "batchTaskLedger" : "restoreTaskLedger";
  const write = async (tasks) => {
    const bounded = retainTasks(tasks);
    await queueStorage("local", () => chrome.storage.local.set({
      [localKey]: taskType === "batch" ? batchLedgerSnapshot(bounded) : bounded
    }));
    await chrome.storage.session.set({ [sessionKey]: bounded });
  };
  const ready = queueStorage("session", async () => {
    const current = await chrome.storage.session.get(sessionKey);
    const saved = await chrome.storage.local.get(localKey);
    const durable = Array.isArray(saved[localKey]) ? saved[localKey] : [];
    const session = current[sessionKey];
    const mirror = Array.isArray(session) ? taskType === "batch" ? batchLedgerSnapshot(session) : session : null;
    // A local reservation may have committed just before the worker lost its mirror.
    // Use it conservatively instead of trusting older browser bindings.
    const diverged = Array.isArray(saved[localKey]) && canonicalJSON(mirror) !== canonicalJSON(durable);
    const tasks = Array.isArray(session) && !diverged ? session : durable.map((task) => rehydrateTask(task, taskType));
    await write(tasks);
  });
  ready.catch(() => {});
  return {
    ready, write,
    async read() { await ready; return (await chrome.storage.session.get(sessionKey))[sessionKey] || []; }
  };
}
