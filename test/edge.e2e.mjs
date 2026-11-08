import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { verifyContextMemory } from "./context-memory.e2e.mjs";
import { show } from "./ui-navigation.mjs";

const profile = await mkdtemp(path.join(os.tmpdir(), "tabwise-edge-"));
const hits = new Map();
let context;
const server = createServer((request, response) => {
  hits.set(request.url, (hits.get(request.url) || 0) + 1);
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<title>Edge fixture</title><main>Edge extension check</main>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/edge`;
try {
  context = await chromium.launchPersistentContext(profile, { channel: "msedge", headless: true,
    args: [`--disable-extensions-except=${path.resolve(".")}`, `--load-extension=${path.resolve(".")}`] });
  const worker = context.serviceWorkers().find((item) => item.url().includes("service-worker.js"))
    || await context.waitForEvent("serviceworker", { predicate: (item) => item.url().includes("service-worker.js"), timeout: 20000 });
  const extensionUrl = `chrome-extension://${new URL(worker.url()).host}`;
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().name), "TabWise");
  const page = await context.newPage();
  await page.goto(url);
  const control = await context.newPage();
  await control.goto(`${extensionUrl}/src/sidepanel/sidepanel.html`);
  const send = (type, payload = {}) => control.evaluate(({ type, payload }) => chrome.runtime.sendMessage({ type, ...payload }), { type, payload });
  await send("updateSettings", { settings: { autoSuspend: false, resourceSamplingMode: "off" } });
  await control.bringToFront();
  const tab = (await send("getDashboard")).tabs.find((item) => item.url === url);
  const suspended = await send("directSuspendTab", { tabId: tab.id });
  assert.equal(suspended.ok, true);
  await page.waitForURL(/suspended\.html/);
  assert.equal((await send("restoreRecord", { recordId: suspended.recordId })).ok, true);
  await page.waitForURL(url);
  await page.waitForLoadState("load");
  const source = { id: "edge", name: "Edge", tabs: [{ url: `${url}-lazy`, title: "Edge lazy", tags: ["test"] }],
    restorePreset: { loadMode: "on-demand", concurrency: 1, skipExisting: true, restoreLayout: false, tag: "test" } };
  await control.evaluate((item) => chrome.storage.local.set({ workspaces: [item] }), source);
  const before = hits.get("/edge-lazy") || 0;
  const preview = await send("prepareRestore", { kind: "workspace", sourceId: "edge" });
  assert.equal(preview.preset.loadMode, "on-demand");
  const task = await send("startRestore", { previewId: preview.previewId, indices: [0], loadMode: "on-demand", concurrency: 1 });
  await control.waitForFunction(async (id) => (await chrome.runtime.sendMessage({ type: "getRestoreTask", taskId: id })).status === "completed", task.taskId);
  assert.equal(hits.get("/edge-lazy") || 0, before);
  const popup = await context.newPage();
  await popup.goto(`${extensionUrl}/src/popup/popup.html`);
  await show(popup, ".saved-workspace");
  await popup.locator('.saved-workspace[data-key="edge"]').waitFor();
  const options = await context.newPage();
  await options.goto(`${extensionUrl}/src/options/options.html`);
  await options.locator('#settings-form[aria-busy="false"]').waitFor();
  await show(options, "#sync-metadata");
  await options.locator("#sync-metadata").click();
  await options.waitForFunction(() => !document.querySelector("#sync-metadata").disabled);
  assert.equal(await options.locator("#sync-preview").isVisible(), true, await options.locator("#sync-feedback").textContent());
  await verifyContextMemory({ context, control, extensionUrl, fixture: { baseUrl: `http://127.0.0.1:${server.address().port}`, hits } });
  console.log(`Edge PASS: ${await context.browser().version()}, MV3 worker, popup/options/sidepanel, suspension restore, tagged on-demand preview with no origin request`);
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
