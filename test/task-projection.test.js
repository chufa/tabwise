import test from "node:test";
import assert from "node:assert/strict";
import { projectTaskDetail, projectTasks } from "../src/shared/task-projection.js";

const batch = {
  id: "batch-1", name: "批量休眠", kind: "suspend", status: "completed", createdAt: 100,
  total: 3, count: 2, skipped: 1, failed: 0, settled: 3, retryable: false,
  operationId: "operation-1",
  results: [{ index: 0, title: "First", status: "succeeded" }, { index: 1, title: "Second", status: "skipped" }]
};
const restore = {
  id: "restore-1", name: "工作区", kind: "workspace", status: "interrupted", createdAt: 200,
  total: 2, count: 1, skipped: 0, failed: 1, settled: 2, retryable: true, resumable: true,
  sourceId: "private-source", signature: "private-signature", indices: [0, 1],
  audit: [{ type: "interrupted", at: 123 }],
  results: [{ index: 0, title: "Open", status: "opened" }, { index: 1, title: "Retry", status: "failed", reason: "network" }]
};

test("task projection creates a stable, sorted list without implementation records", () => {
  const tasks = projectTasks({ batchTasks: [batch], restoreTasks: [restore] });
  assert.deepEqual(tasks, [
    { id: "restore-1", name: "工作区", kind: "restore", taskType: "restore", status: "interrupted", createdAt: 200,
      total: 2, count: 1, skipped: 0, failed: 1, settled: 2, retryable: true, resumable: true },
    { id: "batch-1", name: "批量休眠", kind: "suspend", taskType: "batch", status: "completed", createdAt: 100,
      total: 3, count: 2, skipped: 1, failed: 0, settled: 3, retryable: false, resumable: false, operationId: "operation-1" }
  ]);
});

test("task detail keeps only the requested page results and approved audit trail", () => {
  const detail = projectTaskDetail(restore, { taskType: "restore", offset: 1, pageSize: 1 });
  assert.deepEqual(detail, {
    ok: true, id: "restore-1", name: "工作区", kind: "restore", taskType: "restore", status: "interrupted", createdAt: 200,
    total: 2, count: 1, skipped: 0, failed: 1, settled: 2, retryable: true, resumable: true,
    itemTotal: 2, offset: 1, results: [{ index: 1, title: "Retry", status: "failed", reason: "network" }],
    audit: [{ type: "interrupted", at: 123 }]
  });
});

test("task detail preserves upstream pagination metadata without slicing it twice", () => {
  const detail = projectTaskDetail({ ...restore, itemTotal: 120, offset: 50, results: [restore.results[1]] }, {
    taskType: "restore", offset: 50, resultsArePaged: true
  });
  assert.deepEqual({ itemTotal: detail.itemTotal, offset: detail.offset, results: detail.results }, {
    itemTotal: 120, offset: 50, results: [{ index: 1, title: "Retry", status: "failed", reason: "network" }]
  });
});

test("task projection has deterministic ordering when creation times match", () => {
  const tasks = projectTasks({ batchTasks: [{ ...batch, id: "z", createdAt: 300 }], restoreTasks: [{ ...restore, id: "a", createdAt: 300 }] });
  assert.deepEqual(tasks.map((task) => task.id), ["a", "z"]);
});
