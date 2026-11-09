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

test("open status includes active and pinned tabs that stay protected from suspension", () => {
  const items = [
    { id: "active", title: "当前标签", url: "https://tabs.test/active", domain: "tabs.test", source: "open", status: "protected", active: true },
    { id: "pinned", title: "固定标签", url: "https://tabs.test/pinned", domain: "tabs.test", source: "open", status: "protected", pinned: true }
  ];
  assert.deepEqual(searchPageMemory(items, "biaoqian", 30, { status: "open" }).map((page) => page.id).sort(), ["active", "pinned"]);
});

test("bookmark folder labels remain available when bookmark URLs merge with live pages", () => {
  const url = "https://docs.test/guide";
  const items = [
    { id: "tab", title: "浏览器文档", url, domain: "docs.test", source: "open", status: "open" },
    { id: "bookmark", title: "浏览器文档", url, domain: "docs.test", source: "bookmark", status: "saved", bookmarkFolders: "书签栏 / 研究" }
  ];
  const result = searchPageMemory(items, "liulanqi", 30, { deduplicate: true })[0];
  assert.equal(result.sources.find((source) => source.source === "bookmark").bookmarkFolders, "书签栏 / 研究");
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

test("catalog paginates all unique URLs and merges nonmatching live titles with historic matches", () => {
  const url = "https://catalog.test/shared";
  const items = Array.from({ length: 135 }, (_, i) => ({ id: `history:${i}`, url: `https://catalog.test/${i}`,
    title: `浏览器研究 ${i}`, source: "history", status: "visited", lastAccessed: i }));
  items.push({ id: "historic", url, title: "浏览器研究", source: "history", status: "visited", lastVisited: 123, lastAccessed: 86_400_000 },
    { id: "live", tabId: 9, windowId: 1, url, title: "New title", source: "open", status: "protected" },
    { id: "workspace", url, title: "Saved title", source: "workspace", workspaceId: "saved" });
  const catalog = searchPageMemory(items, "liulanqi", 30, { deduplicate: true, withTotal: true });
  assert.equal(catalog.total, 136);
  const shared = catalog.results.find((page) => page.url === url);
  assert.equal(shared.id, "historic");
  assert.equal(shared.sources.length, 3);
  assert.equal(shared.sources.find((page) => page.source === "open").tabId, 9);
  const second = searchPageMemory(items, "liulanqi", 30, { deduplicate: true, withTotal: true, offset: 30 });
  assert.equal(second.results.length, 30);
  assert.ok(second.results.every((page) => !catalog.results.some((other) => other.url === page.url)));
  assert.equal(searchPageMemory(items, "", 30, { includeEmpty: true, withTotal: true, deduplicate: true, offset: 120 }).results.length, 16);
  assert.equal(searchPageMemory(items, "", 30, { includeEmpty: true, source: "history", status: "visited" }).length, 30);
});

test("filters by exact domain and time, and can prioritize recent or frequent local results", () => {
  const now = 1_800_000_000_000;
  const items = [
    { id: "old", title: "浏览器研究", url: "https://docs.test/old", domain: "docs.test", source: "history", status: "visited", lastAccessed: now - 8 * 86_400_000, visitCount: 50 },
    { id: "recent", title: "浏览器研究", url: "https://docs.test/recent", domain: "docs.test", source: "history", status: "visited", lastAccessed: now - 60_000, visitCount: 2 },
    { id: "frequent", title: "浏览器研究", url: "https://other.test/frequent", domain: "other.test", source: "history", status: "visited", lastAccessed: now - 86_400_000, visitCount: 80 }
  ];
  assert.deepEqual(searchPageMemory(items, "liulanqi", 30, { domain: "docs.test", periodDays: 7, now }).map((page) => page.id), ["recent"]);
  assert.deepEqual(searchPageMemory(items, "liulanqi", 30, { domain: "docs.test, other.test", now }).map((page) => page.id).sort(), ["frequent", "old", "recent"]);
  assert.equal(searchPageMemory(items, "liulanqi", 30, { sort: "recent", now })[0].id, "recent");
  assert.equal(searchPageMemory(items, "liulanqi", 30, { sort: "frequent", now })[0].id, "frequent");
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
