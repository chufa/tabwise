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

test("migration bounds durable task and sync history state", () => {
  const { state, changed } = migrateLocalState({
    syncHistory: Array.from({ length: 30 }, (_, index) => ({ id: `${index}`, revision: index })),
    restoreTaskLedger: Array.from({ length: 15 }, (_, index) => ({ id: `${index}`, status: "completed", results: [] }))
  });
  assert.equal(changed, true);
  assert.equal(state.syncHistory.length, 20);
  assert.equal(state.restoreTaskLedger.length, 10);
});
