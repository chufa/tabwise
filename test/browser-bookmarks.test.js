import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserBookmarks } from "../src/background/browser-bookmarks.js";

const event = () => {
  const callbacks = [];
  return { addListener: (callback) => callbacks.push(callback), emit: (...args) => callbacks.forEach((callback) => callback(...args)) };
};
function fixture() {
  let settings = { bookmarkSearchEnabled: false };
  let granted = false;
  let tree = [];
  const browser = {
    permissions: { contains: async () => granted, onAdded: event(), onRemoved: event() },
    bookmarks: {
      onCreated: event(), onRemoved: event(), onChanged: event(), onMoved: event(), onChildrenReordered: event(), onImportBegan: event(), onImportEnded: event(),
      getTree: async () => structuredClone(tree), get: async (id) => {
        const nodes = [];
        const walk = (items) => items.forEach((item) => { if (item.id === id) nodes.push(item); walk(item.children || []); });
        walk(tree); return structuredClone(nodes);
      }
    }
  };
  const bookmarks = createBrowserBookmarks({ browser, getSettings: async () => settings,
    changeSettings: async (change) => { settings = change(settings); } });
  return { bookmarks, browser, set granted(value) { granted = value; }, set tree(value) { tree = value; },
    get settings() { return settings; } };
}

test("bookmarks require opt-in permission and flatten folders into local searchable metadata", async () => {
  const f = fixture();
  assert.equal((await f.bookmarks.snapshot()).status.state, "off");
  await assert.rejects(f.bookmarks.setEnabled(true), /先允许/);
  f.granted = true;
  f.tree = [{ id: "root", children: [{ id: "bar", title: "书签栏", children: [
    { id: "folder", title: "研究", children: [{ id: "page", title: "浏览器文档", url: "https://docs.test/guide", dateAdded: 100 }] },
    { id: "internal", title: "内部", url: "chrome://settings" }
  ] }] }];
  await f.bookmarks.setEnabled(true);
  const snapshot = await f.bookmarks.snapshot();
  assert.equal(snapshot.status.count, 1);
  assert.equal(snapshot.pages[0].bookmarkFolders, "书签栏 / 研究");
  assert.equal(snapshot.pages[0].url, "https://docs.test/guide");
});

test("bookmark deletion, permission revocation, and forged results cannot open stale bookmarks", async () => {
  const f = fixture();
  f.granted = true;
  f.tree = [{ id: "root", children: [{ id: "page", title: "保存页", url: "https://bookmark.test/", dateAdded: 1 }]}];
  await f.bookmarks.setEnabled(true);
  const page = (await f.bookmarks.snapshot()).pages[0];
  assert.equal((await f.bookmarks.resolve(page)).url, page.url);
  await assert.rejects(f.bookmarks.resolve({ ...page, url: "https://forged.test/" }), /变化|过期/);
  f.tree = [{ id: "root", children: [] }];
  f.browser.bookmarks.onRemoved.emit();
  assert.equal((await f.bookmarks.snapshot()).pages.length, 0);
  f.granted = false;
  f.browser.permissions.onRemoved.emit();
  assert.equal((await f.bookmarks.snapshot()).status.state, "permission-required");
});
