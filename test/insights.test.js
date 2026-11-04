import test from "node:test";
import assert from "node:assert/strict";
import { buildLocalAiPrompt, buildResourceReclaimPlan } from "../src/shared/insights.js";

test("estimates recoverable JS heap from safe unique candidates", () => {
  const plan = buildResourceReclaimPlan(
    [
      { id: 1, title: "Largest", domain: "example.com", memory: { usedJSHeapSize: 16_000_000 } },
      { id: 2, title: "Unknown", domain: "other.test" }
    ],
    [{ tabId: 1, score: 80 }, { tabId: 1, score: 70 }, { tabId: 2, score: 60 }]
  );

  assert.equal(plan.reclaimableJSHeap, 16_000_000);
  assert.equal(plan.reclaimableMeasuredTabs, 1);
  assert.deepEqual(plan.candidates.map((candidate) => candidate.tabId), [1, 2]);
  assert.equal(plan.candidates[0].estimatedJSHeap, 16_000_000);
});

test("builds a bounded local AI prompt from metadata without full URLs", () => {
  const prompt = buildLocalAiPrompt([
    { id: 1, title: "React performance guide", domain: "react.dev", status: "live" },
    { id: 2, title: "Private path", url: "https://example.com/token?secret=1", status: "protected" }
  ], "整理为研究主题");

  assert.match(prompt, /React performance guide/);
  assert.match(prompt, /react\.dev/);
  assert.doesNotMatch(prompt, /token\?secret/);
  assert.match(prompt, /仅提供建议/);
});
