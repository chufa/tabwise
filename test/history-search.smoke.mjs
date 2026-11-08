import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, cp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { show } from "./ui-navigation.mjs";

const channel = process.env.TABWISE_BROWSER || "chromium";
const profile = await mkdtemp(path.join(os.tmpdir(), "tabwise-history-"));
const extensionPath = await mkdtemp(path.join(os.tmpdir(), "tabwise-history-extension-"));
for (const entry of ["src", "assets", "manifest.json"]) await cp(path.resolve(entry), path.join(extensionPath, entry), { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extensionPath, "manifest.json"), "utf8"));
const artifacts = process.env.TABWISE_E2E_ARTIFACT_DIR || await mkdtemp(path.join(os.tmpdir(), "tabwise-history-evidence-"));
await mkdir(artifacts, { recursive: true });
const hits = new Map();
const server = createServer((request, response) => {
  hits.set(request.url, (hits.get(request.url) || 0) + 1);
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<title>浏览器历史研究 ${request.url}</title><main>Local history fixture</main>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let context;
let control;
const errors = [];
const launch = async (extension) => {
  const browser = await chromium.launchPersistentContext(profile, { channel, headless: true,
    args: extension ? [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] : [] });
  browser.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  return browser;
};
try {
  // Populate native browser history before this extension has been installed.
  context = await launch(false);
  const seed = await context.newPage();
  for (const route of ["/shared", "/old", ...Array.from({ length: 65 }, (_, i) => `/history/${i}`)]) await seed.goto(`${baseUrl}${route}`);
  await context.close();
  context = undefined;
  execFileSync("python3", ["-c", "import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1]); t=int((time.time()+11644473600-15*86400)*1000000); c.execute('UPDATE urls SET last_visit_time=? WHERE url=?',(t,sys.argv[2])); c.execute('UPDATE visits SET visit_time=? WHERE url IN (SELECT id FROM urls WHERE url=?)',(t,sys.argv[2])); c.commit()", path.join(profile, "Default", "History"), `${baseUrl}/old`]);
  context = await launch(true);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionUrl = `chrome-extension://${new URL(worker.url()).host}`;
  control = await context.newPage();
  control.setDefaultTimeout(8000);
  await control.setViewportSize({ width: 420, height: 900 });
  await control.goto(`${extensionUrl}/src/sidepanel/sidepanel.html`);
  const send = (type, payload = {}) => control.evaluate(({ type, payload }) => chrome.runtime.sendMessage({ type, ...payload }), { type, payload });
  await send("updateSettings", { settings: { autoSuspend: false, resourceSamplingMode: "off" } });
  await show(control, "#page-search");
  await control.locator('#search-results[aria-busy="false"]').waitFor();
  assert.equal((await send("searchPageCatalog", { source: "history" })).total, 0);
  assert.equal(await control.evaluate(() => chrome.permissions.contains({ permissions: ["history"] })), false);

  // Exercise the denied permission path without depending on an OS dialog.
  await control.evaluate(() => {
    window.realHistoryRequest = chrome.permissions.request.bind(chrome.permissions);
    chrome.permissions.request = async () => false;
  });
  await control.locator("#toggle-history-search").click();
  await control.locator("#feedback").filter({ hasText: "未获得历史记录权限" }).waitFor();
  assert.equal((await send("searchPageCatalog", { source: "history" })).total, 0);
  // Headless Chrome cannot display/accept its native permission dialog.
  // Let Chrome's extension updater grant history in a disposable extension
  // copy, then restore the original optional-permission manifest. No real
  // profile or product manifest is changed by this permission bootstrap.
  await context.close();
  await writeFile(path.join(extensionPath, "manifest.json"), JSON.stringify({ ...manifest, permissions: [...manifest.permissions, "history"] }));
  context = await launch(true);
  const grantWorker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  assert.equal(await grantWorker.evaluate(() => chrome.permissions.contains({ permissions: ["history"] })), true);
  await context.close();
  await writeFile(path.join(extensionPath, "manifest.json"), JSON.stringify(manifest));
  context = await launch(true);
  control = await context.newPage();
  control.setDefaultTimeout(8000);
  await control.setViewportSize({ width: 420, height: 900 });
  await control.goto(`${extensionUrl}/src/sidepanel/sidepanel.html`);
  await show(control, "#page-search");
  assert.equal(await control.evaluate(() => chrome.permissions.contains({ permissions: ["history"] })), true);
  await control.locator("#toggle-history-search").click();
  await control.locator("#history-search-status").filter({ hasText: "已纳入" }).waitFor({ timeout: 10000 });
  assert.equal(await control.evaluate(() => chrome.permissions.contains({ permissions: ["history"] })), true);
  const history = await send("searchPageCatalog", { source: "history", limit: 100 });
  assert.equal(history.total, 66);
  await send("updateSettings", { settings: { resourceSamplingMode: "off" } });
  assert.equal((await send("searchPageCatalog", { source: "history" })).total, 66);
  assert.ok(history.results.every((page) => page.url !== `${baseUrl}/old`));
  const beforeSearch = new Map(hits);
  await show(control, "#search-source");
  await control.locator("#search-source").selectOption("history");
  await control.locator("#page-search").fill("liulanqi");
  await control.waitForFunction(() => document.querySelector("#search-count").textContent.includes("66"));
  await control.locator("#search-next").click();
  await control.locator("#search-page-number").filter({ hasText: "2 / 3" }).waitFor();
  await control.locator("#search-next").click();
  await control.locator("#search-page-number").filter({ hasText: "3 / 3" }).waitFor();
  assert.equal(await control.locator("#search-results .result").count(), 6);
  assert.deepEqual(hits, beforeSearch, "search and pagination must not request source websites");
  assert.ok(!JSON.stringify(await control.evaluate(() => chrome.storage.local.get(null))).includes(`${baseUrl}/history/64`),
    "search must not copy native history into extension storage");

  const live = await context.newPage();
  await live.goto(`${baseUrl}/shared`);
  await live.evaluate(() => { document.title = "Current title"; });
  await control.evaluate((url) => chrome.storage.local.set({ workspaces: [{ id: "shared", name: "调研工作区", createdAt: Date.now(), tabs: [{ url, title: "Saved title" }] }] }), `${baseUrl}/shared`);
  await control.bringToFront();
  await control.locator("#search-source").selectOption("all");
  await control.locator("#page-search").fill("shared");
  const shared = control.locator("#search-results .result").filter({ hasText: `${baseUrl}/shared` });
  await shared.filter({ hasText: "工作区：调研工作区" }).waitFor();
  assert.equal(await shared.count(), 1);
  assert.ok((await shared.textContent()).includes("浏览历史"));
  const beforeTabs = await control.evaluate(() => chrome.tabs.query({}));
  const beforeFocus = new Map(hits);
  await shared.getByRole("button", { name: "切换", exact: true }).click();
  assert.equal((await control.evaluate(() => chrome.tabs.query({}))).length, beforeTabs.length);
  assert.deepEqual(hits, beforeFocus);

  await control.bringToFront();
  await control.locator("#search-source").selectOption("history");
  await control.locator("#page-search").fill("history/0");
  const deleted = history.results.find((page) => page.url === `${baseUrl}/history/0`);
  assert.ok(deleted);
  await control.evaluate((url) => chrome.history.deleteUrl({ url }), deleted.url);
  assert.equal((await send("openSearchResult", { result: deleted })).ok, false);
  assert.ok(!(await send("searchPageCatalog", { source: "history", query: "history/0", limit: 100 })).results.some((page) => page.url === deleted.url));

  // Opening an unopened historic URL must load exactly the chosen page.
  await control.locator("#page-search").fill("history/64");
  const unopened = control.locator("#search-results .result").filter({ hasText: `${baseUrl}/history/64` });
  await unopened.waitFor();
  const loadCount = hits.get("/history/64");
  const openedPage = context.waitForEvent("page");
  await unopened.getByRole("button", { name: "打开", exact: true }).click();
  const opened = await openedPage;
  await opened.waitForURL(`${baseUrl}/history/64`);
  assert.equal(hits.get("/history/64"), loadCount + 1);
  await opened.close();
  await control.bringToFront();

  await control.locator("#page-search").fill("liulanqi");
  await control.locator('#search-results[aria-busy="false"]').waitFor();
  for (const width of [320, 420]) {
    await control.setViewportSize({ width, height: 900 });
    for (const colorScheme of ["light", "dark"]) {
      await control.emulateMedia({ colorScheme });
      assert.ok(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px ${colorScheme} overflows`);
      await control.screenshot({ path: path.join(artifacts, `history-${width}-${colorScheme}.png`), fullPage: true });
    }
  }
  await control.evaluate(() => chrome.permissions.remove({ permissions: ["history"] }));
  await control.locator("#history-search-status").filter({ hasText: "权限已撤销" }).waitFor();
  assert.equal((await send("searchPageCatalog", { source: "history" })).total, 0);
  const storage = await control.evaluate(() => chrome.storage.local.get(null));
  assert.ok(!JSON.stringify(storage).includes(`${baseUrl}/history/63`), "unopened native history must not be copied into extension storage");
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, "verification.json"), JSON.stringify({ browser: await context.browser().version(), nativeHistoryCount: history.total,
    permissionTesting: "denial simulated; native permission seeded in disposable profile; browser permission dialog not automated",
    checks: ["pre-install native history", "14-day boundary", "native permission request with existing grant", "pinyin and 3-page navigation", "merged sources",
      "focus existing tab", "delete and revoke", "local-only search", "320/420 light/dark"], errors }, null, 2));
  // A restart must keep the opt-in setting but recheck the revoked permission.
  await context.close();
  context = await launch(true);
  const restartedWorker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  control = await context.newPage();
  await control.goto(`chrome-extension://${new URL(restartedWorker.url()).host}/src/sidepanel/sidepanel.html`);
  assert.equal((await send("searchPageCatalog", { source: "history" })).historyStatus.state, "permission-required");
  console.log(`${channel} history search PASS; evidence: ${artifacts}`);
} catch (error) {
  await control?.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(path.join(artifacts, "failure.txt"), error.stack || error.message);
  console.error(`History search failure evidence: ${artifacts}`);
  throw error;
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
  await rm(extensionPath, { recursive: true, force: true });
}
