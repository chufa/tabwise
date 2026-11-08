import test from "node:test";
import assert from "node:assert/strict";
import { isExtensionPage, resolvePopupSender } from "../src/shared/extension-page.js";

const url = "chrome-extension://tabwise/src/popup/popup.html";
const sender = { id: "tabwise", url, frameId: 0 };
const context = { contextType: "POPUP", documentUrl: url, documentId: "browser-popup-document" };

test("real popup messages use a unique browser-issued document identity and reject ambiguity", async () => {
  globalThis.chrome = { runtime: { id: "tabwise", getURL: (path) => `chrome-extension://tabwise/${path}`,
    getContexts: async (filter) => {
      assert.deepEqual(filter, { contextTypes: ["POPUP"], documentUrls: [url] });
      return [context];
    } } };
  assert.deepEqual(await resolvePopupSender(sender), { ...sender, documentId: context.documentId });
  for (const contexts of [[], [context, { ...context, documentId: "another-popup" }], [{ ...context, documentUrl: `${url}?other` }]]) {
    chrome.runtime.getContexts = async () => contexts;
    await assert.rejects(resolvePopupSender(sender), /无法确认/);
  }
  chrome.runtime.getContexts = async () => [{ ...context, documentId: "reopened-document" }];
  assert.equal((await resolvePopupSender(sender)).documentId, "reopened-document");
});

test("popup identity fallback does not admit web pages, other extensions, queries, or replace known document IDs", async () => {
  globalThis.chrome = { runtime: { id: "tabwise", getURL: (path) => `chrome-extension://tabwise/${path}`,
    getContexts: async () => { throw new Error("must not query popup contexts"); } } };
  for (const value of [{ ...sender, url: "https://example.test/" }, { ...sender, id: "other" },
    { ...sender, url: `${url}?popup=1` }, { ...sender, documentId: "known" }]) {
    assert.equal(await resolvePopupSender(value), value);
  }
  assert.equal(isExtensionPage({ ...sender, url: `${url}#saved` }, "src/popup/popup.html"), true);
});
