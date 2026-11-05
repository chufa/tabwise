import test from "node:test";
import assert from "node:assert/strict";
import { createBackup, readBackup, backupFingerprint, BACKUP_LIMITS } from "../src/shared/backup.js";
import { sanitizeSavedSnapshot } from "../src/shared/session.js";
import { mergeWorkspaces } from "../src/shared/workspaces.js";

const snapshot = (count = 1000) => ({
  schemaVersion: 2, windowCount: 10,
  tabs: Array.from({ length: count }, (_, i) => ({ title: `页面 ${i}`, url: `https://backup.test/${i}`,
    windowKey: Math.floor(i / 100), index: i % 100, pinned: i % 100 === 0, active: i % 100 === 0,
    status: i % 2 ? "suspended" : "open", groupKey: `g${Math.floor(i / 100)}` })),
  groups: Array.from({ length: Math.ceil(count / 100) }, (_, i) => ({ key: `g${i}`, windowKey: i, title: `研究 ${i}`, color: "blue", collapsed: true }))
});
const workspace = () => ({ ...snapshot(), id: "original", name: "研究", createdAt: 123, pinned: true,
  versions: Array.from({ length: 5 }, (_, i) => ({ ...snapshot(300), id: `v${i}`, createdAt: i + 1 })) });

test("backup retains 1000 pages, suspended layout and all five versions", async () => {
  assert.equal(sanitizeSavedSnapshot(snapshot()).tabs.length, 1000);
  const original = workspace();
  const backup = await createBackup({ settings: { idleMinutes: 30 }, workspaces: [original] });
  const decoded = await readBackup(JSON.parse(JSON.stringify(backup)));
  assert.equal(decoded.verified, true);
  assert.equal(decoded.workspaces[0].tabs.length, 1000);
  assert.equal(decoded.workspaces[0].windowCount, 10);
  assert.equal(decoded.workspaces[0].tabs[999].status, "suspended");
  assert.equal(decoded.workspaces[0].groups.length, 10);
  assert.equal(decoded.workspaces[0].versions.length, 5);
  assert.equal(decoded.workspaces[0].versions[4].tabs.length, 300);
  assert.equal(decoded.workspaces[0].id, "original");
  assert.equal(decoded.workspaces[0].createdAt, 123);
  assert.equal(backup.integrity.counts.historyPages, 1500);
  assert.equal(await backupFingerprint(decoded.workspaces[0]), await backupFingerprint(original));
});

test("checksum detects page title, layout, settings and manifest count corruption", async () => {
  const backup = await createBackup({ settings: { idleMinutes: 30 }, workspaces: [workspace()] });
  for (const corrupt of [
    (b) => { b.payload.workspaces[0].tabs[999].url = "https://changed.test/"; },
    (b) => { b.payload.workspaces[0].groups[0].color = "red"; },
    (b) => { b.payload.settings.idleMinutes = 5; },
    (b) => { b.integrity.counts.pages = 1; }
  ]) {
    const copy = structuredClone(backup); corrupt(copy);
    await assert.rejects(readBackup(copy), /校验/);
  }
});

test("legacy backup reports filtered pages and has explicit size limits instead of truncation", async () => {
  const legacy = { schemaVersion: 1, workspaces: [{ ...snapshot(300), name: "旧备份",
    tabs: [...snapshot(300).tabs, { url: "javascript:alert(1)" }, { url: "https://private.test/", incognito: true }] }] };
  const result = await readBackup(legacy);
  assert.equal(result.verified, false);
  assert.equal(result.workspaces[0].tabs.length, 300);
  assert.ok(result.warnings.some((text) => text.includes("2")));
  await assert.rejects(readBackup({ schemaVersion: 1, workspaces: [{ tabs: snapshot(BACKUP_LIMITS.pagesPerSnapshot + 1).tabs }] }), /上限/);
  await assert.rejects(readBackup({ schemaVersion: 1, workspaces: [], settings: { extra: "x".repeat(BACKUP_LIMITS.bytes) } }), /大小/);
});

test("merging layout snapshots preserves window boundaries, duplicate occurrences, source versions and group membership", async () => {
  const a = { ...snapshot(2), id: "a", name: "A", versions: [{ ...snapshot(1), id: "v", createdAt: 1 }] };
  const b = { ...snapshot(2), id: "b", name: "B" };
  const merged = mergeWorkspaces([a, b], "合并");
  assert.equal(merged.schemaVersion, 2);
  assert.equal(merged.windowCount, 2);
  assert.equal(merged.tabs.length, 4);
  assert.notEqual(merged.tabs[0].groupKey, merged.tabs[2].groupKey);
  assert.deepEqual(merged.tabs.map((p) => p.windowKey), [0, 0, 1, 1]);
  assert.equal(merged.mergeSources[0].versions[0].tabs.length, 1);
  const roundTrip = await readBackup(await createBackup({ workspaces: [merged] }));
  assert.equal(roundTrip.workspaces[0].mergeSources[0].versions.length, 1);
  assert.equal(a.tabs.length, 2);
});
