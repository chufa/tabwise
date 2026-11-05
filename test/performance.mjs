import { performance } from "node:perf_hooks";
import { buildSessionSnapshot } from "../src/shared/session.js";
import { createPageIndex } from "../src/shared/search.js";

// Deterministic metadata fixtures; no website loads or real browser tab changes.
for (const n of [300, 1000]) {
  const tabs = Array.from({ length: n }, (_, i) => ({
    id: i, url: `https://perf.test/${i}`, title: `性能研究页面 ${i}`, windowId: i % 10, index: i, groupId: i % 20
  }));
  const groups = Array.from({ length: 20 }, (_, i) => ({ id: i, windowId: i % 10 }));
  const pages = tabs.map((tab) => ({ ...tab, domain: "perf.test", source: "open" }));
  const index = createPageIndex();
  let at = performance.now();
  for (let round = 0; round < 20; round++) buildSessionSnapshot(tabs, [], groups);
  const snapshotMs = (performance.now() - at) / 20;
  at = performance.now(); index.replace(pages);
  const indexMs = performance.now() - at;
  at = performance.now();
  for (let round = 0; round < 10; round++) index.replace(pages.map((tab) => ({ ...tab, lastAccessed: round })));
  const activityMs = (performance.now() - at) / 10;
  at = performance.now();
  for (let round = 0; round < 20; round++) index.search("xingneng", 30);
  console.log(JSON.stringify({ n, snapshotMs, indexMs, activityMs, searchMs: (performance.now() - at) / 20, compiled: index.stats().compiled }));
}
