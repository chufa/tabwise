const MB = 1024 * 1024;
const FRESH_MS = 5 * 60_000;
export function updateHeapHistory(previous, snapshots) {
  const next = {};
  for (const [id, sample] of Object.entries(snapshots)) {
    if (!Number.isFinite(sample.usedJSHeapSize) || sample.usedJSHeapSize <= 0) continue;
    const prior = previous[id];
    const samples = prior?.url === sample.url && prior.revision === sample.revision ? [...prior.samples] : [];
    if (samples.at(-1)?.updatedAt !== sample.updatedAt) samples.push({ usedJSHeapSize: sample.usedJSHeapSize, updatedAt: sample.updatedAt });
    next[id] = { url: sample.url, revision: sample.revision, samples: samples.slice(-3) };
  }
  return next;
}
export function buildBudget(tabs, settings, history = {}, now = Date.now()) {
  const pages = tabs.filter((tab) => !tab.incognito && !tab.suspended && /^https?:\/\//.test(tab.url || ""));
  const fresh = (tab) => Number.isFinite(tab.memory?.usedJSHeapSize) && tab.memory.usedJSHeapSize > 0
    && now - tab.memory.updatedAt <= FRESH_MS && now >= tab.memory.updatedAt;
  const measured = pages.filter(fresh);
  const heapBytes = measured.reduce((total, tab) => total + tab.memory.usedJSHeapSize, 0);
  const tabLimit = settings.resourceBudgetTabs || 50, heapLimitBytes = (settings.resourceBudgetHeapMB || 1024) * MB;
  const enabled = settings.resourceBudgetEnabled === true;
  const overTabs = enabled ? Math.max(0, pages.length - tabLimit) : 0;
  const overHeapBytes = enabled ? Math.max(0, heapBytes - heapLimitBytes) : 0;
  const growth = enabled ? pages.filter((tab) => {
    const entry = history[tab.id], samples = entry?.samples;
    return fresh(tab) && entry?.url === tab.url && samples?.length === 3
      && samples[1].usedJSHeapSize > samples[0].usedJSHeapSize && samples[2].usedJSHeapSize > samples[1].usedJSHeapSize
      && samples[2].usedJSHeapSize - samples[0].usedJSHeapSize >= 64 * MB;
  }).map((tab) => ({ tabId: tab.id, title: tab.title || tab.url, growthBytes: history[tab.id].samples[2].usedJSHeapSize - history[tab.id].samples[0].usedJSHeapSize })) : [];
  const safe = pages.filter((tab) => tab.budgetEligible).map((tab) => ({
    tabId: tab.id, title: tab.title || tab.url, url: tab.url, heapBytes: fresh(tab) ? tab.memory.usedJSHeapSize : 0, lastActivity: tab.lastActivity
  })).sort((a, b) => b.heapBytes - a.heapBytes || a.lastActivity - b.lastActivity);
  const candidates = [];
  let reclaim = 0;
  if (enabled) for (const page of safe) {
    if (candidates.length >= 50 || candidates.length >= overTabs && reclaim >= overHeapBytes) break;
    if (candidates.length >= overTabs && !page.heapBytes) continue;
    candidates.push(page); reclaim += page.heapBytes;
  }
  return { enabled, openPages: pages.length, measuredPages: measured.length, heapBytes, tabLimit, heapLimitBytes, overTabs, overHeapBytes,
    updatedAt: measured.length ? Math.min(...measured.map((tab) => tab.memory.updatedAt)) : 0, growth, candidates, reclaimBytes: reclaim };
}
