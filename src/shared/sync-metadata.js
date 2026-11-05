import { snapshotSignature } from "./session.js";

export function buildSyncMetadata({ workspaces = [], settings = {} }) {
  return {
    schemaVersion: 1,
    updatedAt: Date.now(),
    workspaces: structuredClone(workspaces.filter((workspace) => !workspace.deletedAt)),
    sitePolicies: {
      trustedDomains: [...(settings.trustedDomains || [])],
      blockedDomains: [...(settings.blockedDomains || [])],
      manualDomains: [...(settings.manualDomains || [])],
      nativeDiscardDomains: [...(settings.nativeDiscardDomains || [])]
    }
  };
}

export function mergeSyncMetadata(local = [], remote = []) {
  const workspaces = structuredClone(local);
  let conflicts = 0;
  for (const incoming of remote) {
    const existing = workspaces.find((workspace) => workspace.id === incoming.id);
    if (!existing) workspaces.push(structuredClone(incoming));
    else if (snapshotSignature(existing) !== snapshotSignature(incoming)) {
      conflicts++;
      workspaces.push({ ...structuredClone(incoming), id: crypto.randomUUID(), name: `${incoming.name || "工作区"}（同步副本）`, syncConflictOf: incoming.id });
    }
  }
  return { workspaces, conflicts };
}
