import test from "node:test";
import assert from "node:assert/strict";
import { SITE_RISK_TEMPLATES, applySiteRiskTemplate } from "../src/shared/policy.js";

test("risk templates are explicit and do not overwrite an existing stricter policy", () => {
  assert.ok(SITE_RISK_TEMPLATES.some((template) => template.id === "collaboration"));
  const next = applySiteRiskTemplate({ blockedDomains: ["mail.example"], manualDomains: ["docs.example"] }, "collaboration", ["docs.example", "meet.example"]);
  assert.deepEqual(next.manualDomains.sort(), ["docs.example", "meet.example"]);
  assert.deepEqual(next.blockedDomains, ["mail.example"]);
});
