import test from "node:test";
import assert from "node:assert/strict";
import { samplingPlan, samplingBatch } from "../src/shared/sampling-policy.js";
import { inheritPageTags, normalizeRestorePreset, restoreTagIndices } from "../src/shared/workspace-presets.js";
import { editWorkspace } from "../src/shared/workspaces.js";
import { createBackup, readBackup } from "../src/shared/backup.js";

test("sampling modes adapt to foreground, tab counts and recent activity without starving rotation", () => {
  assert.equal(samplingPlan({ mode: "off" }).enabled, false);
  assert.ok(samplingPlan({ mode: "low" }).intervalMs > samplingPlan({ mode: "normal", foreground: true }).intervalMs);
  assert.equal(samplingPlan({ count: 300 }).size, 15);
  assert.equal(samplingPlan({ mode: "low" }).concurrency, 2);
  const tabs = Array.from({ length: 60 }, (_, id) => ({ id }));
  const batch = samplingBatch(tabs, 0, 12, { 50: 999 }, {}, 1000);
  assert.equal(batch.items[0].id, 50);
  assert.ok(batch.items.some((item) => item.id === 1));
  assert.ok(batch.items.length <= 12);
  assert.ok(batch.cursor > 0);
});
test("incremental workspace updates retain tags by URL occurrence without mixing duplicates", () => {
  const saved = [{ url: "https://same.test", tags: ["a"] }, { url: "https://same.test", tags: ["b"] }];
  const next = inheritPageTags([{ url: "https://same.test" }, { url: "https://same.test" }, { url: "https://new.test" }], saved);
  assert.deepEqual(next.map((page) => page.tags), [["a"], ["b"], undefined]);
});
test("workspace presets and page tags validate, select across pages and survive backups", async () => {
  const preset = normalizeRestorePreset({ loadMode: "on-demand", concurrency: 2, restoreLayout: true, tag: "研究" });
  assert.throws(() => normalizeRestorePreset({ concurrency: 6 }), /1–5/);
  const workspace = { id: "w", name: "W", tabs: [{ title: "A", url: "https://a.test" }, { title: "B", url: "https://b.test" }] };
  const update = editWorkspace(workspace, "W", [0, 1], { restorePreset: preset, pageTags: { 1: ["研究"] } });
  assert.deepEqual(restoreTagIndices(update.tabs, "研究"), [1]);
  const backup = await createBackup({ workspaces: [{ ...workspace, ...update }] });
  const read = await readBackup(backup);
  assert.equal(read.workspaces[0].restorePreset.concurrency, 2);
  assert.deepEqual(read.workspaces[0].tabs[1].tags, ["研究"]);
});
