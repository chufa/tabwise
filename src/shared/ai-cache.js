const TTL = 5 * 60_000;
const identity = ({ title, domain, status }) => JSON.stringify([title, domain, status]);

function members(snapshot) {
  const occurrences = new Map();
  return snapshot.pages.map((page) => {
    const key = identity(page);
    const occurrence = occurrences.get(key) || 0;
    occurrences.set(key, occurrence + 1);
    return { pageId: page.pageId, key: JSON.stringify([key, occurrence]) };
  });
}

export async function aiCacheKey(snapshot) {
  const input = JSON.stringify([1, snapshot.provider, snapshot.endpoint, snapshot.model, snapshot.request,
    members(snapshot).map((page) => page.key).sort()]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function cacheAiPlan(snapshot, plan, now = Date.now()) {
  const pages = members(snapshot);
  return {
    key: await aiCacheKey(snapshot), expiresAt: now + TTL,
    groups: plan.groups.map((group) => ({ name: group.name, reason: group.reason, members: group.pageIds.map((id) => pages.find((page) => page.pageId === id).key) }))
  };
}

export async function cachedAiPlan(entries, snapshot, now = Date.now()) {
  const key = await aiCacheKey(snapshot);
  const entry = entries.find((item) => item.key === key && item.expiresAt > now);
  if (!entry) return null;
  const pages = members(snapshot);
  return {
    schemaVersion: 1, snapshotId: snapshot.id,
    groups: entry.groups.map((group) => ({ name: group.name, reason: group.reason, pageIds: group.members.map((member) => pages.find((page) => page.key === member)?.pageId) }))
  };
}
