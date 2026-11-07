import test from "node:test";
import assert from "node:assert/strict";
import { packSyncMetadata, readSyncMetadata, syncFingerprint, writeSyncMetadata } from "../src/shared/sync-transport.js";

function area() {
  let values = {}, fail;
  return { QUOTA_BYTES: 102400,
    get values() { return values; }, set fail(value) { fail = value; },
    async get(key) { return structuredClone(typeof key === "string" ? { [key]: values[key] } : values); },
    async getBytesInUse() { return new TextEncoder().encode(JSON.stringify(values)).length; },
    async remove(keys) { for (const key of keys) delete values[key]; },
    async set(next) {
      if (fail?.(next)) throw new Error("quota/offline");
      for (const [key, value] of Object.entries(next)) assert.ok(new TextEncoder().encode(key + JSON.stringify(value)).length < 8192);
      Object.assign(values, structuredClone(next));
    }
  };
}
test("Unicode and escaped payloads larger than one sync item round trip in bounded chunks", async () => {
  const store = area(), metadata = { tabs: Array.from({ length: 200 }, (_, i) => ({ title: `中文 "标题" ${i}`, url: `https://sync.test/${i}` })) };
  assert.ok(packSyncMetadata(metadata).manifest.count > 1);
  await writeSyncMetadata(metadata, syncFingerprint(null), store);
  assert.deepEqual((await readSyncMetadata(store)).metadata, metadata);
});
test("failed chunk or manifest writes leave the prior generation readable; stale and incomplete data fail closed", async () => {
  const store = area(), first = { value: "first" };
  await writeSyncMetadata(first, syncFingerprint(null), store);
  const old = await readSyncMetadata(store);
  for (const failRoot of [false, true]) {
    store.fail = (next) => failRoot ? Boolean(next.tabwiseMetadata) : !next.tabwiseMetadata;
    await assert.rejects(writeSyncMetadata({ value: "second" }, old.token, store), /offline/);
    assert.deepEqual((await readSyncMetadata(store)).metadata, first);
  }
  store.fail = null;
  await assert.rejects(writeSyncMetadata(first, "stale", store), /变化/);
  store.values.tabwiseMetadata.count = 3;
  await assert.rejects(readSyncMetadata(store), /完整/);
});
test("sync quota preflight occurs before writing chunks or changing the root", async () => {
  const store = area();
  assert.throws(() => packSyncMetadata({ content: "中".repeat(30000) }), /45 KB/);
  store.QUOTA_BYTES = 5;
  await assert.rejects(writeSyncMetadata({ value: "large" }, syncFingerprint(null), store), /空间不足/);
  assert.deepEqual(store.values, {});
});
test("equal-length corrupt chunks are rejected by the checksum", async () => {
  const store = area();
  await writeSyncMetadata({ value: "first" }, syncFingerprint(null), store);
  const key = Object.keys(store.values).find((key) => key.startsWith("tabwiseSync:"));
  store.values[key] = store.values[key].replace("first", "other");
  await assert.rejects(readSyncMetadata(store), /校验/);
});
