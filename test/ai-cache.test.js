import test from "node:test";
import assert from "node:assert/strict";
import { aiCacheKey, cacheAiPlan, cachedAiPlan } from "../src/shared/ai-cache.js";

const snapshot = {
  id: "first", expiresAt: Date.now() + 10000, provider: "ollama", endpoint: "http://localhost:11434", model: "model", request: "分类",
  pages: [
    { pageId: 1, title: "搜索", domain: "example.org", status: "open", tabId: 10, url: "https://example.org/private?secret=1" },
    { pageId: 2, title: "休眠", domain: "example.org", status: "open", tabId: 11 }
  ]
};
const plan = { schemaVersion: 1, snapshotId: "first", groups: [{ name: "主题", pageIds: [1, 2], reason: "依据标题" }] };

test("cache rebinds membership and snapshot rather than reusing browser ids", async () => {
  const entry = await cacheAiPlan(snapshot, plan, 1000);
  const next = { ...snapshot, id: "second", pages: [{ ...snapshot.pages[1], pageId: 7, tabId: 99 }, { ...snapshot.pages[0], pageId: 8, tabId: 100 }] };
  assert.equal(await aiCacheKey(next), await aiCacheKey(snapshot));
  const hit = await cachedAiPlan([entry], next, 2000);
  assert.equal(hit.snapshotId, "second");
  assert.deepEqual(hit.groups[0].pageIds, [8, 7]);
  assert.doesNotMatch(JSON.stringify(entry), /secret|tabId|private/);
  assert.equal(await cachedAiPlan([entry], next, 1000 + 5 * 60000), null);
});

test("cache separates providers, models, goals, metadata and duplicate pages", async () => {
  const key = await aiCacheKey(snapshot);
  for (const patch of [{ provider: "browser" }, { model: "other" }, { credentialRevision: "new-key" }, { jsonMode: false }, { request: "别的目标" }, { endpoint: "http://localhost:9999" }, { pages: [snapshot.pages[0]] }]) {
    assert.notEqual(await aiCacheKey({ ...snapshot, ...patch }), key);
  }
  const duplicate = { ...snapshot, pages: [{ ...snapshot.pages[0] }, { ...snapshot.pages[0], pageId: 2 }] };
  const entry = await cacheAiPlan(duplicate, { ...plan, groups: [{ ...plan.groups[0], pageIds: [1] }] }, 1000);
  assert.deepEqual((await cachedAiPlan([entry], { ...duplicate, id: "new" }, 2000)).groups[0].pageIds, [1]);
});
