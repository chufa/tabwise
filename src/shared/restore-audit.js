const MAX_EVENTS = 40;

export function appendRestoreAudit(audit = [], type, detail = {}) {
  return [...audit, { type, at: Date.now(), detail: structuredClone(detail) }].slice(-MAX_EVENTS);
}

export function restoreAuditSummary(audit = []) {
  const last = audit.at(-1);
  return {
    events: audit.length,
    state: ["interrupted", "conflict", "failed"].includes(last?.type) ? "needs-review" : last?.type === "completed" ? "confirmed" : "in-progress"
  };
}

export function resumeRestoreIndices(results = []) {
  return results.filter((item) => ["pending", "failed", "closed"].includes(item.status)).map((item) => item.index);
}
