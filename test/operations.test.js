import test from "node:test";
import assert from "node:assert/strict";
import { createOperationJournal, sameOperationState } from "../src/shared/operations.js";

test("state equality survives Chrome storage key ordering while preserving array order", () => {
  assert.equal(sameOperationState({ id: 1, state: { archived: false, tabs: [1, 2] } }, { state: { tabs: [1, 2], archived: false }, id: 1 }), true);
  assert.equal(sameOperationState({ tabs: [1, 2] }, { tabs: [2, 1] }), false);
  assert.equal(sameOperationState(undefined, { id: 1 }), false);
});

test("reserves undo once, persists results and reports conflicts per item", async () => {
  let entries = [];
  const journal = createOperationJournal({
    read: async () => structuredClone(entries),
    write: async (next) => { entries = structuredClone(next); },
    undoItem: async (item) => {
      if (item.changed) throw new Error("状态已变化");
      return "已恢复";
    }
  });
  const entry = await journal.record("分组", [{ id: 1 }, { id: 2, changed: true }]);
  const results = await Promise.all([journal.undo(entry.id), journal.undo(entry.id)]);
  assert.equal(results[0].restored, 1);
  assert.equal(results[0].results[1].reason, "状态已变化");
  assert.equal(results[1].ok, false);
  assert.equal(entries[0].status, "partial");
  const restarted = createOperationJournal({ read: async () => entries, write: async () => {}, undoItem: async () => assert.fail("replayed") });
  assert.equal((await restarted.undo(entry.id)).ok, false);
});

test("keeps bounded journal and cannot replay an interrupted undo", async () => {
  let entries = [];
  const journal = createOperationJournal({ read: async () => entries, write: async (next) => { entries = next; }, undoItem: async () => {} });
  for (let index = 0; index < 22; index++) await journal.record(`操作 ${index}`, []);
  assert.equal(entries.length, 20);
  entries[0].status = "undoing";
  assert.equal((await journal.undo(entries[0].id)).ok, false);
});

test("finishes a reserved operation before permitting undo", async () => {
  let entries = [];
  const journal = createOperationJournal({ read: async () => entries, write: async (next) => { entries = next; }, undoItem: async () => "已恢复" });
  const pending = await journal.record("保存", [], "pending");
  assert.equal((await journal.undo(pending.id)).ok, false);
  await journal.finish(pending.id, [{ id: "saved" }]);
  assert.equal((await journal.undo(pending.id)).restored, 1);
  await assert.rejects(journal.finish("missing", []), /不存在/);
});
