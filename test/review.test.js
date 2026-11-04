import test from "node:test";
import assert from "node:assert/strict";
import { buildResourceReview, findStaleWorkspaces, nextReviewAt } from "../src/shared/review.js";

test("schedules the next daily review at the configured local hour", () => {
  const beforeReview = new Date(2026, 0, 1, 17, 30).getTime();
  const afterReview = new Date(2026, 0, 1, 18, 30).getTime();

  assert.equal(new Date(nextReviewAt(18, beforeReview)).getHours(), 18);
  assert.equal(new Date(nextReviewAt(18, beforeReview)).getDate(), 1);
  assert.equal(new Date(nextReviewAt(18, afterReview)).getDate(), 2);
});

test("records review evidence without scheduling destructive actions", () => {
  const review = buildResourceReview({
    candidates: [{ tabId: 1 }, { tabId: 2 }],
    summary: { reclaimableJSHeap: 24_000_000, reclaimableMeasuredTabs: 2 }
  }, { count: 4 }, "manual", 1_000);

  assert.deepEqual(review, {
    createdAt: 1_000,
    trigger: "manual",
    checkpointTabCount: 4,
    candidateCount: 2,
    reclaimableJSHeap: 24_000_000,
    reclaimableMeasuredTabs: 2,
    duplicateCount: 0,
    archivedWorkspaceCount: 0
  });
});

test("archives only unpinned inactive workspaces after the selected retention period", () => {
  const now = 60 * 86_400_000;
  const stale = findStaleWorkspaces([
    { id: "old", createdAt: 1 },
    { id: "recent", lastOpenedAt: now - 5 * 86_400_000 },
    { id: "pinned", createdAt: 1, pinned: true },
    { id: "archived", createdAt: 1, archived: true }
  ], now, 30);

  assert.deepEqual(stale.map((workspace) => workspace.id), ["old"]);
});
