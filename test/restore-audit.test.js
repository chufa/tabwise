import test from "node:test";
import assert from "node:assert/strict";
import { appendRestoreAudit, restoreAuditSummary } from "../src/shared/restore-audit.js";

test("restore audit records durable lifecycle events with bounded detail", () => {
  let audit = [];
  audit = appendRestoreAudit(audit, "preflight", { total: 3, skipped: 1 });
  audit = appendRestoreAudit(audit, "batch-start", { offset: 0, count: 2 });
  audit = appendRestoreAudit(audit, "interrupted", { reason: "worker restart" });
  assert.equal(audit.length, 3);
  assert.equal(restoreAuditSummary(audit).state, "needs-review");
});
