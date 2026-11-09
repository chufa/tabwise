import { domainForUrl, matchesDomain } from "../shared/policy.js";

export const HISTORY_WINDOW_MS = 14 * 86_400_000;
export const HISTORY_LIMIT = 10_000;

// Browser history is an ephemeral, local search source. It is never persisted
// in extension storage or added to dashboard/AI snapshots.
export function createBrowserHistory({ getSettings, changeSettings, changed = () => {}, now = Date.now, browser = chrome }) {
  let revision = 0;
  let cache;
  let pending;
  let attached;
  function invalidate() {
    revision++;
    cache = undefined;
    pending = undefined;
    changed();
  }
  function attach() {
    if (!browser.history || attached === browser.history) return;
    attached = browser.history;
    attached.onVisited?.addListener(invalidate);
    attached.onVisitRemoved?.addListener(invalidate);
  }
  attach();
  browser.permissions.onAdded?.addListener(() => { attach(); invalidate(); });
  browser.permissions.onRemoved?.addListener(invalidate);

  async function permitted() {
    return Boolean(await browser.permissions.contains({ permissions: ["history"] }));
  }
  async function snapshot() {
    const version = revision;
    const settings = await getSettings();
    const enabled = settings.browserHistorySearchEnabled === true;
    const granted = enabled && await permitted();
    if (version !== revision) return snapshot();
    if (!granted) {
      cache = undefined;
      return { pages: [], status: { state: enabled ? "permission-required" : "off", count: 0 } };
    }
    attach();
    if (!cache || now() - cache.at >= 60_000) {
      if (!pending) {
        const request = (async () => {
          try {
            const items = await browser.history.search({ text: "", startTime: now() - HISTORY_WINDOW_MS, maxResults: HISTORY_LIMIT });
            return { items, at: now(), truncated: items.length >= HISTORY_LIMIT };
          } catch (error) {
            return { items: [], at: now(), error: error.message || "历史记录暂时不可用" };
          }
        })();
        pending = request;
        request.finally(() => { if (pending === request) pending = undefined; });
      }
      const result = await pending;
      if (version !== revision) return snapshot();
      cache = result;
    }
    const timestamp = now();
    const excluded = settings.historyExcludedDomains || [];
    const recent = cache.items.filter((item) => /^https?:\/\//i.test(item.url || "")
      && Number(item.lastVisitTime) >= timestamp - HISTORY_WINDOW_MS && Number(item.lastVisitTime) <= timestamp);
    const pages = recent.filter((item) => !matchesDomain(domainForUrl(item.url), excluded))
      .map((item) => ({
        id: `history:${item.id}`, historyId: item.id, title: item.title || item.url,
        url: item.url, domain: domainForUrl(item.url), source: "history", status: "visited",
        lastAccessed: item.lastVisitTime, lastVisited: item.lastVisitTime, visitCount: Number(item.visitCount) || 0
      }));
    return { pages, status: { state: cache.error ? "error" : "on", count: pages.length,
      excludedCount: recent.length - pages.length, truncated: Boolean(cache.truncated), error: cache.error } };
  }
  async function setEnabled(enabled) {
    if (enabled && !await permitted()) throw new Error("请先允许读取浏览器历史记录。");
    await changeSettings((settings) => ({ ...settings, browserHistorySearchEnabled: enabled === true }));
    invalidate();
    return { ok: true };
  }
  async function resolve(result) {
    const { pages } = await snapshot();
    const page = pages.find((item) => item.historyId === result.historyId && item.id === result.id && item.url === result.url);
    if (!page) throw new Error("历史记录已过期或权限已关闭，请重新搜索。");
    // Recheck native visits immediately before opening: deletion may have
    // happened after the search response was rendered.
    const version = revision;
    const visits = await browser.history.getVisits({ url: page.url });
    const timestamp = now();
    const enabled = (await getSettings()).browserHistorySearchEnabled === true;
    const granted = await permitted();
    if (version !== revision || !enabled || !granted
      || !visits.some((visit) => visit.visitTime >= timestamp - HISTORY_WINDOW_MS && visit.visitTime <= timestamp)) {
      invalidate();
      throw new Error("历史记录已变化，请重新搜索。");
    }
    return page;
  }
  return { snapshot, setEnabled, resolve, invalidate };
}
