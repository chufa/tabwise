import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const extensionPath = path.resolve(".");

function startTestServer() {
  const hits = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "fixture:latest" }] }));
      return;
    }
    if (url.pathname === "/api/generate") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const payload = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ response: `本地建议：已处理 ${payload.model}` }));
      });
      return;
    }
    const page = url.pathname.slice(1) || "home";
    hits.set(page, (hits.get(page) || 0) + 1);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><title>${page}</title><main><h1>${page}</h1><p>TabWise e2e fixture ${page}</p></main>`);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    resolve({
      baseUrl: `http://127.0.0.1:${port}`,
      hits,
      close: () => new Promise((done) => server.close(done))
    });
  }));
}

async function message(extensionPage, type, payload = {}) {
  return extensionPage.evaluate(({ type, payload }) => chrome.runtime.sendMessage({ type, ...payload }), { type, payload });
}

async function waitForWorker(context) {
  const isTabWise = async (worker) => {
    if (!worker.url().includes("chrome-extension://")) return false;
    try {
      return await worker.evaluate(() => chrome.runtime.getManifest().name === "TabWise");
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const worker of context.serviceWorkers()) {
      if (await isTabWise(worker)) return worker;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`TabWise service worker did not start. Observed: ${context.serviceWorkers().map((worker) => worker.url()).join(", ")}`);
}

const profile = await mkdtemp(path.join(os.tmpdir(), "tabwise-e2e-"));
const fixture = await startTestServer();
let context;

try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  const worker = await waitForWorker(context);
  const extensionId = new URL(worker.url()).host;
  const extensionUrl = `chrome-extension://${extensionId}`;
  const control = await context.newPage();
  await control.goto(`${extensionUrl}/src/sidepanel/sidepanel.html`);
  await control.getByRole("button", { name: "生成本地建议" }).waitFor();

  const alpha = await context.newPage();
  await alpha.goto(`${fixture.baseUrl}/alpha-research`);
  const react = await context.newPage();
  await react.goto(`${fixture.baseUrl}/react-performance`);
  const active = await context.newPage();
  await active.goto(`${fixture.baseUrl}/active-work`);

  const diagnostics = await message(control, "getResourceDiagnostics");
  assert.equal(diagnostics.ok, true, "stable Chromium should collect page heap diagnostics");
  assert.equal(diagnostics.mode, "heap");
  const dashboard = await message(control, "getDashboard");
  const alphaTab = dashboard.tabs.find((tab) => tab.url.endsWith("/alpha-research"));
  const reactTab = dashboard.tabs.find((tab) => tab.url.endsWith("/react-performance"));
  assert.ok(alphaTab && reactTab, "fixture tabs must appear in the extension dashboard");
  assert.ok(alphaTab.memory?.usedJSHeapSize > 0, "dashboard should include the latest page heap snapshot");
  assert.ok(dashboard.summary.jsHeapUsage >= alphaTab.memory.usedJSHeapSize, "dashboard should include total JS heap usage");
  await message(control, "updateSettings", {
    settings: {
      aiProvider: "ollama",
      ollamaEndpoint: fixture.baseUrl,
      ollamaModel: "fixture:latest"
    }
  });
  const ollamaConnection = await message(control, "testOllamaConnection");
  assert.equal(ollamaConnection.ok, true, "local Ollama connection should be testable");
  await control.reload();
  await control.getByRole("button", { name: "生成本地建议" }).click();
  await control.getByText("本地建议：已处理 fixture:latest").waitFor();
  const popup = await context.newPage();
  await popup.goto(`${extensionUrl}/src/popup/popup.html`);
  await popup.locator("#tabs .row-main span").filter({ hasText: "JS 堆" }).first().waitFor();
  assert.match(await popup.locator("#js-heap-usage").textContent(), /MB/, "popup should show total JS heap usage");
  await popup.getByLabel("标签页排序").selectOption("memory");
  assert.equal(await popup.getByLabel("标签页排序").inputValue(), "memory", "popup should allow sorting tabs by JS heap usage");
  await popup.keyboard.press("/");
  assert.equal(await popup.evaluate(() => document.activeElement?.id), "tab-search", "slash should focus the popup tab search");
  await popup.getByLabel("搜索标签页").fill("alpha");
  await popup.keyboard.press("Escape");
  assert.equal(await popup.getByLabel("搜索标签页").inputValue(), "", "escape should clear the popup tab search");

  const beforeSuspensionHits = fixture.hits.get("alpha-research");
  const placeholder = await message(control, "directSuspendTab", { tabId: alphaTab.id });
  assert.equal(placeholder.ok, true, "placeholder suspension should succeed for an inactive web page");
  const afterSuspension = await message(control, "getDashboard");
  assert.ok(afterSuspension.summary.jsHeapUsage < dashboard.summary.jsHeapUsage, "suspending a page should reduce the JS heap total");
  await alpha.waitForURL(new RegExp(`${extensionUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/src/suspended/suspended\\.html#`));
  assert.equal(fixture.hits.get("alpha-research"), beforeSuspensionHits, "suspending must not reload the source page");
  await assert.doesNotReject(() => alpha.getByRole("button", { name: "恢复页面" }).click());
  await alpha.waitForURL(`${fixture.baseUrl}/alpha-research`);

  const refreshed = await message(control, "directSuspendTab", { tabId: reactTab.id });
  assert.equal(refreshed.ok, true, "second placeholder suspension should succeed");
  await react.waitForURL(new RegExp("/src/suspended/suspended\\.html#"));
  await react.reload();
  await react.waitForURL(`${fixture.baseUrl}/react-performance`);

  const checkpoint = await message(control, "createRecoveryCheckpoint");
  assert.equal(checkpoint.ok, true, "creating a recovery checkpoint should succeed");
  assert.ok(checkpoint.count >= 3, "checkpoint should contain fixture pages");

  const workspace = await message(control, "saveWorkspace", { name: "E2E workspace" });
  const archived = await message(control, "toggleWorkspaceArchived", { workspaceId: workspace.id });
  assert.equal(archived.archived, true, "workspace should be archivable without closing tabs");
  const reopened = await message(control, "openWorkspace", { workspaceId: workspace.id });
  assert.equal(reopened.ok, true, "archived workspace should reopen safely");
  const restoredWorkspace = (await message(control, "getWorkspaces")).find((item) => item.id === workspace.id);
  assert.equal(restoredWorkspace.archived, false, "opening an archived workspace should resume it");

  const grouped = await message(control, "groupTabs", { title: "E2E fixture", tabIds: [alphaTab.id, reactTab.id] });
  assert.equal(grouped.ok, true, "same-window fixture pages should group");
  assert.equal(grouped.count, 2, "grouping should include both requested tabs");

  await control.getByLabel("查找页面").fill("react perf");
  await control.getByText("react-performance", { exact: false }).first().waitFor();
  await control.getByRole("button", { name: "设置" }).click();
  const settings = context.pages().find((page) => page.url().endsWith("/src/options/options.html"));
  assert.ok(settings, "side panel should open the settings page");
  await settings.getByLabel("扩展技术术语的本地关联").check();
  await settings.getByRole("radio", { name: /Ollama/ }).check();
  await settings.getByLabel("Ollama 地址").fill(fixture.baseUrl);
  await settings.getByLabel("模型名").fill("fixture:latest");
  await settings.getByRole("button", { name: "测试连接" }).click();
  await settings.getByText("已连接，发现 1 个模型").waitFor();
  await settings.getByRole("button", { name: "保存设置" }).click();

  const nativeFixture = await context.newPage();
  await nativeFixture.goto(`${fixture.baseUrl}/native-discard`);
  await active.bringToFront();
  const nativeTab = (await message(control, "getDashboard")).tabs.find((tab) => tab.url.endsWith("/native-discard"));
  await message(control, "updateSettings", { settings: { suspensionStrategy: "native-discard" } });
  const nativeDiscard = await message(control, "directSuspendTab", { tabId: nativeTab.id });
  assert.equal(nativeDiscard.ok, true, "native discard should succeed for an inactive web page");
  const afterDiscard = await message(control, "getDashboard");
  assert.ok(afterDiscard.summary.unloaded >= 1, "dashboard should report at least one unloaded page after native discard");

  console.log("E2E PASS: placeholder click restore, refresh restore, checkpoint, grouping, side-panel search, settings, and native discard");
} finally {
  await context?.close();
  await fixture.close();
  await rm(profile, { recursive: true, force: true });
}
