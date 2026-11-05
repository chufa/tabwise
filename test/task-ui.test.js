import test from "node:test";
import assert from "node:assert/strict";
import { taskCounts } from "../src/shared/task-ui.js";

test("restore source kinds retain opened counts while batch tasks report completed effects", () => {
  const counts = { count: 3, skipped: 1, failed: 2 };
  for (const kind of ["workspace", "checkpoint", "restore", undefined]) assert.equal(taskCounts({ ...counts, kind }), "已打开 3 页 · 跳过 1 页 · 失败 2 页");
  for (const kind of ["group", "suspend", "budget"]) assert.equal(taskCounts({ ...counts, kind }), "已完成 3 页 · 跳过 1 页 · 失败 2 页");
});
