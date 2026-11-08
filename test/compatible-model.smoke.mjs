import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { verifyModelTask } from "./model-task.e2e.mjs";
import { show } from "./ui-navigation.mjs";

const channel = process.env.TABWISE_MODEL_CHANNEL || "chromium";
const artifacts = process.env.TABWISE_E2E_ARTIFACT_DIR || await mkdtemp(path.join(os.tmpdir(), "tabwise-compatible-"));
const profile = await mkdtemp(path.join(os.tmpdir(), "tabwise-model-profile-"));
const credential = "synthetic-test-credential";
let context, mode = "valid", release, heldResolve, aborted = false;
const requests = [];
const server = createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "access-control-allow-origin": request.headers.origin || "*",
      "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type" });
    response.end(); return;
  }
  if (!["/v1/models", "/v1/chat/completions"].includes(request.url)) {
    response.end("<title>Protocol source</title>"); return;
  }
  if (request.url === "/source") { response.end("<title>Protocol source</title>"); return; }
  assert.equal(request.headers.authorization, `Bearer ${credential}`, "API auth is sent only to the configured service");
  if (request.url === "/v1/models") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "fixture-model" }, { id: "other-model" }] })); return;
  }
  assert.equal(request.url, "/v1/chat/completions");
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    const payload = JSON.parse(raw);
    requests.push(payload);
    if (mode === "429") { response.writeHead(429); response.end(credential); return; }
    if (mode === "redirect") { response.writeHead(307, { location: "/unexpected" }); response.end(); return; }
    const prompt = payload.messages.at(-1).content;
    let answer = { ok: true };
    if (prompt.includes("任务上下文：")) {
      const input = JSON.parse(prompt.split("任务上下文：")[1]);
      answer = { schemaVersion: 1, snapshotId: input.snapshotId, summary: "继续验证占位恢复和原生卸载的页面加载差异。",
        hypotheses: [{ text: "资料说明两种恢复触发方式不同，仍需实际核对。", sourceIds: input.sources.map((source) => source.sourceId) }],
        questions: [], nextSteps: [{ text: "记录两种恢复方式的请求次数。", sourceIds: input.sources.map((source) => source.sourceId) }] };
      if (mode === "invalid") answer.nextSteps[0].sourceIds = ["foreign-source"];
    } else if (prompt.includes("输入快照：")) {
      const input = JSON.parse(prompt.split("输入快照：")[1]);
      answer = { schemaVersion: 1, snapshotId: input.snapshotId,
        groups: [{ name: "协议验证资料", reason: "按照选定标题归类。", pageIds: input.pages.map((page) => page.pageId) }] };
    }
    const send = () => { response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }], usage: { total_tokens: 123 } })); };
    if (mode === "hold") {
      release = send;
      heldResolve?.();
      response.on("close", () => { if (!response.writableEnded) aborted = true; });
    } else send();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const launch = () => chromium.launchPersistentContext(profile, { channel, headless: true,
  args: [`--disable-extensions-except=${path.resolve(".")}`, `--load-extension=${path.resolve(".")}`] });
