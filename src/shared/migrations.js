export const STORAGE_SCHEMA_VERSION = 3;

export function migrateLocalState(input = {}) {
  if (input.storageSchemaVersion === STORAGE_SCHEMA_VERSION) return { state: input, changed: false };
  const state = structuredClone(input);
  state.settings ||= {};
  state.suspensionRecords ||= {};
  state.suspensionRestoreRecords ||= {};
  state.workspaces ||= [];
  state.syncHistory = Array.isArray(state.syncHistory) ? state.syncHistory.slice(0, 20) : [];
  state.restoreTaskLedger = Array.isArray(state.restoreTaskLedger) ? state.restoreTaskLedger.slice(0, 10) : [];
  for (const records of [state.suspensionRecords, state.suspensionRestoreRecords]) {
    for (const record of Object.values(records)) record.schemaVersion ??= 2;
  }
  state.workspaces = state.workspaces.map((workspace) => ({ ...workspace, schemaVersion: workspace.schemaVersion || 2 }));
  state.storageSchemaVersion = STORAGE_SCHEMA_VERSION;
  return { state, changed: true };
}
