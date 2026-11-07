const month = 30 * 86400000;
export function appendEffect(events = [], event = {}, now = Date.now()) {
  if (!event.ok || !["suspend", "restore"].includes(event.kind)) return events;
  if (events.some((item) => item.id === event.id && item.kind === event.kind)) return events;
  const item = { id: String(event.id || "").slice(0, 120), kind: event.kind,
    at: Number.isFinite(event.at) ? event.at : now,
    mode: event.mode === "native-discard" ? "native-discard" : "placeholder" };
  if (Number.isFinite(event.heapBytes) && event.heapBytes > 0) item.heapBytes = event.heapBytes;
  if (Number.isFinite(event.latencyMs) && event.latencyMs >= 0) item.latencyMs = event.latencyMs;
  return [item, ...events].slice(0, 200);
}
export function summarizeEffects(events = [], now = Date.now()) {
  const recent = events.filter((item) => item.at >= now - month && item.at <= now);
  const suspended = recent.filter((item) => item.kind === "suspend");
  const restored = recent.filter((item) => item.kind === "restore");
  const measured = suspended.filter((item) => Number.isFinite(item.heapBytes));
  const timed = restored.filter((item) => Number.isFinite(item.latencyMs));
  return { suspensions: suspended.length, restores: restored.length, sampledSuspensions: measured.length,
    sampledHeapBeforeSuspendBytes: measured.reduce((sum, item) => sum + item.heapBytes, 0),
    timedRestores: timed.length, meanRestoreMs: timed.length ? Math.round(timed.reduce((sum, item) => sum + item.latencyMs, 0) / timed.length) : null,
    retainedEvents: recent.length, since: now - month };
}
