import test from "node:test";
import assert from "node:assert/strict";
import { buildSyncMetadata, createSyncHistoryEntry, mergeSyncMetadata, nextSyncRevision, planSyncMetadata, resolveSyncPlan } from "../src/shared/sync-metadata.js";

test("sync payload includes workspaces and site policy metadata but no recovery state", () => {
  const payload = buildSyncMetadata({
    workspaces: [{ id: "w", name: "Work", tabs: [{ url: "https://example.test/" }], createdAt: 1 }],
    settings: { trustedDomains: ["read.test"], blockedDomains: ["mail.test"], manualDomains: ["docs.test"], nativeDiscardDomains: ["news.test"] }
  });
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.workspaces.length, 1);
  assert.equal("suspensionRecords" in payload, false);
  assert.equal(payload.sitePolicies.manualDomains[0], "docs.test");
});

test("sync merge preserves local workspace conflicts and deduplicates matching content", () => {
  const local = [{ id: "same", name: "Local", tabs: [{ url: "https://same.test/" }] }];
  const remote = [{ id: "same", name: "Remote", tabs: [{ url: "https://remote.test/" }] }];
  const result = mergeSyncMetadata(local, remote);
  assert.equal(result.workspaces.length, 2);
  assert.equal(result.conflicts, 1);
});

test("sync plan exposes workspace and policy conflicts for an explicit resolution", () => {
  const local = [{ id: "same", name: "Local", tabs: [{ url: "https://local.test/" }] }];
  const remote = { workspaces: [{ id: "same", name: "Remote", tabs: [{ url: "https://remote.test/" }] }],
    sitePolicies: { manualDomains: ["docs.test"], blockedDomains: [], trustedDomains: [], nativeDiscardDomains: [] } };
  const plan = planSyncMetadata({ workspaces: local, settings: { manualDomains: ["local.test"] } }, remote);
  assert.equal(plan.conflicts.length, 2);
  const resolved = resolveSyncPlan(plan, { "workspace:same": "remote", "policy:manualDomains": "local" });
  assert.equal(resolved.workspaces[0].name, "Remote");
  assert.deepEqual(resolved.sitePolicies.manualDomains, ["local.test"]);
});

test("sync metadata carries a monotonic revision and produces a bounded history-safe summary", () => {
  const metadata = buildSyncMetadata({ workspaces: [{ id: "w", name: "Work", tabs: [] }], settings: {} }, { revision: 7, parentRevision: 6, updatedAt: 100 });
  assert.equal(metadata.version.revision, 7);
  assert.equal(nextSyncRevision(7, 12), 13);
  const entry = createSyncHistoryEntry(metadata, "merged", 200);
  assert.deepEqual(entry.summary, { workspaces: 1, policies: 0 });
  assert.equal(entry.metadata.version.parentRevision, 6);
});
test("choosing an empty local site policy cannot silently reintroduce remote entries", () => {
  const remote = buildSyncMetadata({ settings: { trustedDomains: ["remote.test"] } });
  const resolved = resolveSyncPlan(planSyncMetadata({ settings: { trustedDomains: [] } }, remote), { "policy:trustedDomains": "local" });
  assert.deepEqual(resolved.sitePolicies.trustedDomains, []);
});
test("sync omits local history and private notes", () => {
  const metadata = buildSyncMetadata({ workspaces: [{ id: "w", name: "W", notes: "private", tabs: [], versions: [{ notes: "old private" }], mergeSources: [{ notes: "source private" }] }] });
  assert.equal(JSON.stringify(metadata).includes("private"), false);
  assert.equal("versions" in metadata.workspaces[0], false);
  assert.equal("mergeSources" in metadata.workspaces[0], false);
});
