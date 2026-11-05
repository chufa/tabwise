import test from "node:test";
import assert from "node:assert/strict";
import { createSelection } from "../src/shared/selection.js";

test("1000-page selection survives pages and filters, submits original indices and prunes removed targets", () => {
  const pages = Array.from({ length: 1000 }, (_, index) => ({ index, title: `Page ${index}` }));
  const model = createSelection({ key: (page) => page.index, selected: true });
  model.setData(pages);
  assert.equal(model.view().items.length, 50);
  model.toggle(0, false);
  model.move(1); model.toggle(51, false);
  model.filter("Page 999");
  assert.equal(model.view().items[0].index, 999);
  assert.equal(model.values().length, 998);
  model.selectAll(false);
  assert.equal(model.values().length, 0, "all/none apply to the full collection");
  model.toggle(999, true);
  model.filter(""); model.move(19);
  assert.deepEqual(model.values(), [999]);
  model.setData(pages.slice(0, 999));
  assert.deepEqual(model.values(), []);
  assert.equal(model.view().page, 19);
});

test("manual selection preserves page state on updates and refuses overflow without losing previous choices", () => {
  const model = createSelection({ key: (page) => page.id, limit: 2 });
  model.setData([{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(model.toggle(1, true), true);
  model.toggle(2, true);
  assert.equal(model.toggle(3, true), false);
  model.setData([{ id: 1, title: "updated" }, { id: 2 }, { id: 4 }]);
  assert.deepEqual(model.values(), [1, 2]);
  model.selectAll(true);
  assert.deepEqual(model.values(), [1, 2]);
});
