import test from "node:test";
import assert from "node:assert/strict";
import { workspaceMetadata, workspaceContentSignature, filterWorkspaces, normalizeWorkspaceFilters } from "../src/shared/workspace-metadata.js";
import { editWorkspace } from "../src/shared/workspaces.js";
import { createBackup, readBackup, backupFingerprint } from "../src/shared/backup.js";
import { buildSyncMetadata, planSyncMetadata, resolveSyncPlan } from "../src/shared/sync-metadata.js";
import { sourceState } from "../src/shared/restoration.js";

const workspace = { id: "a", name: "研究", tabs: [{ url: "https://example.test", title: "论文" }], tags: ["AI"], notes: "待阅读", favorite: true };
test("workspace edit validates metadata and stale signatures include metadata but ignore access time", () => {
  assert.deepEqual(workspaceMetadata({ tags: [" AI ", "AI", "笔记"] }).tags, ["AI", "笔记"]);
  assert.throws(() => workspaceMetadata({ tags: Array.from({ length: 13 }, (_, i) => `${i}`) }), /标签/);
  assert.throws(() => workspaceMetadata({ notes: "x".repeat(2001) }), /备注/);
  assert.equal(editWorkspace(workspace, "研究", [0], { notes: "完成", tags: ["读完"], favorite: false }).notes, "完成");
  assert.equal(editWorkspace(workspace, "研究", [0]).favorite, true);
  assert.notEqual(sourceState(workspace), sourceState({ ...workspace, notes: "改动" }));
  assert.equal(sourceState(workspace), sourceState({ ...workspace, lastOpenedAt: 9 }));
});
test("backup preserves private notes and metadata differences prevent duplicate suppression", async () => {
  const decoded = await readBackup(await createBackup({ workspaces: [workspace] }));
  assert.equal(decoded.workspaces[0].notes, "待阅读");
  assert.deepEqual(decoded.workspaces[0].tags, ["AI"]);
  assert.equal(decoded.workspaces[0].favorite, true);
  assert.notEqual(await backupFingerprint(workspace), await backupFingerprint({ ...workspace, notes: "完成" }));
});
test("sync detects metadata conflicts while keeping notes local", () => {
  const metadata = buildSyncMetadata({ workspaces: [workspace] });
  assert.equal("notes" in metadata.workspaces[0], false);
  const incoming = { ...metadata, workspaces: [{ ...metadata.workspaces[0], favorite: false, name: "新研究" }] };
  const plan = planSyncMetadata({ workspaces: [workspace] }, incoming);
  const conflict = plan.conflicts.find((c) => c.kind === "workspace");
  assert.ok(conflict);
  assert.equal(resolveSyncPlan(plan, { [conflict.id]: "remote" }).workspaces[0].notes, "待阅读");
  assert.equal(workspaceContentSignature(workspace), workspaceContentSignature({ ...workspace, notes: "本机修改" }));
});
test("workspace filters match notes, tags and favorites and have bounded persistence", () => {
  assert.equal(filterWorkspaces([workspace], { query: "待阅读", tag: "AI", favorite: true }).length, 1);
  assert.equal(filterWorkspaces([workspace], { tag: "其它" }).length, 0);
  assert.equal(filterWorkspaces([{ ...workspace, archived: true }], { status: "active" }).length, 0);
  assert.throws(() => normalizeWorkspaceFilters(Array.from({ length: 11 }, (_, i) => ({ name: `${i}` }))), /筛选/);
  assert.deepEqual(normalizeWorkspaceFilters([{ name: " 收藏 ", favorite: true }])[0],
    { name: "收藏", query: "", tag: "", favorite: true, status: "all" });
});
