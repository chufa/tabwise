import test from "node:test";
import assert from "node:assert/strict";
import { buildSyncMetadata, mergeSyncMetadata } from "../src/shared/sync-metadata.js";

test("sync payload includes workspaces and site policy metadata but no recovery state", () => {
  const payload = buildSyncMetadata({
    workspaces: [{ id: "w", name: "Work", tabs: [{ url: "https://example.test/" }], createdAt: 1 }],
    settings: { trustedDomains: ["read.test"], blockedDomains: ["mail.test"], manualDomains: ["docs.test"], nativeDiscardDomains: ["news.test"] }
  });
  assert.equal(payload.schemaVersion, 1);
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
