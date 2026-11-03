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

const {
  addRecentSuspension,
  addRecoveryCheckpoint,
  getRecentSuspensions,
  getRecoveryCheckpoints,
  getRecord,
  putRecord,
  removePrimaryRecord,
  removeRecord,
  removeRecordsForTab
} = await import("../src/shared/storage.js");

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

test("keeps the 20 most recent suspension entries", async () => {
  for (let index = 0; index < 22; index += 1) {
    await addRecentSuspension({ recordId: `recent-${index}`, originalUrl: `https://example.com/${index}`, suspendedAt: index });
  }
  const history = await getRecentSuspensions();
  assert.equal(history.length, 20);
  assert.equal(history[0].recordId, "recent-21");
  assert.equal(history.at(-1).recordId, "recent-2");
});

test("deduplicates recovery checkpoints and retains the latest ten", async () => {
  for (let index = 0; index < 11; index += 1) {
    await addRecoveryCheckpoint({
      id: `checkpoint-${index}`,
      createdAt: index,
      tabs: [{ title: `Tab ${index}`, url: `https://example.com/${index}` }]
    });
  }
  await addRecoveryCheckpoint({
    id: "duplicate",
    createdAt: 12,
    tabs: [{ title: "Tab 10", url: "https://example.com/10" }]
  });
  const checkpoints = await getRecoveryCheckpoints();
  assert.equal(checkpoints.length, 10);
  assert.equal(checkpoints[0].id, "checkpoint-10");
  assert.equal(checkpoints.some((checkpoint) => checkpoint.id === "duplicate"), false);
});
