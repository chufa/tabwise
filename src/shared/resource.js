import { domainForUrl } from "./policy.js";

export function summarizeHeapSnapshots(snapshots) {
  return Object.values(snapshots).reduce((summary, snapshot) => {
    const usage = Number(snapshot?.usedJSHeapSize);
    if (!Number.isFinite(usage) || usage <= 0) return summary;
    return {
      jsHeapUsage: summary.jsHeapUsage + usage,
      jsHeapMeasuredTabs: summary.jsHeapMeasuredTabs + 1,
      jsHeapUpdatedAt: Math.max(summary.jsHeapUpdatedAt, Number(snapshot.updatedAt || 0))
    };
  }, { jsHeapUsage: 0, jsHeapMeasuredTabs: 0, jsHeapUpdatedAt: 0 });
}

export function buildRendererDiagnostics(tabs, processIdByTab, processInfoById) {
  const byProcess = new Map();
  for (const tab of tabs) {
    const processId = processIdByTab.get(tab.id);
    const process = processInfoById[processId];
    if (!Number.isInteger(processId) || process?.type !== "renderer") continue;
    const current = byProcess.get(processId) || {
      processId,
      privateMemory: Number(process.privateMemory || 0),
      jsMemoryUsed: Number(process.jsMemoryUsed || 0),
      tabs: []
    };
    current.tabs.push({
      id: tab.id,
      title: tab.title || "Untitled tab",
      domain: domainForUrl(tab.url || "")
    });
    byProcess.set(processId, current);
  }
  return [...byProcess.values()]
    .map((renderer) => ({ ...renderer, tabCount: renderer.tabs.length }))
    .sort((left, right) => right.privateMemory - left.privateMemory);
}

export function buildHeapDiagnostics(tabs, heapByTab) {
  return tabs
    .map((tab) => {
      const heap = heapByTab.get(tab.id);
      if (!heap || !Number.isFinite(heap.usedJSHeapSize)) return null;
      return {
        kind: "heap",
        processId: null,
        privateMemory: 0,
        jsMemoryUsed: Number(heap.usedJSHeapSize),
        jsMemoryAllocated: Number(heap.totalJSHeapSize || 0),
        tabCount: 1,
        tabs: [{
          id: tab.id,
          title: tab.title || "Untitled tab",
          domain: domainForUrl(tab.url || "")
        }]
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.jsMemoryUsed - left.jsMemoryUsed);
}
