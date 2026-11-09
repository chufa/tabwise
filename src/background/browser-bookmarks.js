import { domainForUrl } from "../shared/policy.js";

export const BOOKMARK_LIMIT = 10_000;

// Bookmarks remain in the browser profile. This only builds an ephemeral
// local search view and never copies the bookmark tree into extension storage.
export function createBrowserBookmarks({ getSettings, changeSettings, changed = () => {}, now = Date.now, browser = chrome }) {
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
    if (!browser.bookmarks || attached === browser.bookmarks) return;
    attached = browser.bookmarks;
    for (const name of ["onCreated", "onRemoved", "onChanged", "onMoved", "onChildrenReordered", "onImportBegan", "onImportEnded"]) {
      browser.bookmarks[name]?.addListener(invalidate);
    }
  }
  attach();
  browser.permissions.onAdded?.addListener(() => { attach(); invalidate(); });
  browser.permissions.onRemoved?.addListener(invalidate);
  const permitted = async () => Boolean(await browser.permissions.contains({ permissions: ["bookmarks"] }));
  async function snapshot() {
    const version = revision;
    const settings = await getSettings();
    const enabled = settings.bookmarkSearchEnabled === true;
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
            const roots = await browser.bookmarks.getTree();
            const pages = [];
            const walk = (nodes, folders = []) => {
              for (const node of nodes || []) {
                const path = node.url ? folders : [...folders, node.title].filter(Boolean);
                if (node.url && /^https?:\/\//i.test(node.url)) pages.push({
                  id: `bookmark:${node.id}`, bookmarkId: node.id, title: node.title || node.url, url: node.url,
                  domain: domainForUrl(node.url), source: "bookmark", status: "saved", bookmarkFolders: folders.join(" / "),
                  lastAccessed: Number(node.dateAdded) || 0, createdAt: Number(node.dateAdded) || 0
                });
                if (pages.length < BOOKMARK_LIMIT) walk(node.children, path);
              }
            };
            walk(roots);
            return { pages, at: now(), truncated: pages.length >= BOOKMARK_LIMIT };
          } catch (error) {
            return { pages: [], at: now(), error: error.message || "书签暂时不可用" };
          }
        })();
        pending = request;
        request.finally(() => { if (pending === request) pending = undefined; });
      }
      const result = await pending;
      if (version !== revision) return snapshot();
      cache = result;
    }
    return { pages: cache.pages, status: { state: cache.error ? "error" : "on", count: cache.pages.length,
      truncated: Boolean(cache.truncated), error: cache.error } };
  }
  async function setEnabled(enabled) {
    if (enabled && !await permitted()) throw new Error("请先允许读取浏览器书签。");
    await changeSettings((settings) => ({ ...settings, bookmarkSearchEnabled: enabled === true }));
    invalidate();
    return { ok: true };
  }
  async function resolve(result) {
    const { pages } = await snapshot();
    const page = pages.find((item) => item.id === result.id && item.bookmarkId === result.bookmarkId && item.url === result.url);
    if (!page) throw new Error("书签已变化或权限已关闭，请重新搜索。");
    const nodes = await browser.bookmarks.get(page.bookmarkId);
    const current = nodes?.[0];
    if (!current || current.url !== page.url || !(await getSettings()).bookmarkSearchEnabled || !await permitted()) {
      invalidate();
      throw new Error("书签已变化，请重新搜索。");
    }
    return page;
  }
  return { snapshot, setEnabled, resolve, invalidate };
}
