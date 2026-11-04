import { domainForUrl } from "./policy.js";

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
