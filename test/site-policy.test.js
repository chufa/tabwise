import test from "node:test";
import assert from "node:assert/strict";
import { sitePolicyForUrl, suspensionBlockReason } from "../src/shared/policy.js";

const origin = "chrome-extension://tabwise";
const settings = {
  trustedDomains: ["read.example"],
  blockedDomains: ["mail.example"],
  manualDomains: ["docs.example"],
  nativeDiscardDomains: ["news.example"]
};

test("site policy prioritizes never then manual native and automatic rules", () => {
  assert.equal(sitePolicyForUrl("https://mail.example/inbox", settings), "never");
  assert.equal(sitePolicyForUrl("https://docs.example/file", settings), "manual");
  assert.equal(sitePolicyForUrl("https://news.example/article", settings), "native");
  assert.equal(sitePolicyForUrl("https://read.example/story", settings), "auto");
  assert.equal(sitePolicyForUrl("https://unknown.example/", settings), "manual");
});

test("manual policy keeps automatic suspension conservative while explicit action stays available", () => {
  assert.equal(suspensionBlockReason({ id: 1, url: "https://docs.example/file" }, settings, origin), "Site policy: manual");
  assert.equal(suspensionBlockReason({ id: 1, url: "https://news.example/article" }, settings, origin), "");
});
