import test from "node:test";
import assert from "node:assert/strict";
import { buildBudget, updateHeapHistory } from "../src/shared/budget.js";

const MB = 1024 * 1024;
test("budget counts only ordinary loaded pages, uses fresh measured heap and excludes protected/unknown candidates", () => {
  const tabs = [
    { id: 1, url: "https://a/", budgetEligible: true, memory: { usedJSHeapSize: 150 * MB, updatedAt: 1000 } },
    { id: 2, url: "https://b/", budgetEligible: false, memory: { usedJSHeapSize: 200 * MB, updatedAt: 1000 } },
    { id: 3, url: "https://c/", budgetEligible: true, memory: { usedJSHeapSize: 500 * MB, updatedAt: 1 } },
    { id: 4, url: "https://d/", suspended: true }, { id: 5, url: "chrome://settings" }
  ];
  const budget = buildBudget(tabs, { resourceBudgetEnabled: true, resourceBudgetTabs: 2, resourceBudgetHeapMB: 100 }, {}, 301000);
  assert.equal(budget.openPages, 3);
  assert.equal(budget.measuredPages, 2);
  assert.equal(budget.heapBytes, 350 * MB);
  assert.deepEqual(budget.candidates.map((page) => page.tabId), [1]);
  assert.equal(budget.candidates[0].heapBytes, 150 * MB);
  assert.equal(buildBudget(tabs, { resourceBudgetEnabled: false }, {}, 301000).candidates.length, 0);
});
test("heap trend requires three distinct rising samples from the same document, ignores coverage gains and stale pages", () => {
  let history = {};
  for (const [time, size] of [[100, 10], [200, 50], [300, 90]]) {
    history = updateHeapHistory(history, { 1: { url: "https://a/", revision: "doc", usedJSHeapSize: size * MB, updatedAt: time } });
  }
  assert.equal(history[1].samples.length, 3);
  history = updateHeapHistory(history, { 1: { url: "https://a/", revision: "doc", usedJSHeapSize: 90 * MB, updatedAt: 300 }, 2: { url: "https://b/", revision: "doc2", usedJSHeapSize: 200 * MB, updatedAt: 300 } });
  const tabs = Object.entries(history).map(([id, entry]) => ({ id: Number(id), url: entry.url, memory: { ...entry.samples.at(-1) } }));
  const budget = buildBudget(tabs, { resourceBudgetEnabled: true, resourceBudgetTabs: 50, resourceBudgetHeapMB: 1024 }, history, 300);
  assert.deepEqual(budget.growth.map((page) => page.tabId), [1]);
  history = updateHeapHistory(history, { 1: { url: "https://a/", revision: "new-document", usedJSHeapSize: 100 * MB, updatedAt: 400 } });
  assert.equal(history[1].samples.length, 1);
  assert.equal(history[2], undefined);
  assert.equal(buildBudget(tabs, { resourceBudgetEnabled: true }, history, 400000).growth.length, 0);
});