try {
  context = await launch();
  const worker = context.serviceWorkers().find((item) => item.url().includes("service-worker.js")) || await context.waitForEvent("serviceworker");
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const options = await context.newPage();
  await options.goto(`${origin}/src/options/options.html`);
  await options.locator("#ai-provider-compatible").check();
  await options.locator("#compatible-endpoint").fill(endpoint);
  await options.locator("#compatible-model").fill("fixture-model");
  await options.locator("#compatible-key").fill(credential);
  await options.locator("#test-compatible").click();
  await options.locator("#compatible-feedback").filter({ hasText: "自检通过" }).waitFor();
  assert.equal(await options.locator("#compatible-key").inputValue(), "", "key fields are cleared after save");
  assert.equal(requests.length, 1);
  await options.locator("#list-compatible").click();
  await options.locator("#compatible-feedback").filter({ hasText: "已读取 2 个模型" }).waitFor();
  const sendOptions = (type, fields = {}) => options.evaluate(({ type, fields }) => chrome.runtime.sendMessage({ type, ...fields }), { type, fields });
  assert.equal((await sendOptions("getModelCredentialStatus")).persistence, "session");
  const local = await options.evaluate(() => chrome.storage.local.get(null));
  assert.ok(!JSON.stringify(local).includes(credential), "default key never enters local task/setting storage");
  const control = await context.newPage();
  await control.goto(`${origin}/src/sidepanel/sidepanel.html`);
  const send = (type, fields = {}) => control.evaluate(({ type, fields }) => chrome.runtime.sendMessage({ type, ...fields }), { type, fields });
  assert.equal((await send("clearModelCredential")).ok, false, "sidepanel cannot read or write credentials");
  const task = await verifyModelTask(control, { label: "兼容 API", artifacts, context });
  assert.equal(task.acceptedBrief.provider, "compatible");
  assert.equal(requests.length, 2, "preview and adoption do not call the provider");
  assert.ok(!JSON.stringify(requests).includes("synthetic-private"));
  const exported = await send("exportContextTask", { taskId: task.id });
  assert.ok(!exported.json.includes(credential));
  const before = (await send("getDashboard")).tabs.length;
  for (const errorMode of ["invalid", "429", "redirect"]) {
    mode = errorMode;
    const preview = await send("prepareContextBrief", { taskId: task.id, sourceIds: task.sources.map((item) => item.id) });
    const generated = await send("generateContextBrief", { snapshotId: preview.snapshot.id });
    assert.equal(generated.ok, false, errorMode);
    assert.ok(!generated.reason.includes(credential));
    assert.equal((await send("listContextTasks")).tasks.find((t) => t.id === task.id).acceptedBrief.summary, task.acceptedBrief.summary);
  }
  mode = "valid";
  const stale = await send("prepareContextBrief", { taskId: task.id, sourceIds: [] });
  await options.locator("#save-compatible").click();
  await options.locator("#compatible-feedback").filter({ hasText: "模型配置已保存" }).waitFor();
  const callsBefore = requests.length;
  assert.equal((await send("generateContextBrief", { snapshotId: stale.snapshot.id })).ok, false);
  assert.equal(requests.length, callsBefore, "credential revision invalidates previews before a request");
  mode = "hold";
  const prepared = await send("prepareContextBrief", { taskId: task.id, sourceIds: [] });
  const received = new Promise((resolve) => { heldResolve = resolve; });
  const pending = send("generateContextBrief", { snapshotId: prepared.snapshot.id });
  await received;
  assert.ok(release, "request reached the fixture");
  await send("cancelContextBrief", { snapshotId: prepared.snapshot.id });
  release();
  assert.equal((await pending).ok, false);
  assert.equal((await send("getDashboard")).tabs.length, before);
  mode = "valid";
  const theme = await send("prepareAiAnalysis", { scope: "workspace", workspaceId: "model-source", request: "归类资料" });
  assert.equal(theme.ok, true);
  const themes = await send("generateAiThemes", { snapshotId: theme.snapshot.id });
  assert.equal(themes.ok, true);
  assert.equal(themes.plan.groups[0].name, "协议验证资料");
  const staleTheme = await send("prepareAiAnalysis", { scope: "workspace", workspaceId: "model-source", request: "归类资料" });
  await options.locator("#clear-model-key").click();
  await options.locator("#compatible-feedback").filter({ hasText: "密钥已清除" }).waitFor();
  const themeCalls = requests.length;
  assert.equal((await send("generateAiThemes", { snapshotId: staleTheme.snapshot.id })).ok, false);
  assert.equal(requests.length, themeCalls, "cache cannot cross credential revisions");
  await options.locator("#compatible-key").fill(credential);
  await options.locator("#persist-model-key").check();
  await options.locator("#save-compatible").click();
  await options.locator("#compatible-feedback").filter({ hasText: "模型配置已保存" }).waitFor();
  assert.equal((await sendOptions("getModelCredentialStatus")).persistence, "local");
  const download = options.waitForEvent("download");
  await (await show(options, "#export-backup")).click();
  assert.ok(!(await readFile(await (await download).path(), "utf8")).includes(credential), "backup excludes persistent provider keys");
  const web = await context.newPage();
  await web.goto(`http://127.0.0.1:${server.address().port}/source`);
  const denied = await options.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url);
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async () => {
      const blocked = [];
      for (const area of ["local", "session"]) {
        try { await chrome.storage[area].get("modelCredential"); blocked.push(false); } catch { blocked.push(true); }
      }
      return blocked;
    } });
    return results[0].result;
  }, web.url());
  assert.deepEqual(denied, [true, true], "content scripts cannot read either key storage");
  await show(options, "#compatible-config");
  for (const colorScheme of ["light", "dark"]) {
    await options.emulateMedia({ colorScheme }); await options.setViewportSize({ width: 320, height: 900 });
    assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "model options fit 320px");
    await options.locator("#compatible-config").screenshot({ path: `${artifacts}/model-options-${colorScheme}-320.png` });
  }
  await context.close();
  context = await launch();
  const reloaded = await context.newPage();
  await reloaded.goto(`${origin}/src/options/options.html`);
  const status = await reloaded.evaluate(() => chrome.runtime.sendMessage({ type: "getModelCredentialStatus" }));
  assert.equal(status.hasKey, true); assert.equal(status.persistence, "local");
  await reloaded.locator("#persist-model-key").uncheck();
  await reloaded.locator("#save-compatible").click();
  await reloaded.locator("#compatible-feedback").filter({ hasText: "模型配置已保存" }).waitFor();
  await context.close(); context = await launch();
  const sessionReload = await context.newPage();
  await sessionReload.goto(`${origin}/src/options/options.html`);
  assert.equal((await sessionReload.evaluate(() => chrome.runtime.sendMessage({ type: "getModelCredentialStatus" }))).hasKey, false);
  await writeFile(`${artifacts}/compatible-${channel}-result.json`, JSON.stringify({ channel, browser: await context.browser().version(),
    requests: requests.length, aborted, cases: ["JSON probe", "model list", "cited task", "edited adoption", "exports", "schema rejection", "429", "redirect", "stale config", "cancellation", "theme generation", "key isolation", "persistent/session restart"] }, null, 2));
  console.log(`Compatible API fixture PASS: ${channel}, task/theme flows, HTTP failures, keys, restart; artifacts ${artifacts}`);
} finally {
  release?.();
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
