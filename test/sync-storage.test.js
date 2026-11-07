import test from "node:test";
import assert from "node:assert/strict";
import { buildSyncMetadata } from "../src/shared/sync-metadata.js";
import { readSyncMetadata } from "../src/shared/sync-transport.js";

const stores = { local: {}, session: {}, sync: {} };
let failRemote = false, failLocalCommit = false;
function area(name) {
  return {
    async get(keys) {
      const source = stores[name];
      if (typeof keys === "string") return { [keys]: structuredClone(source[keys]) };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, structuredClone(source[key])]));
      return structuredClone(source);
    },
    async set(values) {
      if (name === "sync" && failRemote) throw new Error("offline sync");
      if (name === "local" && values.workspaces && failLocalCommit) throw new Error("local quota");
      Object.assign(stores[name], structuredClone(values));
    },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete stores[name][key]; }
  };
}
globalThis.chrome = { storage: { local: area("local"), session: area("session"), sync: area("sync") } };
const { previewSyncMetadata, applySyncMetadata } = await import("../src/shared/storage.js");
const reset = () => {
  stores.local = { settings: { trustedDomains: [] }, workspaces: [{ id: "local", name: "Local", notes: "private", tabs: [] }] };
  stores.session = {}; stores.sync = {}; failRemote = false; failLocalCommit = false;
};
test("offline remote writes and post-remote local failures never partially replace local data", async () => {
  reset();
  stores.sync.tabwiseMetadata = buildSyncMetadata({ workspaces: [{ id: "remote", name: "Remote", tabs: [] }] });
  const original = structuredClone(stores.local.workspaces);
  let preview = await previewSyncMetadata();
  failRemote = true;
  await assert.rejects(applySyncMetadata({}, { previewId: preview.previewId }), /offline/);
  assert.deepEqual(stores.local.workspaces, original);
  failRemote = false; failLocalCommit = true;
  preview = await previewSyncMetadata();
  await assert.rejects(applySyncMetadata({}, { previewId: preview.previewId }), /quota/);
  assert.deepEqual(stores.local.workspaces, original);
  assert.ok(stores.local.pendingSync);
  failLocalCommit = false;
  preview = await previewSyncMetadata();
  assert.equal(preview.pending, true);
  await applySyncMetadata({}, { previewId: preview.previewId });
  assert.equal(stores.local.workspaces.length, 2);
  assert.equal(stores.local.pendingSync, null);
  assert.equal(stores.local.workspaces.find((item) => item.id === "local").notes, "private");
});
test("stale previews and selected sync enforce scope before writes", async () => {
  reset();
  let preview = await previewSyncMetadata();
  stores.local.workspaces[0].name = "Changed";
  await assert.rejects(applySyncMetadata({}, { previewId: preview.previewId }), /预览/);
  assert.deepEqual(stores.sync, {});
  stores.local.workspaces.push({ id: "omit", name: "Omit", tabs: [] });
  preview = await previewSyncMetadata();
  await applySyncMetadata({}, { previewId: preview.previewId, workspaceIds: ["local"] });
  assert.equal(stores.local.workspaces.length, 2);
  assert.deepEqual((await readSyncMetadata()).metadata.workspaces.map((item) => item.id), ["local"]);
  assert.equal(JSON.stringify(stores.sync).includes("private"), false);
});
test("recovering a remote-committed conflict copy preserves its ID without multiplying copies", async () => {
  reset();
  stores.sync.tabwiseMetadata = buildSyncMetadata({ workspaces: [{ id: "local", name: "Remote changed", tabs: [] }] });
  failLocalCommit = true;
  await assert.rejects(applySyncMetadata({ "workspace:local": "copy" }), /quota/);
  const preparedIds = stores.local.pendingSync.workspaces.map((item) => item.id);
  failLocalCommit = false;
  const preview = await previewSyncMetadata();
  const applied = await applySyncMetadata({}, { previewId: preview.previewId });
  assert.equal(applied.recovered, true);
  assert.deepEqual(stores.local.workspaces.map((item) => item.id), preparedIds);
  assert.equal(stores.local.workspaces.length, 2);
});
test("sync does not resurrect local trash or create an active/trash duplicate with the same ID", async () => {
  reset();
  stores.local.workspaces.push({ id: "trashed", name: "Trash", deletedAt: 1, notes: "retain", tabs: [] });
  stores.sync.tabwiseMetadata = buildSyncMetadata({ workspaces: [{ id: "trashed", name: "Remote", tabs: [] }] });
  const preview = await previewSyncMetadata();
  assert.equal(preview.choices.some((item) => item.id === "trashed"), false);
  await applySyncMetadata({}, { previewId: preview.previewId });
  assert.equal(stores.local.workspaces.filter((item) => item.id === "trashed").length, 1);
  assert.equal(stores.local.workspaces.find((item) => item.id === "trashed").notes, "retain");
  assert.equal(stores.local.workspaces.find((item) => item.id === "trashed").deletedAt, 1);
});
