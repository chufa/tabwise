import test from "node:test";
import assert from "node:assert/strict";
import { resolveSavedResult, selectedRestorePages, sourceState } from "../src/shared/restoration.js";
import { rotationBatch, mapConcurrent, mergeHeapSamples } from "../src/shared/scanning.js";
import { editWorkspace, mergeWorkspaces } from "../src/shared/workspaces.js";
import { createReviewRunner } from "../src/shared/review-runner.js";

const source = { id: "research", name: "研究", tabs: [{ title: "A", url: "https://a.test/" }, { title: "B", url: "https://b.test/" }] };
test("resolves only the exact saved search member and rejects stale or forged indices", () => {
  assert.equal(resolveSavedResult({ source: "workspace", id: "workspace:research:1", url: "https://b.test/" }, source).url, "https://b.test/");
  for (const result of [
    { source: "workspace", id: "workspace:research:2" },
    { source: "checkpoint", id: "workspace:research:1" },
    { source: "workspace", id: "workspace:research:1", url: "https://changed.test/" }
  ]) assert.throws(() => resolveSavedResult(result, source));
});
test("restores selected indices, skips existing and selected duplicates, preserves URL fragments", () => {
  const pages = [...source.tabs, source.tabs[0], { url: "https://a.test/#section" }];
  assert.deepEqual(selectedRestorePages(pages, [0, 1, 2, 3], new Set(["https://b.test/"]), true).map((page) => page.action), ["open", "skip", "skip", "open"]);
  assert.throws(() => selectedRestorePages(pages, [], new Set(), true), /至少/);
  assert.throws(() => selectedRestorePages(pages, [9], new Set(), true));
  assert.equal(sourceState(source), sourceState({ ...source, lastOpenedAt: 10 }));
  assert.notEqual(sourceState(source), sourceState({ ...source, tabs: [...source.tabs].reverse() }));
});
test("rotates across more than fifty tabs, survives removals and avoids repeated prefixes", () => {
  const tabs = Array.from({ length: 123 }, (_, id) => ({ id: id + 1 }));
  const first = rotationBatch(tabs, 0, 50);
  const second = rotationBatch(tabs, first.cursor, 50);
  const third = rotationBatch(tabs, second.cursor, 50);
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map((tab) => tab.id)).size, 123);
  assert.equal(rotationBatch(tabs.filter((tab) => tab.id !== 50), 50, 25).items[0].id, 51);
});
test("bounds asynchronous sampling concurrency", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapConcurrent(Array.from({ length: 25 }, (_, index) => index), 4, async (value) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return value * 2;
  });
  assert.equal(peak, 4);
  assert.equal(result[24], 48);
});
test("merges partial sampling without erasing untouched pages and prunes stale pages", () => {
  const old = { 1: { url: "https://a/", usedJSHeapSize: 10 }, 2: { url: "https://b/", usedJSHeapSize: 20 }, 3: { url: "https://c/", usedJSHeapSize: 30 } };
  const next = mergeHeapSamples(old, [{ id: 1, url: "https://a/" }, { id: 2, url: "https://changed/" }, { id: 4, url: "https://d/", discarded: true }], [{ tabId: 1, url: "https://a/", heap: { usedJSHeapSize: 11 } }, { tabId: 2, url: "https://b/", heap: { usedJSHeapSize: 50 } }], 100);
  assert.deepEqual(Object.keys(next), ["1"]);
  assert.equal(next[1].usedJSHeapSize, 11);
  assert.equal(mergeHeapSamples(old, [{ id: 1, url: "https://a/" }], [], 100)[1].usedJSHeapSize, 10);
});
test("workspace editing validates member indices and merging deduplicates without mutating sources", () => {
  assert.deepEqual(editWorkspace(source, " 新名 ", [1]).tabs, [source.tabs[1]]);
  assert.throws(() => editWorkspace(source, "", [0]));
  assert.throws(() => editWorkspace(source, "name", []));
  assert.throws(() => editWorkspace(source, "name", [100]));
  const merged = mergeWorkspaces([source, { ...source, id: "other", tabs: [source.tabs[1], { url: "https://c.test/" }] }], "合并");
  assert.equal(merged.tabs.length, 3);
  assert.equal(source.tabs.length, 2);
});
test("review runner reserves before effects, records failures, deduplicates slots and permits explicit retry", async () => {
  let entries = [];
  let effects = 0;
  const runner = createReviewRunner({
    read: async () => structuredClone(entries), write: async (next) => { entries = structuredClone(next); },
    execute: async () => { effects++; assert.equal(entries[0].status, "running"); throw new Error("fixture failure"); }
  });
  const failure = await runner.run("scheduled", { scheduledSlot: 100 });
  assert.equal(failure.ok, false);
  assert.equal(entries[0].status, "failed");
  assert.match(entries[0].error, /fixture failure/);
  await runner.run("scheduled", { scheduledSlot: 100 });
  assert.equal(effects, 1);
  await runner.run("retry", { retryOf: failure.review.id });
  assert.equal(effects, 2);
  assert.equal(entries[0].retryOf, failure.review.id);
});
test("worker restart marks incomplete reviews interrupted without replaying actions", async () => {
  let entries = [{ id: "unfinished", status: "running", createdAt: 1 }];
  const runner = createReviewRunner({
    read: async () => entries, write: async (next) => { entries = next; },
    execute: async () => { throw new Error("must not execute"); }
  });
  await runner.ready;
  assert.equal(entries[0].status, "interrupted");
});
