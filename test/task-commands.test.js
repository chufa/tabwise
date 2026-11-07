import test from "node:test";
import assert from "node:assert/strict";
import { createTaskCommands } from "../src/background/task-commands.js";

const batch = { id: "batch", name: "Batch", kind: "suspend", status: "completed", createdAt: 1, total: 1, count: 1, skipped: 0, failed: 0, settled: 1, results: [] };
const restore = { id: "restore", name: "Restore", kind: "workspace", status: "interrupted", createdAt: 2, total: 1, count: 0, skipped: 0, failed: 1, settled: 1, resumable: true, results: [] };

test("task commands route mutations only through the explicit public task type", async () => {
  const calls = [];
  const commands = createTaskCommands({
    batchRunner: { list: async () => [batch], detail: async () => batch, stop: async (id) => { calls.push(["batch-stop", id]); return { ok: true }; }, retry: async (id) => { calls.push(["batch-retry", id]); return { ok: true, taskId: "batch-next" }; } },
    restorer: { list: async () => [restore], detail: async () => restore, stop: async (id) => { calls.push(["restore-stop", id]); return { ok: true }; }, retry: async (id) => { calls.push(["restore-retry", id]); return { ok: true, taskId: "restore-next" }; }, resume: async (id) => { calls.push(["restore-resume", id]); return { ok: true, taskId: "restore-next" }; } }
  });
  await commands.stop({ taskId: "batch", taskType: "batch" });
  await commands.retry({ taskId: "restore", taskType: "restore" });
  await commands.resume({ taskId: "restore", taskType: "restore" });
  assert.deepEqual(calls, [["batch-stop", "batch"], ["restore-retry", "restore"], ["restore-resume", "restore"]]);
  await assert.rejects(commands.stop({ taskId: "batch" }), /任务类型无效/);
  await assert.rejects(commands.resume({ taskId: "batch", taskType: "batch" }), /仅支持恢复任务/);
});

test("task commands provide one public list and detail contract", async () => {
  const commands = createTaskCommands({
    batchRunner: { list: async () => [batch], detail: async () => batch },
    restorer: { list: async () => [restore], detail: async () => ({ ...restore, itemTotal: 1, offset: 0 }) }
  });
  assert.deepEqual((await commands.list()).map((task) => [task.id, task.taskType]), [["restore", "restore"], ["batch", "batch"]]);
  assert.equal((await commands.detail({ taskId: "restore", taskType: "restore" })).kind, "restore");
  assert.equal((await commands.detail({ taskId: "batch", taskType: "batch" })).kind, "suspend");
});
