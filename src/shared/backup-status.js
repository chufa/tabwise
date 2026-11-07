export function appendBackupEvent(state = {}, event = {}) {
  const kind = event.kind === "download-requested" ? event.kind : "drill";
  const counts = Object.fromEntries(["workspaces", "pages", "windows", "versions"].map((key) => [key, Math.max(0, Number(event.counts?.[key]) || 0)]));
  const item = { kind, at: Number.isFinite(event.at) ? event.at : Date.now(), ok: Boolean(event.ok),
    verified: Boolean(event.verified), encrypted: Boolean(event.encrypted), counts };
  return { lastDownloadRequestedAt: kind === "download-requested" ? item.at : state.lastDownloadRequestedAt || 0,
    history: [item, ...(state.history || [])].slice(0, 20) };
}

export function backupStatus(state = {}, reminderDays = 0, now = Date.now()) {
  const lastDownloadRequestedAt = state.lastDownloadRequestedAt || 0;
  const nextReminderAt = lastDownloadRequestedAt ? lastDownloadRequestedAt + reminderDays * 86400000 : 0;
  return { ...state, lastDownloadRequestedAt, reminderDays, nextReminderAt,
    due: reminderDays > 0 && (!lastDownloadRequestedAt || now >= nextReminderAt) };
}
