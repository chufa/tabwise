import { isSuspendableUrl } from "../shared/policy.js";
import { buildHeapDiagnostics, buildRendererDiagnostics } from "../shared/resource.js";
import { mapConcurrent, mergeHeapSamples } from "../shared/scanning.js";
import { updateHeapHistory } from "../shared/budget.js";
import { getActivity, getResourceSnapshots, getSettings, queueStorage, removeResourceSnapshot, saveResourceSnapshots, changeSettings } from "../shared/storage.js";
import { samplingBatch, samplingPlan } from "../shared/sampling-policy.js";

const origins = ["http://*/*", "https://*/*"];
export function createResources({ foreground = () => false } = {}) {
  let queue = Promise.resolve();
  const versions = new Map();
  const epoch = crypto.randomUUID();
  const revision = (id) => versions.get(id) || 0;
  function run(work) {
    const next = queue.catch(() => {}).then(work);
    queue = next;
    return next;
  }
  async function collect(tabs, persist, concurrency = 4) {
    if (!await chrome.permissions.contains({ origins })) return { ok: false, permissionRequest: { origins },
      reason: "请允许网页访问权限，以测量各网页的 JavaScript 堆内存。" };
    const measurements = await mapConcurrent(tabs, concurrency, async (tab) => {
      const version = revision(tab.id);
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const memory = performance.memory;
          return memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize } : null;
        }
      }).catch(() => []);
      return { tabId: tab.id, url: tab.url, heap: version === revision(tab.id) && result[0]?.result
        ? { ...result[0].result, revision: `${epoch}:${version}` } : null };
    });
    const current = await chrome.tabs.query({});
    const previous = Object.fromEntries(Object.entries(await getResourceSnapshots()).filter(([id, sample]) => {
      const version = versions.get(Number(id));
      return version === undefined || sample.revision === `${epoch}:${version}`;
    }));
    const snapshots = mergeHeapSamples(previous, current, measurements, Date.now());
    const heapByTab = new Map(tabs.filter((tab) => snapshots[tab.id]?.url === tab.url).map((tab) => [tab.id, snapshots[tab.id]]));
    if (persist) {
      await saveResourceSnapshots(snapshots);
      await queueStorage("session", async () => {
        const { heapHistory = {} } = await chrome.storage.session.get("heapHistory");
        await chrome.storage.session.set({ heapHistory: updateHeapHistory(heapHistory, snapshots) });
      });
    }
    return { ok: true, mode: "heap", measuredAt: Date.now(), renderers: buildHeapDiagnostics(tabs, heapByTab) };
  }
  return {
    revision, run,
    invalidate(id, removed = false) {
      versions.set(id, revision(id) + 1);
      return run(async () => {
        await removeResourceSnapshot(id);
        if (removed) versions.delete(id);
      });
    },
    refresh(force = false) {
      return run(async () => {
        const settings = await getSettings();
        if (!settings.resourceSampling || settings.resourceSamplingMode === "off") return;
        const { heapScanState = {} } = await chrome.storage.session.get("heapScanState");
        const tabs = (await chrome.tabs.query({})).filter((tab) => tab.id && !tab.incognito && isSuspendableUrl(tab.url) && !tab.discarded);
        const plan = samplingPlan({ mode: settings.resourceSamplingMode, count: tabs.length, foreground: foreground() });
        if (!force && Date.now() - (heapScanState.at || 0) < plan.intervalMs) return;
        const batch = samplingBatch(tabs, heapScanState.cursor, plan.size, await getActivity(), await getResourceSnapshots());
        await chrome.storage.session.set({ heapScanState: { at: Date.now(), cursor: batch.cursor, ...plan, mode: settings.resourceSamplingMode } });
        return collect(force ? tabs : batch.items, true, plan.concurrency);
      });
    },
    async diagnostics() {
      const tabs = (await chrome.tabs.query({})).filter((tab) => tab.id && !tab.incognito && isSuspendableUrl(tab.url) && !tab.discarded);
      const hasProcessApi = Boolean(chrome.processes?.getProcessIdForTab && chrome.processes?.getProcessInfo);
      if (hasProcessApi && await chrome.permissions.contains({ permissions: ["processes"] })) {
        await run(() => collect(tabs, true));
        const entries = await mapConcurrent(tabs, 4, async (tab) => [tab, await chrome.processes.getProcessIdForTab(tab.id).catch(() => null)]);
        const processIdByTab = new Map(entries.filter(([, processId]) => Number.isInteger(processId)).map(([tab, processId]) => [tab.id, processId]));
        const processIds = [...new Set(processIdByTab.values())];
        if (!processIds.length) return { ok: true, mode: "renderer", measuredAt: Date.now(), renderers: [] };
        const processInfo = await chrome.processes.getProcessInfo(processIds, true);
        return { ok: true, mode: "renderer", measuredAt: Date.now(), renderers: buildRendererDiagnostics(tabs, processIdByTab, processInfo) };
      }
      return run(() => collect(tabs, true));
    },
    async enable() {
      await changeSettings((settings) => ({ ...settings, resourceSampling: true, resourceSamplingMode: settings.resourceSamplingMode === "off" ? "normal" : settings.resourceSamplingMode }));
      return { ok: true };
    }
  };
}
