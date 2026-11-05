import test from "node:test";
import assert from "node:assert/strict";
import { buildSuspendCandidate, createPageIndex, searchPageMemory, sortTabs } from "../src/shared/search.js";

test("1000 activity changes reuse compiled title data while status and window filters stay current", () => {
  const index = createPageIndex();
  const pages = Array.from({ length: 1000 }, (_, i) => ({ id: `tab:${i}`, title: `性能研究 ${i}`, url: `https://perf.test/${i}`, domain: "perf.test", source: "open", status: "open", windowId: 1 }));
  index.replace(pages);
  const before = index.stats().compiled;
  index.replace(pages.map((page) => ({ ...page, windowId: 2, status: "protected", lastAccessed: 999 })));
  assert.equal(index.stats().compiled, before);
  assert.equal(index.search("xingneng", 10, { windowId: 1 }).length, 0);
  assert.equal(index.search("xingneng", 10, { status: "protected", windowId: 2 }).length, 10);
});

const pages = [
  {
    id: "tab:1",
    title: "React performance profiling guide",
    url: "https://react.dev/learn/render-and-commit",
    domain: "react.dev",
    status: "live",
    source: "open",
    lastAccessed: 400
  },
  {
    id: "record:2",
    title: "React JavaScript performance patterns",
    url: "https://web.dev/articles/optimize-long-tasks",
    domain: "web.dev",
    status: "suspended",
    source: "suspended",
    lastAccessed: 300
  },
  {
    id: "workspace:3",
    title: "本周前端调研",
    url: "https://developer.chrome.com/docs/extensions",
    domain: "developer.chrome.com",
    status: "saved",
    source: "workspace",
    lastAccessed: 200
  }
];

test("finds fuzzy title and URL matches and favors an open recent page", () => {
  const results = searchPageMemory(pages, "react perf");
  assert.equal(results[0].id, "tab:1");
  assert.equal(results[0].matchKind, "fuzzy");
  assert.equal(results.some((result) => result.id === "record:2"), true);
});

test("matches Chinese page memory terms and keeps suspended pages findable", () => {
  const results = searchPageMemory(pages, "前端 调研");
  assert.equal(results[0].id, "workspace:3");
  assert.equal(results[0].status, "saved");
});

test("uses opt-in local term associations without sending page data away", () => {
  const results = searchPageMemory(pages, "前端性能", 30, { semantic: true });
  const reactPage = results.find((result) => result.id === "tab:1");
  assert.equal(reactPage.related, true);
});

test("returns empty results for an empty query", () => {
  assert.deepEqual(searchPageMemory(pages, "   "), []);
});

test("incremental index keeps unchanged compiled entries but drops renamed and removed pages", () => {
  const index = createPageIndex();
  index.replace(pages);
  assert.equal(index.search("react")[0].id, "tab:1");
  index.replace([{ ...pages[0], title: "Database notes", url: "https://db.test/sql", domain: "db.test" }]);
  assert.deepEqual(index.search("react"), []);
  assert.equal(index.search("database")[0].id, "tab:1");
  index.replace([]);
  assert.deepEqual(index.search("database"), []);
});

test("Chinese segmentation matches separated title terms and filters window and page status together", () => {
  const items = [{ id: "cn", title: "性能测试：浏览器介绍", url: "https://cn.test/", windowId: 8, status: "protected", source: "open" }];
  assert.equal(searchPageMemory(items, "浏览器性能")[0].id, "cn");
  assert.equal(searchPageMemory(items, "llq", 30, { windowId: "8", status: "protected" }).length, 1);
  assert.equal(searchPageMemory(items, "llq", 30, { windowId: "9", status: "protected" }).length, 0);
});

test("finds Chinese titles by full pinyin and initials and tolerates English typos", () => {
  const items = [...pages, { id: "chinese", title: "浏览器性能调研", url: "https://cn.test/", source: "workspace", status: "saved" }];
  assert.equal(searchPageMemory(items, "liulanqi xingneng")[0].id, "chinese");
  assert.equal(searchPageMemory(items, "llqxn")[0].id, "chinese");
  assert.equal(searchPageMemory(items, "react performnace")[0].id, "tab:1");
  assert.equal(searchPageMemory(items, "react performnace", 30, { semantic: true })[0].id, "tab:1");
});

test("merges identical URL sources after filtering and preserves exact fragments", () => {
  const items = [...pages, { ...pages[0], id: "saved-1", source: "workspace", workspaceId: "work", status: "saved" },
    { ...pages[0], id: "anchor", url: `${pages[0].url}#section` }];
  const all = searchPageMemory(items, "react", 30, { deduplicate: true });
  assert.equal(all.length, 3);
  assert.equal(all.find((item) => item.id === "tab:1").sources.length, 2);
  const filtered = searchPageMemory(items, "react", 30, { source: "workspace", workspaceId: "work", deduplicate: true });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].source, "workspace");
});

test("sorts tabs by recency, observed duration, and measured JS heap", () => {
  const tabs = [
    { id: 1, title: "Recent", lastActivity: 300, observedAt: 100, memory: { usedJSHeapSize: 10 } },
    { id: 2, title: "Longest", lastActivity: 100, observedAt: 10, memory: { usedJSHeapSize: 500 } },
    { id: 3, title: "Unknown memory", lastActivity: 200, observedAt: 50 }
  ];

  assert.deepEqual(sortTabs(tabs, "recent").map((tab) => tab.id), [1, 3, 2]);
  assert.deepEqual(sortTabs(tabs, "duration").map((tab) => tab.id), [2, 3, 1]);
  assert.deepEqual(sortTabs(tabs, "memory").map((tab) => tab.id), [2, 1, 3]);
  assert.deepEqual(tabs.map((tab) => tab.id), [1, 2, 3]);
});

test("explains a safe suspension candidate without overriding protection", () => {
  const candidate = buildSuspendCandidate({
    id: 7,
    title: "Read later",
    url: "https://example.com/article",
    status: "live",
    lastActivity: 0,
    observedAt: 1_000
  }, 180_000, 1);
  assert.equal(candidate.eligible, true);
  assert.match(candidate.explanation, /已闲置/);

  const protectedCandidate = buildSuspendCandidate({
    id: 8,
    title: "Draft",
    url: "https://example.com/draft",
    status: "protected",
    reason: "Unsaved edits",
    lastActivity: 0,
    observedAt: 1_000
  }, 180_000, 1);
  assert.equal(protectedCandidate.eligible, false);
  assert.match(protectedCandidate.explanation, /未保存/);
});
