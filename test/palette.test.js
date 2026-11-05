import test from "node:test";
import assert from "node:assert/strict";
import { filterCommands } from "../src/shared/palette.js";

test("palette token filtering is literal, bounded and preserves command identity", () => {
  const commands = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), label: `工作区 ${i} React`, keywords: "restore 恢复" }));
  assert.equal(filterCommands(commands, "").length, 12);
  assert.equal(filterCommands(commands, "999 React")[0], commands[999]);
  assert.equal(filterCommands(commands, "恢复 999")[0].id, "999");
  assert.deepEqual(filterCommands(commands, "<script>"), []);
});
