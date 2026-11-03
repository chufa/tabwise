import test from "node:test";
import assert from "node:assert/strict";

const stores = { local: {}, session: {} };

function storageArea(name) {
  return {
    async get(keys) {
      const source = stores[name];
      if (typeof keys === "string") return { [keys]: structuredClone(source[keys]) };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, structuredClone(source[key])]));
      return structuredClone(source);
    },
    async set(values) {
      Object.assign(stores[name], structuredClone(values));
    }
  };
}

globalThis.chrome = {
  storage: {
    local: storageArea("local"),
    session: storageArea("session")
  }
};

const { getRecord, putRecord, removePrimaryRecord, removeRecord, removeRecordsForTab } = await import("../src/shared/storage.js");

test("keeps a restore record when its primary dashboard record is cleared", async () => {
  const record = { recordId: "record-1", tabId: 7, originalUrl: "https://example.com", title: "Example" };
  await putRecord(record);
  await removePrimaryRecord(record.recordId);
  assert.equal((await getRecord(record.recordId)).originalUrl, "https://example.com");
  await removeRecord(record.recordId);
  assert.equal(await getRecord(record.recordId), undefined);
});

test("removes both record copies when the tab closes", async () => {
  const record = { recordId: "record-2", tabId: 8, originalUrl: "https://example.org", title: "Example" };
  await putRecord(record);
  await removeRecordsForTab(record.tabId);
  assert.equal(await getRecord(record.recordId), undefined);
});
