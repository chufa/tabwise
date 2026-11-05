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
  addResourceReview,
  addWorkspace,
  getRecentSuspensions,
  getResourceReviews,
  getRecoveryCheckpoints,
  getResourceSnapshots,
  getRecord,
  getWorkspaces,
  getAllWorkspaces,
  getWorkspaceTrash,
  putRecord,
  removePrimaryRecord,
  removeRecord,
  removeRecordsForTab,
  removeResourceSnapshot,
  saveResourceSnapshots,
  updateWorkspace
} = await import("../src/shared/storage.js");
const { addClosedPage, getClosedPages, removeClosedPage, changeSettings } = await import("../src/shared/storage.js");

test("closed history is bounded, excludes private pages and expires stored metadata", async () => {
  await removeClosedPage();
  await changeSettings((settings) => ({ ...settings, closedHistoryEnabled: true, closedHistoryDays: 7 }));
  await Promise.all(Array.from({ length: 105 }, (_, id) => addClosedPage({ title: `Closed ${id}`, url: `https://closed.test/${id}` })));
  assert.equal((await getClosedPages()).length, 100);
  await addClosedPage({ url: "https://secret.test/", incognito: true });
  await addClosedPage({ url: "chrome://settings" });
  assert.ok((await getClosedPages()).every((item) => item.url.startsWith("https://closed.test/")));
  stores.local.closedPages.push({ id: "expired", url: "https://old.test/", closedAt: Date.now() - 8 * 86_400_000 });
  assert.equal((await getClosedPages()).some((item) => item.id === "expired"), false);
  assert.equal(stores.local.closedPages.some((item) => item.id === "expired"), false);
  await changeSettings((settings) => ({ ...settings, closedHistoryEnabled: false }));
  assert.deepEqual(await getClosedPages(), []);
  await addClosedPage({ url: "https://disabled.test/" });
  assert.deepEqual(stores.local.closedPages, []);
});

test("keeps a restore record when its primary dashboard record is cleared", async () => {
  const record = { recordId: "record-1", tabId: 7, originalUrl: "https://example.com", title: "Example" };
  await putRecord(record);
  await removePrimaryRecord(record.recordId);
  assert.equal((await getRecord(record.recordId)).originalUrl, "https://example.com");
  await removeRecord(record.recordId);
  assert.equal(await getRecord(record.recordId), undefined);
});

test("concurrent record and history updates retain every tab", async () => {
  await Promise.all(Array.from({ length: 25 }, (_, id) => putRecord({ recordId: `parallel-${id}`, tabId: 100 + id, originalUrl: `https://parallel.test/${id}` })));
  for (let id = 0; id < 25; id++) assert.ok(await getRecord(`parallel-${id}`));
  await Promise.all(Array.from({ length: 12 }, (_, id) => addRecentSuspension({ recordId: `parallel-recent-${id}`, originalUrl: `https://parallel.test/${id}` })));
  assert.equal((await getRecentSuspensions()).filter((item) => item.recordId.startsWith("parallel-recent")).length, 12);
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

test("stores current-session page memory snapshots by tab id", async () => {
  await saveResourceSnapshots({
    7: { usedJSHeapSize: 8_000_000, totalJSHeapSize: 12_000_000, updatedAt: 1_000 }
  });
  const snapshots = await getResourceSnapshots();
  assert.equal(snapshots[7].usedJSHeapSize, 8_000_000);
  assert.equal(snapshots[7].updatedAt, 1_000);
  await removeResourceSnapshot(7);
  assert.equal((await getResourceSnapshots())[7], undefined);
});

test("keeps archived workspaces available for later resumption", async () => {
  await addWorkspace({
    id: "workspace-archive",
    name: "Research",
    createdAt: 1,
    pinned: false,
    archived: false,
    tabs: [{ title: "Example", url: "https://example.com" }]
  });
  const archived = await updateWorkspace("workspace-archive", { archived: true, archivedAt: 2 });

  assert.equal(archived.archived, true);
  assert.equal((await getWorkspaces()).find((workspace) => workspace.id === "workspace-archive").archivedAt, 2);
});

test("retains the 20 latest resource review records", async () => {
  for (let index = 0; index < 22; index += 1) {
    await addResourceReview({ createdAt: index, trigger: "scheduled" });
  }
  const reviews = await getResourceReviews();
  assert.equal(reviews.length, 20);
  assert.equal(reviews[0].createdAt, 21);
  assert.equal(reviews.at(-1).createdAt, 2);
});

test("trash is excluded from workspaces and capacity failures never evict saved entries", async () => {
  const old = structuredClone(stores.local.workspaces);
  try {
    stores.local.workspaces = [];
    for (let index = 0; index < 20; index++) await addWorkspace({ id: `keep-${index}`, name: "Keep", tabs: [] });
    await assert.rejects(() => addWorkspace({ id: "overflow", tabs: [] }), /20/);
    assert.equal((await getAllWorkspaces()).length, 20);
    await updateWorkspace("keep-0", { deletedAt: 100 });
    assert.equal((await getWorkspaces()).length, 19);
    assert.equal((await getWorkspaceTrash())[0].id, "keep-0");
    await addWorkspace({ id: "new", tabs: [] });
    await assert.rejects(() => updateWorkspace("keep-0", { deletedAt: 0 }), /20/);
    assert.equal((await getWorkspaceTrash()).length, 1);
    assert.equal((await getAllWorkspaces()).length, 21);
  } finally { stores.local.workspaces = old; }
});
