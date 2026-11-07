import { rotationBatch } from "./scanning.js";

export function samplingPlan({ mode = "normal", count = 0, foreground = false } = {}) {
  if (mode === "off") return { enabled: false, intervalMs: Infinity, size: 0, concurrency: 0 };
  const low = mode === "low";
  return { enabled: true, intervalMs: (low ? foreground ? 3 : 5 : foreground ? 1 : count > 200 ? 3 : 2) * 60000,
    size: low ? count > 200 ? 8 : 12 : count > 200 ? 15 : 25, concurrency: low ? 2 : 4 };
}
export function samplingBatch(tabs, cursor, size, activity = {}, snapshots = {}, now = Date.now()) {
  const recent = tabs.filter((tab) => activity[tab.id] > 0 && now - activity[tab.id] < 120000
    && (snapshots[tab.id]?.updatedAt || 0) < activity[tab.id]).sort((a, b) => activity[b.id] - activity[a.id]).slice(0, Math.min(4, size));
  // Keep rotation on the full list so activity does not starve older pages.
  const rotating = rotationBatch(tabs, cursor, size - recent.length);
  const items = [...new Map([...recent, ...rotating.items].map((tab) => [tab.id, tab])).values()];
  return { items, cursor: rotating.cursor };
}
