import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../src/shared/html.js";
import { directSuspensionBlockReason, domainForUrl, isExpectedSuspensionUrl, isSuspendableUrl, isSuspendedUrl, matchesDomain, planLocalOrganization, suspensionBlockReason } from "../src/shared/policy.js";

const settings = { trustedDomains: ["example.com"], blockedDomains: ["mail.example.com"] };
const origin = "chrome-extension://extension-id";

test("matches root and subdomains", () => {
  assert.equal(matchesDomain("docs.example.com", ["example.com"]), true);
  assert.equal(matchesDomain("example.org", ["example.com"]), false);
});

test("rejects unsafe or untrusted tabs", () => {
  assert.equal(suspensionBlockReason({ id: 1, active: true, url: "https://example.com" }, settings, origin), "Active tab");
  assert.equal(suspensionBlockReason({ id: 1, url: "https://other.com" }, settings, origin), "Untrusted domain");
  assert.equal(suspensionBlockReason({ id: 1, url: "chrome://settings" }, settings, origin), "Not a web page");
  assert.equal(suspensionBlockReason({ id: 1, url: "https://mail.example.com" }, settings, origin), "Never suspend domain");
  assert.equal(isSuspendableUrl("https://example.com"), true);
  assert.equal(isSuspendableUrl("chrome://settings"), false);
  assert.equal(isSuspendedUrl("chrome-extension://extension-id/src/suspended/suspended.html#record", origin), true);
  assert.equal(isExpectedSuspensionUrl("chrome-extension://extension-id/src/suspended/suspended.html#record", origin, "record"), true);
  assert.equal(isExpectedSuspensionUrl("chrome-extension://extension-id/src/suspended/suspended.html#other", origin, "record"), false);
});

test("allows explicit suspension to override trust and pinned status only", () => {
  assert.equal(directSuspensionBlockReason({ id: 1, pinned: true, url: "https://untrusted.example" }, origin), "");
  assert.equal(directSuspensionBlockReason({ id: 1, audible: true, url: "https://untrusted.example" }, origin), "");
  assert.equal(directSuspensionBlockReason({ id: 1, active: true, url: "https://untrusted.example" }, origin), "Active tab");
  assert.equal(directSuspensionBlockReason({ id: 1, status: "loading", url: "https://untrusted.example" }, origin), "Still loading");
});

test("groups local domains and finds exact URL duplicates", () => {
  const plan = planLocalOrganization([
    { id: 1, url: "https://docs.example.com/one" },
    { id: 2, url: "https://docs.example.com/two" },
    { id: 3, url: "https://other.com/a" },
    { id: 4, url: "https://other.com/a" }
  ]);
  assert.deepEqual(plan.domainGroups, [{ domain: "docs.example.com", tabIds: [1, 2] }, { domain: "other.com", tabIds: [3, 4] }]);
  assert.deepEqual(plan.duplicates, [{ url: "https://other.com/a", tabIds: [3, 4] }]);
  assert.equal(domainForUrl("data:text/plain,test"), "");
});

test("escapes tab metadata before inserting popup HTML", () => {
  assert.equal(escapeHtml("研发 <tab> & \"notes\""), "研发 &lt;tab&gt; &amp; &quot;notes&quot;");
  assert.equal(escapeHtml("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
});
