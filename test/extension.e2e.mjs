import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { sourceState } from "../src/shared/restoration.js";
import { verifySession } from "./session.e2e.mjs";
import { verifyExpansion } from "./expansion.e2e.mjs";

const extensionPath = path.resolve(".");

function startTestServer() {
  const hits = new Map();
  const heldPages = { enabled: false, responses: [], release() {
    this.enabled = false;
    this.responses.splice(0).forEach((send) => send());
  } };
  const ai = { requests: [], probes: [], invalid: false, forbidden: false, hold: false, release: null, aborted: 0, badProbe: false };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "fixture:latest" }, { name: "embed:latest" }] }));
      return;
    }
    if (url.pathname === "/api/show") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ capabilities: [JSON.parse(body).model === "embed:latest" ? "embedding" : "completion"] }));
      });
      return;
    }
    if (url.pathname === "/api/generate") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (ai.forbidden) {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Forbidden" }));
          return;
        }
        const payload = JSON.parse(body);
        if (!payload.prompt.includes("输入快照：")) {
          ai.probes.push(payload);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ response: ai.badProbe ? '{"ok":false}' : '{"ok":true}' }));
          return;
        }
        const input = JSON.parse(payload.prompt.split("输入快照：")[1]);
        ai.requests.push(payload);
        const plan = {
          schemaVersion: 1, snapshotId: input.snapshotId,
          groups: [{ name: "研究主题", pageIds: ai.invalid ? [999] : input.pages.map((page) => page.pageId), reason: "成员标题包含研究和性能内容；仅根据标题与域名归类。" }]
        };
        const send = () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ response: JSON.stringify(plan) }));
        };
        if (ai.hold) {
          ai.release = send;
          response.on("close", () => { if (!response.writableEnded) ai.aborted++; });
        }
        else send();
      });
      return;
    }
    const page = url.pathname.slice(1) || "home";
    hits.set(page, (hits.get(page) || 0) + 1);
    const send = () => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html><title>${page}</title><main><h1>${page}</h1><p>TabWise e2e fixture ${page}</p></main>`);
    };
    if (heldPages.enabled && page.startsWith("task-batch-")) heldPages.responses.push(send);
    else send();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    resolve({
      baseUrl: `http://127.0.0.1:${port}`,
      hits,
      ai,
      heldPages,
      close: () => { heldPages.release(); return new Promise((done) => server.close(done)); }
    });
  }));
}

async function message(extensionPage, type, payload = {}) {
  return extensionPage.evaluate(({ type, payload }) => chrome.runtime.sendMessage({ type, ...payload }), { type, payload });
}

