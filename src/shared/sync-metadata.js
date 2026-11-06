import { snapshotSignature } from "./session.js";

export function buildSyncMetadata({ workspaces = [], settings = {} }, version = {}) {
  return {
    schemaVersion: 2,
    updatedAt: version.updatedAt ?? Date.now(),
    version: { revision: Math.max(0, Number(version.revision) || 0), parentRevision: Math.max(0, Number(version.parentRevision) || 0) },
    workspaces: structuredClone(workspaces.filter((workspace) => !workspace.deletedAt)),
    sitePolicies: {
      trustedDomains: [...(settings.trustedDomains || [])],
      blockedDomains: [...(settings.blockedDomains || [])],
      manualDomains: [...(settings.manualDomains || [])],
      nativeDiscardDomains: [...(settings.nativeDiscardDomains || [])]
    }
  };
}

export const nextSyncRevision = (local = 0, remote = 0) => Math.max(Number(local) || 0, Number(remote) || 0) + 1;
export function createSyncHistoryEntry(metadata, action, at = Date.now()) {
  const policies = Object.values(metadata.sitePolicies || {}).reduce((total, entries) => total + entries.length, 0);
  return { id: crypto.randomUUID(), at, action, revision: metadata.version?.revision || 0,
    summary: { workspaces: metadata.workspaces?.length || 0, policies }, metadata: structuredClone(metadata) };
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

const policyKeys = ["trustedDomains", "blockedDomains", "manualDomains", "nativeDiscardDomains"];
const policy = (settings, key) => [...new Set(settings?.[key] || [])].sort();
export function planSyncMetadata({ workspaces = [], settings = {} }, remote = {}) {
  const conflicts = [];
  const additions = [];
  for (const incoming of remote.workspaces || []) {
    const existing = workspaces.find((workspace) => workspace.id === incoming.id);
    if (!existing) additions.push(structuredClone(incoming));
    else if (snapshotSignature(existing) !== snapshotSignature(incoming)) conflicts.push({ id: `workspace:${incoming.id}`, kind: "workspace", workspaceId: incoming.id, name: incoming.name || "未命名工作区", local: existing, remote: incoming });
  }
  for (const key of policyKeys) {
    const local = policy(settings, key), incoming = policy(remote.sitePolicies, key);
    if (local.join("\n") !== incoming.join("\n")) conflicts.push({ id: `policy:${key}`, kind: "policy", key, local, remote: incoming });
  }
  return { local: structuredClone(workspaces), remote: structuredClone(remote), additions, conflicts };
}
export function resolveSyncPlan(plan, resolutions = {}) {
  const workspaces = [...plan.local, ...plan.additions];
  const sitePolicies = {};
  for (const key of policyKeys) sitePolicies[key] = policy({}, key);
  for (const conflict of plan.conflicts) {
    const choice = resolutions[conflict.id] || "copy";
    if (conflict.kind === "workspace") {
      const index = workspaces.findIndex((workspace) => workspace.id === conflict.workspaceId);
      if (choice === "remote") workspaces[index] = structuredClone(conflict.remote);
      else if (choice === "copy") workspaces.push({ ...structuredClone(conflict.remote), id: crypto.randomUUID(), name: `${conflict.name}（同步副本）`, syncConflictOf: conflict.workspaceId });
    } else sitePolicies[conflict.key] = choice === "remote" ? conflict.remote : conflict.local;
  }
  for (const key of policyKeys) if (!sitePolicies[key].length) sitePolicies[key] = policy(plan.remote.sitePolicies, key);
  return { workspaces, sitePolicies };
}
