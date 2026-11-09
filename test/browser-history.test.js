import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserHistory, HISTORY_LIMIT, HISTORY_WINDOW_MS } from "../src/background/browser-history.js";

const event = () => {
  const callbacks = [];
  return { addListener: (callback) => callbacks.push(callback), emit: (...args) => callbacks.forEach((callback) => callback(...args)) };
};
function fixture() {
  let time = 1_800_000_000_000;
  let settings = { browserHistorySearchEnabled: false };
  let granted = false;
  let calls = 0;
  let request;
  let items = [];
  let visits = [];
  const browser = {
    permissions: { contains: async () => granted, onAdded: event(), onRemoved: event() },
    history: { onVisited: event(), onVisitRemoved: event(), search: async (query) => { calls++; request = query; return items; }, getVisits: async () => visits }
  };
  const history = createBrowserHistory({ browser, getSettings: async () => settings,
    changeSettings: async (update) => { settings = update(settings); }, now: () => time });
  return { browser, history, get time() { return time; }, set time(value) { time = value; },
    get settings() { return settings; }, set settings(value) { settings = value; },
    get calls() { return calls; }, get request() { return request; }, set granted(value) { granted = value; },
    set items(value) { items = value; }, set visits(value) { visits = value; } };
}

test("native history requires both opt-in and permission; reads pre-existing recent HTTP pages only", async () => {
  const f = fixture();
  assert.equal((await f.history.snapshot()).status.state, "off");
  assert.equal(f.calls, 0);
  await assert.rejects(f.history.setEnabled(true), /先允许/);
  f.granted = true;
  f.items = [
    { id: "existing", title: "历史研究", url: "https://history.test/existing#one", lastVisitTime: f.time - 5 * 86_400_000 },
    { id: "old", url: "https://history.test/old", lastVisitTime: f.time - HISTORY_WINDOW_MS - 1 },
    { id: "private", url: "file:///private", lastVisitTime: f.time },
    { id: "future", url: "https://history.test/future", lastVisitTime: f.time + 1 }
  ];
  await f.history.setEnabled(true);
  const snapshot = await f.history.snapshot();
  assert.deepEqual(snapshot.pages.map((page) => page.historyId), ["existing"]);
  assert.equal(snapshot.pages[0].url, "https://history.test/existing#one");
  assert.deepEqual(f.request, { text: "", startTime: f.time - HISTORY_WINDOW_MS, maxResults: HISTORY_LIMIT });
  await f.history.snapshot();
  assert.equal(f.calls, 1);
});

test("cached results age out on every search; deleted, disabled and revoked history cannot be opened", async () => {
  const f = fixture();
  f.granted = true;
  f.items = [{ id: "edge", url: "https://history.test/edge", lastVisitTime: f.time - HISTORY_WINDOW_MS + 1 }];
  await f.history.setEnabled(true);
  const page = (await f.history.snapshot()).pages[0];
  f.visits = [];
  await assert.rejects(f.history.resolve(page), /已变化/);
  f.time += 2;
  assert.equal((await f.history.snapshot()).pages.length, 0);
  f.items = [{ id: "new", url: "https://history.test/new", lastVisitTime: f.time }];
  f.browser.history.onVisited.emit();
  const fresh = (await f.history.snapshot()).pages[0];
  f.visits = [{ visitTime: f.time }];
  assert.equal((await f.history.resolve(fresh)).url, fresh.url);
  await assert.rejects(f.history.resolve({ ...fresh, url: "https://forged.test/" }), /过期/);
  f.granted = false;
  f.browser.permissions.onRemoved.emit();
  assert.equal((await f.history.snapshot()).status.state, "permission-required");
  await assert.rejects(f.history.resolve(fresh), /权限已关闭/);
  await f.history.setEnabled(false);
  assert.equal((await f.history.snapshot()).status.state, "off");
});

test("revocation discards in-flight native reads, and API errors preserve other search sources", async () => {
  const f = fixture();
  f.granted = true;
  await f.history.setEnabled(true);
  let release;
  f.browser.history.search = () => new Promise((resolve) => { release = resolve; });
  const read = f.history.snapshot();
  // Wait for the request to start without a polling timer.
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  assert.ok(release);
  f.granted = false;
  f.browser.permissions.onRemoved.emit();
  release([{ id: "stale", url: "https://history.test/stale", lastVisitTime: f.time }]);
  assert.deepEqual((await read).pages, []);
  f.granted = true;
  f.browser.history.search = async () => { throw new Error("native history failure"); };
  f.browser.permissions.onAdded.emit();
  assert.equal((await f.history.snapshot()).status.error, "native history failure");
  f.browser.history.search = async () => [{ id: "ok", url: "https://history.test/ok", lastVisitTime: f.time }];
  f.time += 60_001;
  assert.equal((await f.history.snapshot()).pages.length, 1);
  const restarted = createBrowserHistory({ browser: f.browser, getSettings: async () => ({ browserHistorySearchEnabled: true }), now: () => f.time });
  assert.equal((await restarted.snapshot()).pages.length, 1);
});

test("domain exclusions stay local to the search snapshot and report their count", async () => {
  const f = fixture();
  f.granted = true;
  f.items = [
    { id: "keep", url: "https://docs.test/keep", lastVisitTime: f.time },
    { id: "exclude", url: "https://secret.docs.test/private", lastVisitTime: f.time, visitCount: 9 }
  ];
  await f.history.setEnabled(true);
  f.settings = { browserHistorySearchEnabled: true, historyExcludedDomains: ["docs.test"] };
  // Recreate with a fixed settings reader to model a saved privacy policy.
  const filtered = createBrowserHistory({ browser: f.browser, getSettings: async () => f.settings, now: () => f.time });
  const snapshot = await filtered.snapshot();
  assert.deepEqual(snapshot.pages, []);
  assert.equal(snapshot.status.excludedCount, 2);
});
