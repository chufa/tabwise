import test from "node:test";
import assert from "node:assert/strict";
import { idleMinutesForUrl, normalizeIdleRules, parseIdleRules, temporaryProtectionReason } from "../src/shared/site-idle.js";

test("specific site idle duration wins over parent domain and preserves default policy", () => {
  const settings = { idleMinutes: 30, siteIdleRules: [{ domain: "example.com", minutes: 60 }, { domain: "docs.example.com", minutes: 120 }] };
  assert.equal(idleMinutesForUrl("https://docs.example.com/a", settings), 120);
  assert.equal(idleMinutesForUrl("https://news.example.com/a", settings), 60);
  assert.equal(idleMinutesForUrl("https://other.test/", settings), 30);
  assert.deepEqual(parseIdleRules("example.com 60\ndocs.example.com, 120"), settings.siteIdleRules);
  assert.throws(() => normalizeIdleRules([{ domain: "https://example.com/", minutes: 60 }]), /域名/);
  assert.throws(() => parseIdleRules("example.com 0"), /分钟/);
});

test("temporary protection expires and is bound to the protected page URL", () => {
  const tab = { id: 1, url: "https://read.test/" };
  assert.ok(temporaryProtectionReason(tab, { 1: { url: tab.url, until: 0 } }, 500));
  assert.ok(temporaryProtectionReason(tab, { 1: { url: tab.url, until: 501 } }, 500));
  assert.equal(temporaryProtectionReason(tab, { 1: { url: tab.url, until: 500 } }, 500), "");
  assert.equal(temporaryProtectionReason(tab, { 1: { url: "https://changed.test/", until: 0 } }, 500), "");
});
