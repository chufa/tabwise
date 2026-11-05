import test from "node:test";
import assert from "node:assert/strict";
import { createBatchRunner } from "../src/shared/batch.js";

const items = Array.from({ length: 12 }, (_, index) => ({ index, tabId: index, url: `https://batch.test/${index}`, title: `Page ${index}` }));
test("batch runner reserves before effects, limits concurrency, stops promptly and retries only failures/pending", async () => {
  let tasks = [], release, active = 0, peak = 0, calls = [];
  const hold = new Promise((resolve) => { release = resolve; });
  const runner = createBatchRunner({
    read: async () => structuredClone(tasks), write: async (next) => { tasks = structuredClone(next); },
    execute: async (item) => {
      assert.ok(tasks.some((task) => task.results.find((page) => page.index === item.index)?.status === "executing"));
      active++; peak = Math.max(peak, active); calls.push(item.index);
      await hold; active--;
      return item.index === 1 && calls.filter((index) => index === 1).length === 1 ? { ok: false, reason: "failure" } : { ok: true, recordId: `r${item.index}` };
    }
  });
  const started = await runner.start({ name: "Batch", kind: "suspend", items });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 5);
  await runner.stop(started.taskId);
  release();
  const stopped = await runner.wait(started.taskId);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.count, 4);
  assert.equal(stopped.failed, 1);
  assert.equal(calls.length, 5);
  assert.equal(peak, 5);
  const retried = await runner.retry(started.taskId);
  const done = await runner.wait(retried.taskId);
  assert.equal(done.count, 8);
  assert.deepEqual(calls.slice(5).sort((a, b) => a - b), [1, 5, 6, 7, 8, 9, 10, 11]);
});
test("worker restart marks uncertain effects without replay; explicit retry revalidates at execution", async () => {
  let tasks = [{ id: "crashed", name: "Crash", kind: "suspend", status: "running", results: [
    { ...items[0], status: "succeeded" }, { ...items[1], status: "executing" }, { ...items[2], status: "pending" }
  ] }];
  let calls = 0;
  const runner = createBatchRunner({
    read: async () => structuredClone(tasks), write: async (next) => { tasks = structuredClone(next); },
    execute: async () => { calls++; return { ok: false, skipped: true, reason: "页面已变化" }; }
  });
  await runner.ready;
  assert.equal(tasks[0].status, "interrupted");
  assert.equal(tasks[0].results[1].status, "uncertain");
  assert.equal(calls, 0);
  const retry = await runner.retry("crashed");
  assert.equal((await runner.wait(retry.taskId)).skipped, 2);
  assert.equal(calls, 2);
});
test("reservation failure prevents effects and failed finalization stays visible", async () => {
  let effects = 0;
  const runner = createBatchRunner({ read: async () => [], write: async () => { throw new Error("quota"); }, execute: async () => { effects++; } });
  await assert.rejects(runner.start({ items, name: "Fail" }), /quota/);
  assert.equal(effects, 0);
});

test("group effect evidence is durable before mutations and remains available after finalization failure", async () => {
  let tasks = [];
  const runner = createBatchRunner({
    read: async () => structuredClone(tasks), write: async (next) => { tasks = structuredClone(next); },
    execute: async (item, task, remember) => {
      await remember({ undoItems: [{ before: "original", after: "changed" }] });
      assert.equal(tasks[0].results[0].undoItems[0].before, "original");
      return { ok: true };
    },
    finalize: async () => { throw new Error("journal unavailable"); }
  });
  const task = await runner.start({ kind: "group", name: "Group", items: [{ size: 3, pages: [] }] });
  const result = await runner.wait(task.taskId);
  assert.equal(result.status, "interrupted");
  assert.equal(result.count, 3);
  assert.equal(result.results[0].undoItems[0].after, "changed");
  assert.match(result.reason, /journal/);
});
