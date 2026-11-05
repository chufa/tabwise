import test from "node:test";
import assert from "node:assert/strict";
import { migrateLocalState, STORAGE_SCHEMA_VERSION } from "../src/shared/migrations.js";

test("migration normalizes legacy settings and records without removing user state", () => {
  const result = migrateLocalState({
    settings: { idleMinutes: 10 },
    suspensionRecords: { one: { recordId: "one", originalUrl: "https://example.test/" } },
    workspaces: [{ id: "work", name: "Work", tabs: [{ url: "https://example.test/" }] }]
  });
  assert.equal(result.changed, true);
  assert.equal(result.state.storageSchemaVersion, STORAGE_SCHEMA_VERSION);
  assert.equal(result.state.settings.idleMinutes, 10);
  assert.equal(result.state.suspensionRecords.one.schemaVersion, 2);
  assert.equal(result.state.workspaces[0].schemaVersion, 2);
});

test("migration is idempotent for the current schema", () => {
  const state = { storageSchemaVersion: STORAGE_SCHEMA_VERSION, settings: { idleMinutes: 30 }, workspaces: [] };
  assert.deepEqual(migrateLocalState(state), { state, changed: false });
});
