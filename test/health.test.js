import test from "node:test";
import assert from "node:assert/strict";
import { buildHealth } from "../src/shared/health.js";

test("health marks storage quota and incomplete unified tasks without exposing page data", () => {
  const health = buildHealth({
    bytesInUse: 9 * 1024 * 1024, quotaBytes: 10 * 1024 * 1024,
    sync: { revision: 4, updatedAt: 10 },
    tasks: [{ taskType: "restore", status: "interrupted" }, { taskType: "batch", status: "stopped" }, { taskType: "batch", status: "completed" }]
  });
  assert.equal(health.storage.level, "critical");
  assert.equal(health.restore.pending, 1);
  assert.deepEqual(health.tasks, { pending: 2, batch: 1, restore: 1, level: "warning" });
  assert.equal(health.sync.revision, 4);
  assert.equal("urls" in health, false);
});
