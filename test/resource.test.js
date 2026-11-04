import test from "node:test";
import assert from "node:assert/strict";
import { buildHeapDiagnostics, buildRendererDiagnostics } from "../src/shared/resource.js";

test("groups tabs that share a renderer without double counting memory", () => {
  const diagnostics = buildRendererDiagnostics(
    [
      { id: 1, title: "Alpha", url: "https://example.com/a" },
      { id: 2, title: "Beta", url: "https://example.com/b" },
      { id: 3, title: "Gamma", url: "https://other.test/c" }
    ],
    new Map([[1, 101], [2, 101], [3, 202]]),
    {
      101: { type: "renderer", privateMemory: 300_000_000, jsMemoryUsed: 12_000_000 },
      202: { type: "renderer", privateMemory: 500_000_000, jsMemoryUsed: 20_000_000 }
    }
  );

  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].processId, 202);
  assert.equal(diagnostics[0].tabCount, 1);
  assert.equal(diagnostics[1].processId, 101);
  assert.equal(diagnostics[1].tabCount, 2);
  assert.deepEqual(diagnostics[1].tabs.map((tab) => tab.title), ["Alpha", "Beta"]);
});

test("ignores tabs without a measurable renderer", () => {
  const diagnostics = buildRendererDiagnostics(
    [{ id: 1, title: "Chrome settings", url: "chrome://settings" }],
    new Map(),
    {}
  );
  assert.deepEqual(diagnostics, []);
});

test("lists stable-browser JavaScript heap measurements per webpage", () => {
  const diagnostics = buildHeapDiagnostics(
    [
      { id: 1, title: "Alpha", url: "https://example.com/a" },
      { id: 2, title: "Beta", url: "https://other.test/b" }
    ],
    new Map([
      [1, { usedJSHeapSize: 8_000_000, totalJSHeapSize: 12_000_000 }],
      [2, { usedJSHeapSize: 16_000_000, totalJSHeapSize: 24_000_000 }]
    ])
  );

  assert.equal(diagnostics[0].kind, "heap");
  assert.equal(diagnostics[0].tabs[0].title, "Beta");
  assert.equal(diagnostics[0].jsMemoryUsed, 16_000_000);
  assert.equal(diagnostics[0].privateMemory, 0);
});
