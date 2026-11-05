import test from "node:test";
import assert from "node:assert/strict";
import { appendDiagnostic, diagnosticBundle, redactDiagnostic } from "../src/shared/diagnostics.js";

test("diagnostics redact URLs and retain only bounded recent records", () => {
  const item = redactDiagnostic({
    source: "worker",
    message: "Failed at https://user:secret@example.test/path?token=123",
    at: 1
  });
  assert.equal(item.message.includes("secret"), false);
  assert.equal(item.message.includes("token"), false);
  assert.equal(item.message.includes("example.test"), true);

  let records = [];
  for (let index = 0; index < 55; index++) records = appendDiagnostic(records, { source: "worker", message: `error ${index}`, at: index });
  assert.equal(records.length, 50);
  assert.equal(records[0].message, "error 54");
});

test("diagnostic bundle excludes browser-private data and declares its schema", () => {
  const bundle = diagnosticBundle({
    extensionVersion: "0.2.2",
    settings: { idleMinutes: 30, trustedDomains: ["private.test"], ollamaEndpoint: "http://127.0.0.1:11434" },
    records: [{ source: "worker", message: "failed", at: 1 }]
  });
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.settings.trustedDomainCount, 1);
  assert.equal("trustedDomains" in bundle.settings, false);
  assert.equal("ollamaEndpoint" in bundle.settings, false);
});
