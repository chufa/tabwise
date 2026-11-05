import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionSnapshot, snapshotSignature, compareSnapshots, sanitizeSavedSnapshot } from "../src/shared/session.js";
import { sourceState } from "../src/shared/restoration.js";

test("captures logical suspended URLs, layout and groups without private pages or stale browser IDs", () => {
  const snapshot = buildSessionSnapshot([
    { id: 1, url: "https://a.test/", windowId: 10, index: 0, pinned: true, active: true, groupId: -1, title: "A" },
    { id: 2, url: "chrome-extension://fixture/src/suspended/suspended.html#sleep", windowId: 10, index: 1, groupId: 42 },
    { id: 3, url: "https://b.test/", windowId: 20, index: 0, discarded: true, title: "B" },
    { id: 4, url: "https://private.test/", incognito: true, windowId: 30 },
    { id: 5, url: "chrome://settings", windowId: 10 }
  ], [{ tabId: 2, recordId: "sleep", originalUrl: "https://sleep.test/", title: "Sleeping" }],
  [{ id: 42, windowId: 10, title: "Research", color: "blue", collapsed: true }], "chrome-extension://fixture");
  assert.equal(snapshot.tabs.length, 3);
  assert.equal(snapshot.windowCount, 2);
  assert.equal(snapshot.tabs[1].url, "https://sleep.test/");
  assert.equal(snapshot.tabs[1].status, "suspended");
  assert.equal(snapshot.tabs[0].pinned, true);
  assert.equal(snapshot.groups[0].color, "blue");
  assert.equal(snapshot.groups[0].collapsed, true);
  assert.ok(snapshot.tabs.every((page) => !("tabId" in page) && !("windowId" in page)));
  assert.doesNotMatch(JSON.stringify(snapshot), /private|chrome:\/\//);
});

test("snapshot signatures preserve order, duplicates and layout changes", () => {
  const a = { tabs: [{ url: "https://a/", pinned: true }, { url: "https://b/" }], groups: [] };
  assert.notEqual(snapshotSignature(a), snapshotSignature({ ...a, tabs: [...a.tabs].reverse() }));
  assert.notEqual(snapshotSignature(a), snapshotSignature({ tabs: [{ url: "https://a/" }, { url: "https://b/" }] }));
  assert.equal(snapshotSignature(a), snapshotSignature({ ...a, id: "other", createdAt: 100 }));
});

test("restore ownership signature detects layout schema changes but ignores access timestamps", () => {
  const source = { id: "layout", schemaVersion: 2, windowCount: 2, tabs: [{ url: "https://a/", windowKey: 0 }] };
  assert.notEqual(sourceState(source), sourceState({ ...source, schemaVersion: 1 }));
  assert.notEqual(sourceState(source), sourceState({ ...source, windowCount: 1 }));
  assert.equal(sourceState(source), sourceState({ ...source, lastOpenedAt: Date.now() }));
});

test("snapshot differences handle duplicate occurrences and include layout changes", () => {
  const before = { tabs: [{ url: "https://a/", pinned: false, windowKey: 0 }, { url: "https://a/", windowKey: 0 }, { url: "https://b/", windowKey: 1 }] };
  const after = { tabs: [{ url: "https://a/", pinned: true, windowKey: 0 }, { url: "https://c/", windowKey: 1 }] };
  const diff = compareSnapshots(before, after);
  assert.deepEqual(diff.removed.map((page) => page.index), [1, 2]);
  assert.equal(diff.added[0].url, "https://c/");
  assert.equal(diff.changed[0].url, "https://a/");
});

test("snapshot differences include active page and group metadata changes", () => {
  const before = { tabs: [{ url: "https://a/", active: true, groupKey: "g" }], groups: [{ key: "g", title: "Work", color: "blue", collapsed: false }] };
  assert.equal(compareSnapshots(before, { ...before, tabs: [{ ...before.tabs[0], active: false }] }).changed.length, 1);
  assert.equal(compareSnapshots(before, { ...before, groups: [{ ...before.groups[0], collapsed: true }] }).changed.length, 1);
});

test("1000 duplicate pages preserve ordinal layout and title changes in diffs", () => {
  const tabs = Array.from({ length: 1000 }, (_, i) => ({ id: i, title: `Page ${i}`, url: "https://same.test/", windowId: Math.floor(i / 100), index: i % 100, groupId: i % 10 }));
  const snapshot = buildSessionSnapshot(tabs);
  assert.equal(snapshot.tabs.length, 1000);
  assert.equal(snapshot.tabs[999].index, 99);
  const next = structuredClone(snapshot);
  next.tabs[500].title = "Changed title";
  assert.equal(compareSnapshots(snapshot, next).changed.length, 1);
});

test("backup imports retain bounded layout metadata and accept older URL-only workspaces", () => {
  const saved = { schemaVersion: 2, tabs: [
    { title: "A", url: "https://a/", pinned: true, windowKey: 8, index: 0, active: true },
    { title: "Sleeping", url: "https://sleep/", status: "suspended", groupKey: "old", windowKey: 8, index: 1 },
    { url: "chrome://settings", windowKey: 8, index: 2 },
    { url: "https://private/", incognito: true, windowKey: 8, index: 3 },
    { url: "https://b/", windowKey: 99, index: 0, active: true }
  ], groups: [{ key: "old", windowKey: 8, color: "blue", title: "Research", collapsed: true }, { key: "ignored", windowKey: 1 }] };
  const clean = sanitizeSavedSnapshot(saved);
  assert.equal(clean.windowCount, 2);
  assert.equal(clean.tabs.length, 3);
  assert.equal(clean.tabs[1].status, "suspended");
  assert.equal(clean.tabs[0].pinned, true);
  assert.equal(clean.groups[0].collapsed, true);
  assert.equal(clean.groups[0].color, "blue");
  assert.deepEqual(clean.tabs.map((item) => item.windowKey), [0, 0, 1]);
  assert.ok(!JSON.stringify(clean).includes("private"));
  assert.deepEqual(sanitizeSavedSnapshot({ tabs: [{ url: "https://old/", title: "Old" }] }), { tabs: [{ title: "Old", url: "https://old/" }] });
});
