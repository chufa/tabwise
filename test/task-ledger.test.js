import test from "node:test";
import assert from "node:assert/strict";
import { retainTasks, batchLedgerSnapshot, rehydrateTask } from "../src/shared/task-ledger.js";
import { taskNeedsAttention } from "../src/shared/task-state.js";

test("task retention protects active reservations and rejects capacity before eviction", () => {
  const active = { id: "active", status: "running", createdAt: 1 };
  const tasks = [active, ...Array.from({ length: 15 }, (_, i) => ({ id: `${i}`, status: "completed", createdAt: i + 2 }))];
  assert.equal(retainTasks(tasks, 10).length, 10);
  assert.ok(retainTasks(tasks, 10).some((task) => task.id === active.id));
  assert.throws(() => retainTasks(Array.from({ length: 11 }, () => active), 10), /任务/);
});

test("durable batch summaries never retain live browser identifiers or replay parameters", () => {
  const snapshot = batchLedgerSnapshot([{ id: "b", kind: "suspend", status: "running", operationId: "undo", results: [
    { index: 0, status: "executing", tabId: 50, url: "https://secret.test/", undoItems: [{}], title: "Page", size: 2 }
  ] }]);
  assert.equal(snapshot[0].results[0].tabId, undefined);
  assert.equal(snapshot[0].results[0].url, undefined);
  assert.equal(snapshot[0].operationId, undefined);
  const restored = rehydrateTask(snapshot[0], "batch");
  assert.equal(restored.sessionExpired, true);
  assert.equal(restored.results[0].status, "uncertain");
});

test("restore hydration discards stale window and tab bindings while preserving source validation", () => {
  const restored = rehydrateTask({ id: "r", kind: "workspace", sourceId: "source", signature: "content", windowId: 70,
    status: "running", results: [{ index: 1, status: "opening", tabId: 40 }] }, "restore");
  assert.equal(restored.windowId, undefined);
  assert.equal(restored.results[0].tabId, undefined);
  assert.equal(restored.signature, "content");
  assert.equal(restored.results[0].status, "uncertain");
});

test("health attention excludes archived and superseded tasks but includes completed failures", () => {
  assert.equal(taskNeedsAttention({ status: "stopped", archivedAt: 10 }), false);
  assert.equal(taskNeedsAttention({ status: "interrupted", resolvedBy: "retry" }), false);
  assert.equal(taskNeedsAttention({ status: "completed", failed: 1 }), true);
});

test("durable ledger wins after interrupted session mirror write and stale targets never replay", async () => {
  const values = { local: { batchTaskLedger: [{ id: "new", status: "running", results: [{ index: 0, status: "executing" }] }] },
    session: { batchTasks: [{ id: "old", status: "completed", results: [], tabId: 123 }] } };
  const area = (key) => ({
    async get(name) { return { [name]: structuredClone(values[key][name]) }; },
    async set(next) { Object.assign(values[key], structuredClone(next)); }
  });
  globalThis.chrome = { storage: { local: area("local"), session: area("session") } };
  const { createTaskLedger } = await import("../src/background/task-ledger.js");
  const ledger = createTaskLedger("batch");
  const tasks = await ledger.read();
  assert.equal(tasks[0].id, "new");
  assert.equal(tasks[0].status, "interrupted");
  assert.equal(tasks[0].sessionExpired, true);
  values.session.batchTasks = [{ id: "ordered", status: "completed", name: "same", results: [{ index: 0, status: "succeeded", tabId: 100 }] }];
  values.local.batchTaskLedger = [{ results: [{ status: "succeeded", index: 0 }], name: "same", status: "completed", id: "ordered" }];
  const identical = await createTaskLedger("batch").read();
  assert.equal(identical[0].sessionExpired, undefined, "storage key ordering must not expire valid browser bindings");
  assert.equal(identical[0].results[0].tabId, 100);
});
