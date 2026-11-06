import test from "node:test";
import assert from "node:assert/strict";
import { buildLifecycle } from "../src/shared/lifecycle.js";

test("lifecycle distinguishes active, idle, suggested, suspended and archived pages", () => {
  const result = buildLifecycle({
    tabs: [
      { id: 1, url: "https://active.test/", active: true },
      { id: 2, url: "https://idle.test/" },
      { id: 3, url: "https://suggested.test/" }
    ],
    activity: { 2: 1, 3: 1 },
    idleThresholdMs: 100,
    now: 1_000,
    candidates: [{ tabId: 3 }],
    records: { s: { recordId: "s", title: "Suspended", originalUrl: "https://suspended.test/" } },
    workspaces: [{ id: "a", name: "Archived", archived: true, tabs: [{ title: "Archive", url: "https://archive.test/" }] }]
  });
  assert.deepEqual(result.map((item) => item.state), ["active", "idle", "suggested", "suspended", "archived"]);
});
