import test from "node:test";
import assert from "node:assert/strict";
import { duplicateConsolidation, checkLink, linkOutcome } from "../src/shared/organization.js";
import { highlightMatch } from "../src/shared/html.js";

test("duplicates retain protected/active keepers, match exact URLs, and never cross windows", () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://a.test/", active: true },
    { id: 2, windowId: 1, url: "https://a.test/" },
    { id: 3, windowId: 2, url: "https://a.test/" },
    { id: 4, windowId: 1, url: "https://a.test/#different" },
    { id: 5, windowId: 1, url: "https://a.test/", pinned: true }
  ];
  const planned = duplicateConsolidation(tabs, { 1: "active", 5: "pinned" });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].keepTabId, 1);
  assert.equal(planned[0].tabId, 2);
});
test("link checks use credential-free HEAD; only 404 and 410 are classified as dead", async () => {
  let init;
  const result = await checkLink("https://check.test/a", async (url, options) => { init = options; return { status: 404, url }; });
  assert.equal(init.method, "HEAD");
  assert.equal(init.credentials, "omit");
  assert.equal(result.status, "dead");
  assert.equal(linkOutcome(403).status, "login");
  assert.equal(linkOutcome(200, "https://check.test/login").status, "login");
  assert.equal(linkOutcome(503).status, "unknown");
  assert.equal((await checkLink("https://check.test", async () => { throw new Error("offline"); })).status, "unknown");
  await assert.rejects(checkLink("https://user:password@check.test"), /凭据/);
});
test("search highlighting escapes HTML and treats regex characters literally", () => {
  const result = highlightMatch('<img src=x onerror="alert(1)"> a+b [tag]', "a+b [tag]");
  assert.ok(result.includes("<mark>a+b</mark>"));
  assert.ok(result.includes("<mark>[tag]</mark>"));
  assert.equal(result.includes("<img"), false);
});
