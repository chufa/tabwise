import test from "node:test";
import assert from "node:assert/strict";
import { buildSuspendCandidate, searchPageMemory, sortTabs } from "../src/shared/search.js";

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
