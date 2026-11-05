import { getRecords, queueStorage, addClosedPage } from "../shared/storage.js";

export function createPageTracker(extensionOrigin) {
  let queue = Promise.resolve();
  let initialized;
  let timer;
  const pending = new Map();
  let waiters = [];
  const run = (work) => {
    const next = queue.catch(() => {}).then(work);
    queue = next;
    return next;
  };
  const clean = (tab, records) => {
    if (tab.incognito) return null;
    const candidate = records.get(tab.id);
    const record = candidate && tab.url === `${extensionOrigin}/src/suspended/suspended.html#${candidate.recordId}` ? candidate : null;
    const url = record?.originalUrl || tab.pendingUrl || tab.url;
    if (!/^https?:\/\//.test(url || "")) return null;
    return { id: tab.id, title: record?.title || tab.title || url, url, windowId: tab.windowId, pinned: Boolean(tab.pinned), index: tab.index };
  };
  const update = (work) => queueStorage("session", async () => {
    const { pageMetadata = {} } = await chrome.storage.session.get("pageMetadata");
    const { cache, changed } = await work(pageMetadata);
    if (changed) await chrome.storage.session.set({ pageMetadata: cache });
  });
  function initialize() {
    if (!initialized) initialized = run(async () => {
      const [tabs, records] = await Promise.all([chrome.tabs.query({}), getRecords()]);
      const byTab = new Map(Object.values(records).map((record) => [record.tabId, record]));
      await update((cache) => {
        const next = Object.fromEntries(tabs.map((tab) => clean(tab, byTab)).filter(Boolean).map((page) => [page.id, page]));
        return { cache: next, changed: JSON.stringify(cache) !== JSON.stringify(next) };
      });
    });
    return initialized;
  }
  function flush() {
    clearTimeout(timer); timer = null;
    if (!pending.size) return queue;
    const batch = [...pending.values()], listeners = waiters;
    pending.clear(); waiters = [];
    const next = run(async () => {
      const records = new Map(Object.values(await getRecords()).map((record) => [record.tabId, record]));
      await update((cache) => {
        let changed = false;
        for (const tab of batch) {
          const page = clean(tab, records);
          if (page && JSON.stringify(cache[tab.id]) !== JSON.stringify(page)) { cache[tab.id] = page; changed = true; }
          else if (!page && cache[tab.id]) { delete cache[tab.id]; changed = true; }
        }
        return { cache, changed };
      });
    });
    next.then(() => listeners.forEach(({ resolve }) => resolve()), (error) => listeners.forEach(({ reject }) => reject(error)));
    return next;
  }
  return {
    initialize,
    flush,
    remember(tab) {
      pending.set(tab.id, { ...tab });
      if (!timer) timer = setTimeout(() => flush().catch(console.error), 100);
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    async close(tabId) {
      await flush();
      return run(async () => {
        let page;
        await update((cache) => { page = cache[tabId]; delete cache[tabId]; return { cache, changed: Boolean(page) }; });
        if (page) await addClosedPage(page);
      });
    }
  };
}
