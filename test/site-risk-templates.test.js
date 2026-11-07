import test from "node:test";
import assert from "node:assert/strict";
import { SITE_RISK_TEMPLATES, applySiteRiskTemplate } from "../src/shared/policy.js";

test("risk templates are explicit and do not overwrite an existing stricter policy", () => {
  assert.ok(SITE_RISK_TEMPLATES.some((template) => template.id === "collaboration"));
  const next = applySiteRiskTemplate({ blockedDomains: ["mail.example"], manualDomains: ["docs.example"] }, "collaboration", ["docs.example", "meet.example"]);
  assert.deepEqual(next.manualDomains.sort(), ["docs.example", "meet.example"]);
  assert.deepEqual(next.blockedDomains, ["mail.example"]);
});

test("site templates reject unsafe domain input", () => {
  assert.throws(() => applySiteRiskTemplate({}, "collaboration", ["javascript:alert(1)"]), /域名/);
});

test("site templates allow valid private IPv4 hosts", () => {
  const result = applySiteRiskTemplate({}, "collaboration", ["127.0.0.1"]);
  assert.deepEqual(result.manualDomains, ["127.0.0.1"]);
});
