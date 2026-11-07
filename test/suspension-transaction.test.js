import test from "node:test";
import assert from "node:assert/strict";
import { suspensionTransaction } from "../src/shared/suspension-transaction.js";

test("post-effect quota failure retains durable recovery even when the API result is ambiguous", async () => {
  for (const apiReject of [false, true]) {
    let saved, effects = 0;
    const result = await suspensionTransaction({
      record: { recordId: "r", originalUrl: "https://recover.test" },
      reserve: async (record) => { saved = record; }, validate: async () => {},
      apply: async () => { effects++; if (apiReject) throw new Error("worker disconnected"); return "placeholder"; },
      finish: async () => { throw new Error("quota"); }, remove: async () => { saved = null; },
      inspect: async () => "applied"
    });
    assert.equal(result.ok, true);
    assert.equal(result.recoveryRetained, true);
    assert.equal(saved.originalUrl, "https://recover.test");
    assert.equal(effects, 1);
  }
});
test("failed reservation prevents browser mutations; unchanged failures clean up", async () => {
  let effects = 0, removals = 0;
  const base = { record: { recordId: "r" }, reserve: async () => {}, validate: async () => {},
    apply: async () => { effects++; throw new Error("denied"); }, finish: async () => {},
    remove: async () => { removals++; }, inspect: async () => "unchanged" };
  await suspensionTransaction({ ...base, reserve: async () => { throw new Error("capacity"); } });
  assert.equal(effects, 0);
  await suspensionTransaction(base);
  assert.equal(removals, 1);
  const result = await suspensionTransaction({ ...base, inspect: async () => { throw new Error("offline worker"); } });
  assert.equal(result.recoveryRetained, true);
  assert.equal(removals, 1);
});
