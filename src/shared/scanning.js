export function rotationBatch(items, cursor = 0, limit = 25) {
  const sorted = [...items].sort((a, b) => a.id - b.id);
  if (!sorted.length) return { items: [], cursor: 0 };
  let start = sorted.findIndex((item) => item.id > cursor);
  if (start < 0) start = 0;
  const selected = Array.from({ length: Math.min(sorted.length, limit) }, (_, offset) => sorted[(start + offset) % sorted.length]);
  return { items: selected, cursor: selected.at(-1)?.id || 0 };
}

export async function mapConcurrent(items, concurrency, work) {
  let cursor = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index], index);
    }
  }));
  return results;
}

export function mergeHeapSamples(previous, tabs, samples, at) {
  const live = new Map(tabs.filter((tab) => !tab.discarded && !tab.pendingUrl && /^https?:\/\//.test(tab.url || "")).map((tab) => [tab.id, tab]));
  const next = Object.fromEntries(Object.entries(previous).filter(([id, sample]) => live.get(Number(id))?.url === sample.url));
  for (const sample of samples) {
    if (!sample.heap || live.get(sample.tabId)?.url !== sample.url) continue;
    next[sample.tabId] = { ...sample.heap, url: sample.url, updatedAt: at };
  }
  return next;
}
