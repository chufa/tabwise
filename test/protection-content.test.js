import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const script = readFileSync(new URL("../src/content/protection.js", import.meta.url), "utf8");

test("page protection reporter ignores invalidated extension contexts", () => {
  const listeners = new Map();
  const context = {
    chrome: { runtime: { id: "tabwise", sendMessage: () => { throw new Error("Extension context invalidated."); } } },
    document: { addEventListener: (type, listener) => listeners.set(type, listener) },
    location: { href: "https://example.test/" },
    Element: class {}
  };
  assert.doesNotThrow(() => vm.runInNewContext(script, context));
  assert.equal(listeners.size, 5);
});
