import { isTaskActive } from "./task-state.js";
import { archiveTaskRecord, retainTasks } from "./task-ledger.js";

const retryStates = new Set(["pending", "failed", "uncertain"]);
const size = (item) => item.size || 1;
export function batchSummary(task) {
  const sum = (states) => task.results.filter((item) => states.includes(item.status)).reduce((count, item) => count + size(item), 0);
  return { ...task, total: task.results.reduce((count, item) => count + size(item), 0),
    count: sum(["succeeded"]), skipped: sum(["skipped"]), failed: sum(["failed", "uncertain"]),
    settled: sum(["succeeded", "skipped", "failed", "uncertain"]), retryable: !task.resolvedBy && !task.sessionExpired && !task.archivedAt && !isTaskActive(task.status) && task.results.some((item) => retryStates.has(item.status)) };
}
export function createBatchRunner({ read, write, execute, finalize = async () => ({}) }) {
  let storageQueue = Promise.resolve(), executionQueue = Promise.resolve();
  const pending = new Map();
  function mutate(work) {
    const next = storageQueue.catch(() => {}).then(async () => {
      const tasks = await read(), result = await work(tasks);
      await write(tasks);
      return result;
    });
    storageQueue = next;
    return next;
  }
  const ready = mutate(async (tasks) => {
    for (const task of tasks.filter((item) => isTaskActive(item.status))) {
      task.status = "interrupted";
      task.reason = "后台已重启，请检查逐项结果后手动重试。";
      for (const item of task.results) if (item.status === "executing") item.status = "uncertain";
      if (!task.sessionExpired) Object.assign(task, await finalize(batchSummary(task)));
    }
  });
  // Startup storage failures are surfaced by every public method.
  ready.catch(() => {});
  async function detail(id) {
    await ready; await storageQueue;
    const task = (await read()).find((item) => item.id === id);
    if (!task) throw new Error("任务记录已移除。");
    return batchSummary(task);
  }
  async function finish(id) {
    const task = await detail(id);
    const metadata = await finalize(task);
    await mutate((tasks) => Object.assign(tasks.find((item) => item.id === id), metadata || {}));
  }
  async function run(id) {
    try {
      await mutate((tasks) => {
        const task = tasks.find((item) => item.id === id);
        if (task.status === "queued") task.status = "running";
      });
      while (true) {
        const batch = await mutate((tasks) => {
          const task = tasks.find((item) => item.id === id);
          if (task.status === "stopping") { task.status = "stopped"; return []; }
          const items = task.results.filter((item) => item.status === "pending").slice(0, task.kind === "group" ? 1 : 5);
          if (!items.length) task.status = "completed";
          for (const item of items) item.status = "executing";
          return structuredClone(items);
        });
        if (!batch.length) break;
        const outcomes = await Promise.all(batch.map(async (item) => {
          try { return await execute(item, await detail(id), (metadata) => mutate((tasks) => {
            Object.assign(tasks.find((task) => task.id === id).results.find((entry) => entry.index === item.index), metadata);
          })); }
          catch (error) { return { ok: false, reason: error.message }; }
        }));
        await mutate((tasks) => {
          const task = tasks.find((item) => item.id === id);
          batch.forEach((item, index) => {
            const result = task.results.find((entry) => entry.index === item.index), outcome = outcomes[index];
            Object.assign(result, outcome, { status: outcome.ok ? "succeeded" : outcome.skipped ? "skipped" : "failed" });
          });
        });
      }
      await finish(id);
    } catch (error) {
      await mutate((tasks) => {
        const task = tasks.find((item) => item.id === id);
        if (!task) return;
        task.status = "interrupted"; task.reason = error.message;
        for (const item of task.results) if (item.status === "executing") item.status = "uncertain";
      }).catch(() => {});
    }
    return detail(id);
  }
  async function start({ name, kind, items, retryOf }) {
    await ready;
    if (!Array.isArray(items) || !items.length || items.length > 5000) throw new Error("批量任务需包含 1–5000 个项目。");
    const id = crypto.randomUUID();
    await mutate((tasks) => {
      const parent = retryOf && tasks.find((task) => task.id === retryOf);
      if (retryOf && (!parent || !batchSummary(parent).retryable)) throw new Error("任务已重试或没有可重试项目。");
      if (tasks.filter((task) => isTaskActive(task.status)).length >= 10) throw new Error("已有 10 项任务进行中，请等待或停止后重试。");
      const task = { id, name, kind, retryOf, createdAt: Date.now(), status: "queued", results: items.map((item, index) => ({ ...item, index: item.index ?? index, status: "pending" })) };
      tasks.unshift(task);
      if (parent) parent.resolvedBy = id;
      // Active reservations may not be evicted.
      tasks.splice(0, tasks.length, ...retainTasks(tasks));
    });
    const promise = executionQueue.catch(() => {}).then(() => run(id));
    executionQueue = promise;
    pending.set(id, promise);
    promise.finally(() => pending.delete(id)).catch(() => {});
    return { ok: true, taskId: id };
  }
  return {
    ready, start, detail,
    async list() { await ready; await storageQueue; return (await read()).map(batchSummary); },
    async wait(id) { return pending.get(id) ? pending.get(id) : detail(id); },
    async stop(id) {
      await ready;
      await mutate((tasks) => {
        const task = tasks.find((item) => item.id === id);
        if (!task) throw new Error("任务记录已移除。");
        if (["queued", "running"].includes(task.status)) task.status = "stopping";
      });
      return { ok: true };
    },
    async archive(id) {
      await detail(id);
      await mutate((tasks) => archiveTaskRecord(tasks.find((task) => task.id === id)));
      return { ok: true };
    },
    async retry(id) {
      const task = await detail(id);
      if (!task.retryable) throw new Error("任务没有可重试项目。");
      const result = await start({ name: task.name, kind: task.kind, retryOf: id, items: task.results.filter((item) => retryStates.has(item.status)).map(({ undoItems, recordId, ok, error, reason, ...item }) => item) });
      return result;
    }
  };
}