async function waitForBrowserState(page, predicate, argument) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, argument)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Browser state did not settle before timeout");
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
  await control.getByRole("button", { name: "生成主题建议" }).waitFor();

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
  const otherWindow = await control.evaluate((url) => chrome.windows.create({ url, focused: false }), `${fixture.baseUrl}/outside-window?token=secret`);
  await control.bringToFront();
  await control.reload();
  await control.getByRole("button", { name: "预览分析输入" }).click();
  await control.locator("#ai-input-summary").filter({ hasText: "3 页" }).waitFor();
  assert.doesNotMatch(await control.locator("#ai-input-pages").textContent(), /outside-window/);
  assert.equal(fixture.ai.requests.length, 0, "preview must not invoke any model");
  const beforeAiWorkspaces = (await message(control, "getWorkspaces")).length;
  await control.getByRole("button", { name: "生成主题建议" }).click();
  await control.getByLabel("主题名称").waitFor();
  assert.equal((await message(control, "getWorkspaces")).length, beforeAiWorkspaces);
  assert.ok(await control.evaluate(() => chrome.tabGroups.query({}).then((groups) => groups.length === 0)), "generating must not group tabs");
  assert.doesNotMatch(fixture.ai.requests[0].prompt, /outside-window|token=secret|http:\/\//, "model input must match the chosen window and omit URL paths");
  assert.equal(fixture.ai.requests[0].format.additionalProperties, false);
  await control.getByLabel("主题名称").fill("可核对的研究");
  await control.locator(".ai-members label").filter({ hasText: "active-work" }).getByRole("checkbox").uncheck();
  await control.getByRole("button", { name: "保存为工作区", exact: true }).click();
  assert.equal((await message(control, "getWorkspaces")).length, beforeAiWorkspaces, "confirmation preview must not save");
  await control.getByRole("button", { name: "确认应用" }).click();
  await control.getByText("已保存工作区 · 2 页").waitFor();
  const savedAi = (await message(control, "getWorkspaces")).find((item) => item.name === "可核对的研究");
  assert.equal(savedAi.tabs.length, 2);
  assert.ok(savedAi.tabs.every((item) => !item.url.includes("active-work")));
  await control.getByRole("button", { name: "建立标签组", exact: true }).click();
  await control.getByRole("button", { name: "确认应用" }).click();
  await control.getByText("已建立标签组 · 2 页").waitFor();
  const nativeAiGroup = await control.evaluate(() => chrome.tabGroups.query({ title: "可核对的研究" }));
  assert.equal(nativeAiGroup.length, 1);
  await control.waitForFunction(() => !document.querySelector(".ai-theme-name").disabled);
  if (process.env.TABWISE_E2E_ARTIFACT_DIR) {
    const aiSection = control.locator("section").filter({ has: control.getByRole("heading", { name: "本地 AI 整理" }) });
    for (const colorScheme of ["light", "dark"]) {
      await control.emulateMedia({ colorScheme });
      await control.setViewportSize({ width: 320, height: 900 });
      assert.ok(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "AI UI must fit a narrow sidebar");
      await aiSection.screenshot({ path: path.join(process.env.TABWISE_E2E_ARTIFACT_DIR, `ai-${colorScheme}-320.png`) });
    }
    await control.emulateMedia({ colorScheme: "light" });
    await control.setViewportSize({ width: 420, height: 900 });
    await aiSection.screenshot({ path: path.join(process.env.TABWISE_E2E_ARTIFACT_DIR, "ai-light-420.png") });
  }

  await control.getByLabel("分析范围").selectOption("workspace");
  await control.getByLabel("选择工作区").selectOption(savedAi.id);
  const savedHits = new Map(fixture.hits);
  await control.getByRole("button", { name: "预览分析输入" }).click();
  await control.locator("#ai-input-summary").filter({ hasText: "2 页" }).waitFor();
  await control.getByRole("button", { name: "生成主题建议" }).click();
  await control.getByLabel("主题名称").waitFor();
  assert.deepEqual(fixture.hits, savedHits, "analyzing a saved workspace must not load its pages");
  assert.equal(await control.getByRole("button", { name: "建立标签组", exact: true }).isDisabled(), true);
  await control.getByLabel("主题名称").fill("工作区主题");
  await control.getByRole("button", { name: "保存为工作区", exact: true }).click();
  await control.getByRole("button", { name: "确认应用" }).click();
  await control.getByText("已保存工作区 · 2 页").waitFor();

  await control.getByLabel("分析范围").selectOption("selected");
  await control.locator("#ai-tab-options label").filter({ hasText: "react-performance" }).getByRole("checkbox").check();
  await control.getByRole("button", { name: "预览分析输入" }).click();
  await control.locator("#ai-input-summary").filter({ hasText: "1 页" }).waitFor();
  await control.getByRole("button", { name: "生成主题建议" }).click();
  await control.getByLabel("主题名称").waitFor();
  const selectedInput = JSON.parse(fixture.ai.requests.at(-1).prompt.split("输入快照：")[1]);
  assert.deepEqual(selectedInput.pages.map((page) => page.title), ["react-performance"]);
  await react.reload();
  await control.getByRole("button", { name: "保存为工作区", exact: true }).click();
  await control.getByRole("button", { name: "确认应用" }).click();
  await control.getByText(/页面已关闭、重新加载或变化/).waitFor();
  assert.equal((await message(control, "getWorkspaces")).length, beforeAiWorkspaces + 2, "stale suggestions must not save");

  fixture.ai.invalid = true;
  await message(control, "clearAiCache");
  await control.getByRole("button", { name: "预览分析输入" }).click();
  await control.locator("#ai-input-summary").filter({ hasText: "1 页" }).waitFor();
  await control.getByRole("button", { name: "生成主题建议" }).click();
  await control.getByText(/模型建议包含未知或重复页面/).waitFor();
  assert.equal(await control.locator(".ai-theme").count(), 0, "invalid model output must never get apply controls");
  fixture.ai.invalid = false;
  fixture.ai.hold = true;
  await control.getByRole("button", { name: "预览分析输入" }).click();
  await control.locator("#ai-input-summary").filter({ hasText: "1 页" }).waitFor();
  await control.getByRole("button", { name: "生成主题建议" }).click();
  await control.locator("#ai-status").filter({ hasText: "生成中" }).waitFor();
  await control.waitForFunction(() => document.querySelector("#generate-ai-brief").disabled);
  // Observe the HTTP request before changing the scope.
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const check = () => {
      if (fixture.ai.release) return resolve();
      if (Date.now() > deadline) return reject(new Error("held model request not received"));
      setTimeout(check, 20);
    };
    check();
  });
  await control.getByLabel("分析范围").selectOption("current");
  await control.waitForFunction(() => document.querySelector("#ai-brief").textContent.includes("范围已更新"));
  assert.ok(fixture.ai.release, "fixture must have received the request before release");
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const check = () => {
      if (fixture.ai.aborted) return resolve();
      if (Date.now() > deadline) return reject(new Error("changing scope must abort the HTTP request"));
      setTimeout(check, 20);
    };
    check();
  });
  fixture.ai.release();
  fixture.ai.hold = false;
  await control.locator("#ai-status").filter({ hasText: "请重新预览" }).waitFor();
  assert.equal(await control.locator(".ai-theme").count(), 0, "late answers must not replace a changed scope");
  await control.evaluate((id) => chrome.windows.remove(id), otherWindow.id);
  fixture.ai.forbidden = true;
  await message(control, "clearAiCache");
  await control.getByRole("button", { name: "预览分析输入" }).click();
  await control.locator("#ai-input-preview").waitFor({ state: "visible" });
  await control.getByRole("button", { name: "生成主题建议" }).click();
  await control.getByText(/OLLAMA_ORIGINS/).waitFor();
  assert.equal(await control.locator(".ai-theme").count(), 0, "forbidden model origins must not expose apply controls");
  fixture.ai.forbidden = false;

  const directPreview = await message(control, "prepareAiAnalysis", { scope: "selected", tabIds: [alphaTab.id, reactTab.id] });
  assert.equal(directPreview.ok, true);
  const directPlan = {
    schemaVersion: 1, snapshotId: directPreview.snapshot.id,
    groups: [{ name: "guarded", pageIds: [1, 2], reason: "引用研究与性能标题。" }]
  };
  assert.equal((await message(control, "acceptAiPlan", { snapshotId: directPreview.snapshot.id, answer: JSON.stringify(directPlan) })).ok, true);
  for (const payload of [
    { pageIds: [1, 999], action: "save" }, { pageIds: [1, 1], action: "save" }, { pageIds: [1], action: "close" }
  ]) assert.equal((await message(control, "applyAiGroup", { snapshotId: directPreview.snapshot.id, groupIndex: 0, name: "guarded", ...payload })).ok, false);
  assert.equal((await message(control, "getWorkspaces")).length, beforeAiWorkspaces + 2);
  const cdp = await context.newCDPSession(control);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const aiWorkerTarget = targetInfos.find((target) => target.type === "service_worker" && target.url === worker.url());
  assert.ok(aiWorkerTarget, "extension worker target should be visible in CDP");
  await worker.evaluate(() => { globalThis.__tabwiseRestartProbe = "before"; });
  const stoppedWorker = await cdp.send("Target.closeTarget", { targetId: aiWorkerTarget.targetId });
  assert.equal(stoppedWorker.success, true);
  const afterRestart = await message(control, "applyAiGroup", {
    snapshotId: directPreview.snapshot.id, groupIndex: 0, name: "重启后保存", pageIds: [1, 2], action: "save"
  });
  assert.equal(afterRestart.ok, true, "worker restarts must preserve validated snapshots");
  const restartedWorker = await waitForWorker(context);
  assert.equal(await restartedWorker.evaluate(() => globalThis.__tabwiseRestartProbe), undefined, "a fresh worker runtime must handle the confirmation");
  assert.ok((await message(control, "getOperations")).some((entry) => entry.label.includes("可核对的研究") && entry.status === "ready"), "undo records must survive worker restart");
  assert.equal((await message(control, "applyAiGroup", {
    snapshotId: directPreview.snapshot.id, groupIndex: 0, name: "重启后保存", pageIds: [1, 2], action: "save"
  })).ok, false, "a confirmed action cannot be applied twice");
  await cdp.detach();
  const navigationPreview = await message(control, "prepareAiAnalysis", { scope: "selected", tabIds: [alphaTab.id, reactTab.id] });
  const navigationPlan = { ...directPlan, snapshotId: navigationPreview.snapshot.id };
  assert.equal((await message(control, "acceptAiPlan", { snapshotId: navigationPreview.snapshot.id, answer: JSON.stringify(navigationPlan) })).ok, true);
  await alpha.goto(`${fixture.baseUrl}/changed`);
  await alpha.goto(`${fixture.baseUrl}/alpha-research`);
  assert.equal((await message(control, "applyAiGroup", {
    snapshotId: navigationPreview.snapshot.id, groupIndex: 0, name: "guarded", pageIds: [1, 2], action: "save"
  })).ok, false, "A → B → A navigation must invalidate the original snapshot");
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
  const denied = await message(popup, "prepareAiAnalysis", { scope: "current" });
  assert.equal(denied.ok, false, "AI APIs must reject non-side-panel senders");

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
  const review = await message(control, "runResourceReview");
  assert.equal(review.ok, true, "manual resource review should complete safely");
  assert.ok(review.review.checkpointTabCount >= 3, "resource review should save a recovery checkpoint");
  assert.equal((await message(control, "getResourceReviews"))[0].trigger, "manual", "resource review should retain an audit entry");

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
  const settingsPage = context.waitForEvent("page");
  await control.getByRole("button", { name: "设置" }).click();
  const settings = await settingsPage;
  await settings.waitForURL(/\/src\/options\/options\.html$/);
  await settings.getByLabel("扩展技术术语的本地关联").check();
  await settings.getByLabel("每天保存恢复点并巡检资源").check();
  await settings.getByLabel("运行时间").fill("18:00");
  await settings.getByLabel("归档长期未打开的工作区").check();
  await settings.getByLabel("归档阈值").fill("30");
  await settings.getByRole("radio", { name: /Ollama/ }).check();
  await settings.getByLabel("Ollama 地址").fill(fixture.baseUrl);
  await settings.getByLabel("模型名").fill("fixture:latest");
  await settings.getByRole("button", { name: "模型自检", exact: true }).click();
  await settings.getByText(/自检通过 · JSON 有效/).waitFor();
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

  await message(control, "updateSettings", { settings: { aiProvider: "browser" } });
  await control.reload();
  await control.getByRole("button", { name: "预览分析输入" }).click();
  await control.locator("#ai-input-summary").filter({ hasText: "浏览器内置模型" }).waitFor();
  await control.getByRole("button", { name: "生成主题建议" }).click();
  await control.locator("#ai-status").filter({ hasText: "不可用" }).waitFor();
  assert.equal(await control.locator(".ai-theme").count(), 0, "unavailable browser models must not suggest actions");
  // Deterministic fake browser provider verifies the same snapshot contract.
  await control.evaluate(() => {
    globalThis.LanguageModel = {
      availability: async () => "available",
      create: async () => ({
        prompt: async (prompt) => {
          const input = JSON.parse(prompt.split("输入快照：")[1]);
          return JSON.stringify({
            schemaVersion: 1, snapshotId: input.snapshotId,
            groups: [{ name: "浏览器主题", pageIds: [input.pages[0].pageId], reason: `标题依据：${input.pages[0].title}` }]
          });
        },
        destroy() {}
      })
    };
  });
  await control.getByRole("button", { name: "预览分析输入" }).click();
  await control.locator("#ai-input-summary").filter({ hasText: "浏览器内置模型" }).waitFor();
  await control.getByRole("button", { name: "生成主题建议" }).click();
  await control.getByLabel("主题名称").waitFor();
  assert.equal(await control.getByLabel("主题名称").inputValue(), "浏览器主题");
  await control.getByRole("button", { name: "保存为工作区", exact: true }).click();
  await control.getByRole("button", { name: "确认应用" }).click();
  await control.getByText("已保存工作区 · 1 页").waitFor();

  // Unified undo: original groups (including one removed by regrouping), order,
  // workspace conflicts, suspension, replay and worker persistence.
  await control.bringToFront();
  await message(control, "updateSettings", { settings: { suspensionStrategy: "placeholder", aiProvider: "ollama" } });
  const undoTabs = await control.evaluate(async (base) => {
    const tabs = [];
    for (let i = 0; i < 4; i++) {
      const url = `${base}/undo-${i}`;
      tabs.push({ ...await chrome.tabs.create({ url, active: false }), url });
    }
    return tabs;
  }, fixture.baseUrl);
  await waitForBrowserState(control, (expected) => chrome.tabs.query({}).then((tabs) => expected.every((item) => tabs.some((tab) => tab.id === item.id && tab.url === item.url && !tab.pendingUrl && tab.status === "complete"))), undoTabs);
  const originalGroup = await control.evaluate(async (tabs) => {
    const id = await chrome.tabs.group({ tabIds: [tabs[0].id, tabs[1].id] });
    await chrome.tabGroups.update(id, { title: "原分组", color: "blue" });
    return id;
  }, undoTabs);
  const beforeOrder = await control.evaluate((windowId) => chrome.tabs.query({ windowId }).then((tabs) => tabs.map((tab) => tab.id)), undoTabs[0].windowId);
  const undoState = await control.evaluate((tabs) => Promise.all(tabs.map((tab) => chrome.tabs.get(tab.id))), undoTabs);
  const regroup = await message(control, "groupTabs", { tabIds: [undoTabs[0].id, undoTabs[1].id, undoTabs[3].id], title: "撤销测试" });
  assert.equal(regroup.ok, true, JSON.stringify({ regroup, undoState }));
  const undo = await message(control, "undoOperation", { operationId: regroup.operationId });
  if (!undo.restored) {
    const mismatch = await control.evaluate(async ({ id, windowId }) => ({
      saved: (await chrome.storage.session.get("operationJournal")).operationJournal.find((item) => item.id === id).items[0].after,
      current: {
        tabs: (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index).map(({ id, url, index, windowId, groupId, pinned }) => ({ id, url, index, windowId, groupId, pinned })),
        groups: (await chrome.tabGroups.query({ windowId })).sort((a, b) => a.id - b.id).map(({ id, title, color, collapsed }) => ({ id, title, color, collapsed }))
      }
    }), { id: regroup.operationId, windowId: undoTabs[0].windowId });
    assert.fail(JSON.stringify({ undo, mismatch }));
  }
  const restoredGroups = await control.evaluate(() => chrome.tabGroups.query({ title: "原分组" }));
  assert.equal(restoredGroups.length, 1);
  assert.equal(restoredGroups[0].color, "blue");
  assert.deepEqual(await control.evaluate((windowId) => chrome.tabs.query({ windowId }).then((tabs) => tabs.map((tab) => tab.id)), undoTabs[0].windowId), beforeOrder);
  assert.equal((await message(control, "undoOperation", { operationId: regroup.operationId })).ok, false);
  assert.ok(originalGroup !== restoredGroups[0].id, "removed original group should be recreated");
  const changedGrouping = await message(control, "groupTabs", { tabIds: [undoTabs[2].id, undoTabs[3].id], title: "冲突测试" });
  await control.evaluate((id) => chrome.tabs.ungroup(id), undoTabs[2].id);
  const conflictUndo = await message(control, "undoOperation", { operationId: changedGrouping.operationId });
  assert.equal(conflictUndo.restored, 0);
  assert.match(conflictUndo.results[0].reason, /已变化/);

  const savedUndo = await message(control, "saveWorkspace", { name: "撤销工作区" });
  const saveEntry = (await message(control, "getOperations"))[0];
  const archiveUndo = await message(control, "toggleWorkspaceArchived", { workspaceId: savedUndo.id });
  assert.equal(archiveUndo.archived, true);
  const archiveEntry = (await message(control, "getOperations"))[0];
  assert.equal((await message(control, "undoOperation", { operationId: archiveEntry.id })).restored, 1);
  assert.deepEqual((await message(control, "getWorkspaces")).find((item) => item.id === savedUndo.id), savedUndo);
  assert.equal((await message(control, "undoOperation", { operationId: saveEntry.id })).restored, 1);
  assert.equal((await message(control, "getWorkspaces")).some((item) => item.id === savedUndo.id), false);
  const modifiedWorkspace = await message(control, "saveWorkspace", { name: "保留手动修改" });
  const modifyEntry = (await message(control, "getOperations"))[0];
  await message(control, "toggleWorkspacePinned", { workspaceId: modifiedWorkspace.id });
  assert.equal((await message(control, "undoOperation", { operationId: modifyEntry.id })).restored, 0);
  const sleepingUndo = await message(control, "directSuspendTab", { tabId: undoTabs[2].id });
  assert.equal(sleepingUndo.ok, true);
  await waitForBrowserState(control, (id) => chrome.tabs.get(id).then((tab) => tab.url.includes("suspended.html")), undoTabs[2].id);
  const sleepEntry = (await message(control, "getOperations"))[0];
  assert.equal((await message(control, "undoOperation", { operationId: sleepEntry.id })).restored, 1);
  await waitForBrowserState(control, ({ id, url }) => chrome.tabs.get(id).then((tab) => tab.url === url && tab.status === "complete"), undoTabs[2]);

  // Cache reuse requires a new snapshot, preserves exact membership and avoids
  // another provider request. Stop disconnects HTTP and cancelled output cannot
  // be accepted, even if the provider tries to deliver it.
  await message(control, "clearAiCache");
  const cacheInput = { scope: "selected", tabIds: [undoTabs[0].id, undoTabs[1].id], request: "缓存测试" };
  const preview1 = await message(control, "prepareAiAnalysis", cacheInput);
  const generated = await message(control, "generateAiThemes", { snapshotId: preview1.snapshot.id });
  assert.equal(generated.ok, true);
  const requestCount = fixture.ai.requests.length;
  const preview2 = await message(control, "prepareAiAnalysis", { ...cacheInput, tabIds: [...cacheInput.tabIds].reverse() });
  const cached = await message(control, "generateAiThemes", { snapshotId: preview2.snapshot.id });
  assert.equal(cached.cached, true);
  assert.equal(cached.plan.snapshotId, preview2.snapshot.id);
  assert.deepEqual(cached.plan.groups[0].pageIds, [2, 1]);
  assert.equal(fixture.ai.requests.length, requestCount);
  await message(control, "clearAiCache");
  const preview3 = await message(control, "prepareAiAnalysis", cacheInput);
  assert.equal((await message(control, "generateAiThemes", { snapshotId: preview3.snapshot.id })).ok, true);
  assert.equal(fixture.ai.requests.length, requestCount + 1);

  await control.reload();
  await control.getByLabel("分析范围").selectOption("selected");
  await control.locator("#ai-tab-options label").filter({ hasText: "undo-0" }).getByRole("checkbox").check();
  await control.getByRole("button", { name: "清空建议缓存" }).click();
  await control.getByRole("button", { name: "预览分析输入" }).click();
  await control.locator("#ai-input-preview").waitFor({ state: "visible" });
  fixture.ai.hold = true;
  fixture.ai.release = null;
  const abortCount = fixture.ai.aborted;
  await control.getByRole("button", { name: "生成主题建议" }).click();
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const check = () => {
      if (fixture.ai.release) return resolve();
      if (Date.now() > deadline) return reject(new Error("stop fixture did not receive request"));
      setTimeout(check, 20);
    };
    check();
  });
  await control.getByRole("button", { name: "停止生成" }).click();
  await control.getByText("生成已停止，请重新预览后再试。").waitFor();
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const check = () => {
      if (fixture.ai.aborted > abortCount) return resolve();
      if (Date.now() > deadline) return reject(new Error("stop must abort provider HTTP"));
      setTimeout(check, 20);
    };
    check();
  });
  fixture.ai.hold = false;

  const stoppedSnapshot = await control.evaluate(() => chrome.storage.session.get("aiAnalysisSnapshots").then((data) => data.aiAnalysisSnapshots.at(-1)));
  const stoppedAnswer = { schemaVersion: 1, snapshotId: stoppedSnapshot.id, groups: [{ name: "迟到输出", pageIds: [1], reason: "标题依据" }] };
  const rejectedLate = await message(control, "acceptAiPlan", { snapshotId: stoppedSnapshot.id, answer: JSON.stringify(stoppedAnswer) });
  assert.equal(rejectedLate.ok, false);
  assert.match(rejectedLate.reason, /取消/);
  assert.equal((await message(control, "generateAiThemes", { snapshotId: stoppedSnapshot.id })).ok, false);

  const optionsCheck = await context.newPage();
  await optionsCheck.goto(`${extensionUrl}/src/options/options.html`);
  await optionsCheck.locator("#ollama-endpoint").fill(fixture.baseUrl);
  await optionsCheck.locator("#ollama-model").fill("fixture:latest");
  await optionsCheck.locator("#ai-provider-ollama").check();
  await optionsCheck.getByRole("button", { name: "模型自检", exact: true }).click();
  await optionsCheck.getByText(/自检通过 · JSON 有效/).waitFor();
  const successfulProbeCount = fixture.ai.probes.length;
  assert.ok(successfulProbeCount >= 2);
  const embedChoice = await optionsCheck.locator('#ollama-model-choice option[value="embed:latest"]').evaluate((option) => ({ disabled: option.disabled, text: option.textContent }));
  assert.equal(embedChoice.disabled, true, JSON.stringify(embedChoice));
  await optionsCheck.locator("#ollama-model").fill("embed:latest");
  await optionsCheck.getByRole("button", { name: "模型自检", exact: true }).click();
  await optionsCheck.getByText(/不支持文本生成/).waitFor();
  assert.equal(fixture.ai.probes.length, successfulProbeCount, "embedding-only model must not receive a completion probe");
  await optionsCheck.locator("#ollama-model").fill("fixture:latest");
  fixture.ai.badProbe = true;
  await optionsCheck.getByRole("button", { name: "模型自检", exact: true }).click();
  await optionsCheck.getByText(/JSON 不符合要求/).waitFor();
  fixture.ai.badProbe = false;
  fixture.ai.forbidden = true;
  await optionsCheck.getByRole("button", { name: "模型自检", exact: true }).click();
  await optionsCheck.getByText(/OLLAMA_ORIGINS/).waitFor();
  fixture.ai.forbidden = false;
  await optionsCheck.locator("#ai-provider-browser").check();
  await optionsCheck.getByRole("button", { name: "自检浏览器模型" }).click();
  await optionsCheck.locator("#browser-model-feedback").filter({ hasText: /未提供|尚未|不可用|自检通过/ }).waitFor();

  // Precise search and selective restores must never open an entire saved set.
  const preciseWorkspace = {
    id: "precise-fixture", name: "精准恢复测试", createdAt: 1, tabs: [
      { title: "precise-one", url: `${fixture.baseUrl}/precise-one` },
      { title: "precise-two", url: `${fixture.baseUrl}/precise-two` },
      { title: "outside-window", url: `${fixture.baseUrl}/outside-window?token=secret` }
    ]
  };
  const restoreOtherWindow = await control.evaluate((url) => chrome.windows.create({ url, focused: false }), preciseWorkspace.tabs[2].url);
  await waitForBrowserState(control, (id) => chrome.tabs.query({ windowId: id }).then((tabs) => tabs.some((tab) => tab.status === "complete" && !tab.pendingUrl)), restoreOtherWindow.id);
  await control.evaluate(async (workspace) => {
    const { workspaces = [] } = await chrome.storage.local.get("workspaces");
    await chrome.storage.local.set({ workspaces: [...workspaces, workspace] });
  }, preciseWorkspace);
  const preciseResult = (await message(control, "searchPages", { query: "precise-one", limit: 100 })).find((item) => item.workspaceId === preciseWorkspace.id && item.itemIndex === 0);
  const beforePrecise = (await message(control, "getDashboard")).tabs.length;
  assert.equal((await message(control, "openSearchResult", { result: preciseResult })).count, 1);
  assert.equal((await message(control, "getDashboard")).tabs.length, beforePrecise + 1);
  assert.equal(fixture.hits.get("precise-two"), undefined, "search must open only one matched page");
  assert.equal((await message(control, "openSearchResult", { result: preciseResult })).focused, true);
  assert.equal((await message(control, "openSearchResult", { result: { ...preciseResult, url: `${fixture.baseUrl}/forged` } })).ok, false);
  await control.bringToFront();
  const previewRestore = await message(control, "prepareRestore", { kind: "workspace", sourceId: preciseWorkspace.id });
  assert.equal(previewRestore.pages[0].existing, true);
  assert.equal(previewRestore.pages[2].existing, true, "preview must detect existing pages in other windows");
  assert.equal((await message(control, "confirmRestore", { previewId: previewRestore.previewId, indices: [] })).ok, false);
  const selectedRestore = await message(control, "confirmRestore", { previewId: previewRestore.previewId, indices: [1, 2] });
  assert.equal(selectedRestore.count, 1);
  assert.equal(selectedRestore.skipped, 1);
  assert.equal((await message(control, "getWorkspaces")).find((item) => item.id === preciseWorkspace.id).lastOpenedAt > 0, true);
  assert.equal((await message(control, "confirmRestore", { previewId: previewRestore.previewId, indices: [1] })).ok, false, "restore preview is single-use");
  const staleRestore = await message(control, "prepareRestore", { kind: "workspace", sourceId: preciseWorkspace.id });
  const originalPrecise = (await message(control, "getWorkspaces")).find((item) => item.id === preciseWorkspace.id);
  assert.equal((await message(control, "editWorkspace", { workspaceId: preciseWorkspace.id, signature: sourceState(originalPrecise), name: "编辑后的工作区", indices: [0, 1] })).ok, true);
  assert.equal((await message(control, "confirmRestore", { previewId: staleRestore.previewId, indices: [0] })).ok, false, "stale saved content must not restore");
  const checkpointSource = { id: "selective-checkpoint", createdAt: Date.now(), tabs: [
    { title: "checkpoint-one", url: `${fixture.baseUrl}/checkpoint-one` }, { title: "checkpoint-two", url: `${fixture.baseUrl}/checkpoint-two` }
  ] };
  await control.evaluate(async (checkpoint) => {
    const { recoveryCheckpoints = [] } = await chrome.storage.local.get("recoveryCheckpoints");
    await chrome.storage.local.set({ recoveryCheckpoints: [checkpoint, ...recoveryCheckpoints].slice(0, 10) });
  }, checkpointSource);
  const checkpointResult = (await message(control, "searchPages", { query: "checkpoint-one", limit: 100 })).find((item) => item.checkpointId === checkpointSource.id && item.itemIndex === 0);
  assert.equal((await message(control, "openSearchResult", { result: checkpointResult })).count, 1);
  assert.equal(fixture.hits.get("checkpoint-two"), undefined);
  await control.bringToFront();
  await control.reload();
  const preciseRow = control.locator(".saved-workspace").filter({ hasText: "编辑后的工作区" });
  await preciseRow.getByRole("button", { name: "选择恢复" }).click();
  await control.locator("#restore-preview").waitFor({ state: "visible" });
  await control.locator("#restore-preview").getByRole("button", { name: "全不选" }).click();
  assert.equal(await control.getByRole("button", { name: "恢复所选页面" }).isDisabled(), true);
  await control.locator("#restore-preview").getByRole("button", { name: "全选" }).click();
  await control.getByRole("button", { name: "恢复所选页面" }).click();
  await control.locator(".restore-result").filter({ hasText: "跳过 2 页" }).waitFor();
  await control.getByRole("button", { name: "关闭预览" }).click();
  await preciseRow.getByRole("button", { name: "编辑", exact: true }).click();
  await control.locator(".workspace-editor input[name=workspace-name]").fill("UI编辑工作区");
  await control.locator(".workspace-editor .saved-member input").nth(1).uncheck();
  await control.getByRole("button", { name: "保存修改", exact: true }).click();
  await control.locator(".workspace-editor").waitFor({ state: "hidden" });
  const edited = (await message(control, "getWorkspaces")).find((item) => item.id === preciseWorkspace.id);
  assert.equal(edited.tabs.length, 1);
  await message(control, "trashWorkspace", { workspaceId: preciseWorkspace.id });
  const trashOperation = (await message(control, "getOperations"))[0];
  assert.equal((await message(control, "getWorkspaces")).some((item) => item.id === preciseWorkspace.id), false);
  assert.equal((await message(control, "searchPages", { query: "precise", limit: 100 })).some((item) => item.workspaceId === preciseWorkspace.id), false);
  assert.equal((await message(control, "prepareAiAnalysis", { scope: "workspace", workspaceId: preciseWorkspace.id })).ok, false, "trash must not feed AI");
  assert.equal((await message(control, "undoOperation", { operationId: trashOperation.id })).restored, 1);
  await message(control, "trashWorkspace", { workspaceId: preciseWorkspace.id });
  assert.equal((await message(control, "restoreWorkspaceTrash", { workspaceId: preciseWorkspace.id })).ok, true);
  const mergeSource = (await message(control, "getWorkspaces")).find((item) => item.id !== preciseWorkspace.id);
  const merged = await message(control, "mergeWorkspaces", {
    workspaceIds: [edited.id, mergeSource.id], signatures: { [edited.id]: sourceState(edited), [mergeSource.id]: sourceState(mergeSource) }, name: "合并的工作区"
  });
  assert.equal(merged.ok, true);
  assert.equal(new Set(merged.workspace.tabs.map((item) => item.url)).size, merged.workspace.tabs.length);
  assert.equal((await message(control, "getWorkspaces")).some((item) => item.id === mergeSource.id), true);
  await message(control, "trashWorkspace", { workspaceId: preciseWorkspace.id });
  const inTrash = (await message(control, "getWorkspaceTrash")).find((item) => item.id === preciseWorkspace.id);
  assert.equal((await message(control, "deleteWorkspacePermanently", { workspaceId: inTrash.id, signature: sourceState(inTrash) })).ok, false);
  assert.equal((await message(control, "deleteWorkspacePermanently", { workspaceId: inTrash.id, signature: sourceState(inTrash), confirm: true })).ok, true);
  assert.equal((await message(control, "getWorkspaceTrash")).some((item) => item.id === inTrash.id), false);

  // Minute scheduling, catch-up, persistent failure and interrupted-run recovery.
  await message(control, "updateSettings", { settings: { scheduledReviewEnabled: true, scheduledReviewHour: 18, scheduledReviewMinute: 35 } });
  const configuredAlarm = await control.evaluate(() => chrome.alarms.get("tabwise-resource-review"));
  assert.equal(new Date(configuredAlarm.scheduledTime).getMinutes(), 35);
  assert.equal(configuredAlarm.periodInMinutes, undefined, "daily task must rearm in local time");
  const missedSlot = Date.now() - 120_000;
  await control.evaluate((dueAt) => chrome.storage.local.set({ resourceReviewSchedule: { signature: "18:35", dueAt } }), missedSlot);
  await message(control, "updateSettings", { settings: {} });
  assert.equal((await message(control, "getResourceReviews")).filter((item) => item.scheduledSlot === missedSlot).length, 1);
  await control.evaluate((dueAt) => chrome.storage.local.set({ resourceReviewSchedule: { signature: "18:35", dueAt } }), missedSlot);
  await message(control, "updateSettings", { settings: {} });
  assert.equal((await message(control, "getResourceReviews")).filter((item) => item.scheduledSlot === missedSlot).length, 1, "catch-up must not replay");
  await message(control, "updateSettings", { settings: { scheduledReviewEnabled: false } });
  const reviewWorker = await waitForWorker(context);
  await reviewWorker.evaluate(() => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    let fail = true;
    chrome.tabs.query = (...args) => { if (fail) { fail = false; throw new Error("fixture review failure"); } return query(...args); };
  });
  const failedReview = await message(control, "runResourceReview");
  assert.equal(failedReview.ok, false);
  assert.equal((await message(control, "getResourceReviews"))[0].status, "failed");
  assert.equal((await message(control, "retryResourceReview", { reviewId: failedReview.review.id })).ok, true);
  assert.equal((await message(control, "retryResourceReview", { reviewId: failedReview.review.id })).ok, false);
  await control.evaluate(async () => {
    const { resourceReviews } = await chrome.storage.local.get("resourceReviews");
    await chrome.storage.local.set({ resourceReviews: [{ id: "interrupted-fixture", status: "running", createdAt: Date.now(), trigger: "scheduled", scheduledSlot: 1 }, ...resourceReviews] });
  });
  const restartSession = await context.newCDPSession(control);
  const restartTargets = await restartSession.send("Target.getTargets");
  const reviewTarget = restartTargets.targetInfos.find((item) => item.type === "service_worker" && item.url === reviewWorker.url());
  await restartSession.send("Target.closeTarget", { targetId: reviewTarget.targetId });
  assert.equal((await message(control, "getResourceReviews")).find((item) => item.id === "interrupted-fixture").status, "interrupted");
  await restartSession.detach();

  await verifySession({ context, control, fixture, extensionUrl, message, waitForBrowserState, waitForWorker });
  await verifyExpansion({ context, control, fixture, extensionUrl, message, waitForBrowserState, waitForWorker });
  if (process.env.TABWISE_E2E_ARTIFACT_DIR) {
    await control.reload();
    await control.locator(".operation-item").first().waitFor();
    for (const colorScheme of ["light", "dark"]) {
      await control.emulateMedia({ colorScheme });
      await control.setViewportSize({ width: 320, height: 900 });
      assert.ok(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await control.screenshot({ path: path.join(process.env.TABWISE_E2E_ARTIFACT_DIR, `operations-${colorScheme}-320.png`), fullPage: true });
      const workspaceSection = control.locator("section").filter({ has: control.locator("#workspace-manager") });
      await workspaceSection.screenshot({ path: path.join(process.env.TABWISE_E2E_ARTIFACT_DIR, `workspaces-${colorScheme}-320.png`) });
      await control.locator(".saved-workspace").filter({ hasText: "合并的工作区" }).getByRole("button", { name: "选择恢复" }).click();
      await control.locator("#restore-preview").screenshot({ path: path.join(process.env.TABWISE_E2E_ARTIFACT_DIR, `restore-${colorScheme}-320.png`) });
      assert.ok(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "restore controls must fit 320px");
      await control.locator("#restore-preview").getByRole("button", { name: "取消", exact: true }).click();
      await optionsCheck.emulateMedia({ colorScheme });
      await optionsCheck.setViewportSize({ width: 420, height: 900 });
      await optionsCheck.locator("#ai-provider-ollama").check();
      assert.ok(await optionsCheck.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await optionsCheck.screenshot({ path: path.join(process.env.TABWISE_E2E_ARTIFACT_DIR, `self-check-${colorScheme}-420.png`), fullPage: true });
    }
    const popupVisual = await context.newPage();
    await popupVisual.goto(`${extensionUrl}/src/popup/popup.html`);
    await popupVisual.locator(".saved-workspace").first().waitFor();
    await popupVisual.setViewportSize({ width: 410, height: 900 });
    for (const colorScheme of ["light", "dark"]) {
      await popupVisual.emulateMedia({ colorScheme });
      await popupVisual.locator(".workspace-section").screenshot({ path: path.join(process.env.TABWISE_E2E_ARTIFACT_DIR, `popup-workspaces-${colorScheme}-410.png`) });
      assert.ok(await popupVisual.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  }
  console.log("E2E PASS: precise search, selective restore, workspace edit/merge/trash/undo, minute alarms/catch-up/failure/retry/restart; AI cancellation/cache and existing tab workflows");
} finally {
  await context?.close();
  await fixture.close();
  await rm(profile, { recursive: true, force: true });
}
