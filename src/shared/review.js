export function nextReviewAt(reviewHour, now = Date.now(), reviewMinute = 0) {
  const hour = Math.min(23, Math.max(0, Math.round(Number(reviewHour) || 0)));
  const next = new Date(now);
  const minute = Math.min(59, Math.max(0, Math.round(Number(reviewMinute) || 0)));
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function findStaleWorkspaces(workspaces, now = Date.now(), retentionDays = 30) {
  const cutoff = now - Math.max(1, Number(retentionDays) || 30) * 86_400_000;
  return workspaces.filter((workspace) => {
    const lastTouchedAt = Number(workspace.lastOpenedAt || workspace.resumedAt || workspace.createdAt || 0);
    return !workspace.deletedAt && !workspace.archived && !workspace.pinned && lastTouchedAt > 0 && lastTouchedAt <= cutoff;
  });
}

export function buildResourceReview(dashboard, checkpoint, trigger, createdAt = Date.now(), details = {}) {
  return {
    createdAt,
    trigger,
    checkpointTabCount: Number(checkpoint?.count || 0),
    candidateCount: Array.isArray(dashboard?.candidates) ? dashboard.candidates.length : 0,
    reclaimableJSHeap: Number(dashboard?.summary?.reclaimableJSHeap || 0),
    reclaimableMeasuredTabs: Number(dashboard?.summary?.reclaimableMeasuredTabs || 0),
    duplicateCount: Number(details.duplicateCount || 0),
    archivedWorkspaceCount: Number(details.archivedWorkspaceCount || 0)
  };
}
