import test from "node:test";
import assert from "node:assert/strict";
import { createPageTracker } from "../src/background/page-tracker.js";

const stores = { local: {}, session: {} };
let tabs = [];
const area = (name) => ({
  get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(stores[name][key])])),
  set: async (values) => Object.assign(stores[name], structuredClone(values))
});
globalThis.chrome = { storage: { local: area("local"), session: area("session") }, tabs: { query: async () => structuredClone(tabs) } };

test("tracker records only eligible logical URLs and retains all concurrent closures", async () => {
  const origin = "chrome-extension://fixture";
  stores.local.suspensionRecords = { r: { tabId: 1, recordId: "r", title: "Sleeping title", originalUrl: "https://sleep.test/" } };
  tabs = [
    { id: 1, url: `${origin}/src/suspended/suspended.html#r` },
    { id: 2, url: "https://private.test/", incognito: true },
    { id: 3, url: "chrome://settings" },
    ...Array.from({ length: 10 }, (_, id) => ({ id: id + 4, title: `Page ${id}`, url: `https://tracked.test/${id}` }))
  ];
  const tracker = createPageTracker(origin);
  await tracker.initialize();
  assert.equal(Object.keys(stores.session.pageMetadata).length, 11);
  await Promise.all([1, 2, 3, ...Array.from({ length: 10 }, (_, id) => id + 4)].map((id) => tracker.close(id)));
  assert.equal(stores.local.closedPages.length, 11);
  assert.equal(stores.local.closedPages.find((page) => page.url === "https://sleep.test/").title, "Sleeping title");
  assert.ok(stores.local.closedPages.every((page) => !page.url.includes("private") && !page.url.startsWith("chrome")));
  assert.deepEqual(stores.session.pageMetadata, {});
});

test("a worker restart can close a cached page before initialization and removes newly private pages", async () => {
  stores.local.closedPages = [];
  const tracker = createPageTracker("chrome-extension://fixture");
  await tracker.remember({ id: 50, title: "Before restart", url: "https://restart.test/" });
  const restarted = createPageTracker("chrome-extension://fixture");
  await restarted.close(50);
  assert.equal(stores.local.closedPages[0].url, "https://restart.test/");
  await restarted.remember({ id: 51, url: "https://normal.test/" });
  await restarted.remember({ id: 51, url: "https://private.test/", incognito: true });
  await restarted.close(51);
  assert.equal(stores.local.closedPages.length, 1);
});

test("1000 update events batch into one write and closing flushes the latest pending title", async () => {
  stores.session = {}; stores.local.closedPages = [];
  let writes = 0;
  const original = chrome.storage.session.set;
  chrome.storage.session.set = async (values) => { if (values.pageMetadata) writes++; return original(values); };
  try {
    const tracker = createPageTracker("chrome-extension://fixture");
    const remembered = Array.from({ length: 1000 }, (_, i) => tracker.remember({ id: i % 100, title: `Revision ${i}`, url: `https://burst.test/${i % 100}` }));
    await Promise.all(remembered);
    assert.equal(writes, 1);
    const pending = tracker.remember({ id: 1, title: "Newest title", url: "https://burst.test/1" });
    await tracker.close(1);
    await pending;
    assert.equal(stores.local.closedPages[0].title, "Newest title");
    const before = writes;
    await tracker.remember({ id: 2, title: "Revision 902", url: "https://burst.test/2" });
    assert.equal(writes, before, "identical metadata must not rewrite the cache");
  } finally { chrome.storage.session.set = original; }
});
