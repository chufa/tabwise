import test from "node:test";
import assert from "node:assert/strict";
import { appendBackupEvent, backupStatus } from "../src/shared/backup-status.js";
import { appendEffect, summarizeEffects } from "../src/shared/effects.js";

test("backup reminder is based on requested download and bounded drill records contain no content", () => {
  let state = {};
  for (let i = 0; i < 30; i++) state = appendBackupEvent(state, { kind: "drill", ok: true, verified: true, counts: { workspaces: 2, pages: 9 }, password: "secret", notes: "secret", at: i });
  assert.equal(state.history.length, 20);
  assert.ok(!JSON.stringify(state).includes("secret"));
  assert.equal(backupStatus(state, 7, 1).due, true);
  state = appendBackupEvent(state, { kind: "download-requested", at: 1000, counts: { workspaces: 2 } });
  assert.equal(backupStatus(state, 7, 1001).due, false);
  assert.equal(backupStatus(state, 7, 1000 + 8 * 86400000).due, true);
  assert.equal(backupStatus(state, 0, 999999999).due, false);
});
test("effects retain successful measurements only, deduplicate completions and never claim physical RAM", () => {
  let events = appendEffect([], { id: "a", kind: "suspend", ok: true, mode: "placeholder", heapBytes: 100, at: 1000 });
  events = appendEffect(events, { id: "a", kind: "suspend", ok: true, heapBytes: 100, at: 1000 });
  events = appendEffect(events, { id: "b", kind: "restore", ok: true, latencyMs: 230, at: 1001, url: "secret" });
  events = appendEffect(events, { id: "failed", kind: "suspend", ok: false, heapBytes: 500 });
  assert.equal(events.length, 2);
  const summary = summarizeEffects(events, 2000);
  assert.equal(summary.suspensions, 1);
  assert.equal(summary.restores, 1);
  assert.equal(summary.meanRestoreMs, 230);
  assert.equal(summary.sampledHeapBeforeSuspendBytes, 100);
  assert.ok(!JSON.stringify(events).includes("secret"));
  for (let i = 0; i < 250; i++) events = appendEffect(events, { id: `${i}`, kind: "suspend", ok: true, at: 2000 });
  assert.equal(events.length, 200);
  assert.equal(summarizeEffects(events, 2000 + 31 * 86400000).suspensions, 0);
});
