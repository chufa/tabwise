import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { verifyContextMemory, verifyContextRestart } from "./context-memory.e2e.mjs";

const profile = await mkdtemp(path.join(os.tmpdir(), "tabwise-context-"));
const hits = new Map(), ai = { contextRequests: [] };
const server = createServer((request, response) => {
  if (request.url === "/api/generate") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body), input = JSON.parse(payload.prompt.split("任务上下文：")[1]);
      ai.contextRequests.push(payload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ response: JSON.stringify({ schemaVersion: 1, snapshotId: input.snapshotId,
        summary: "Ollama 续接建议", hypotheses: [{ text: "仍需核对页面内容", sourceIds: input.sources.map((s) => s.sourceId) }],
        questions: [{ text: "哪些验证仍未完成？", sourceIds: [] }],
        nextSteps: [{ text: "继续核对资料", sourceIds: input.sources.map((s) => s.sourceId) }] }) }));
    });
  } else {
    hits.set(request.url, (hits.get(request.url) || 0) + 1);
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>Context source</title><main>Context fixture</main>");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const launch = () => chromium.launchPersistentContext(profile, { channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${path.resolve(".")}`, `--load-extension=${path.resolve(".")}`] });
let context, control;
try {
  context = await launch();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionUrl = `chrome-extension://${new URL(worker.url()).host}`;
  control = await context.newPage();
  await control.goto(`${extensionUrl}/src/sidepanel/sidepanel.html`);
  const fixture = { baseUrl: `http://127.0.0.1:${server.address().port}`, hits, ai };
  const saved = await verifyContextMemory({ context, control, fixture, extensionUrl });
  // Read permission from a real injected content script rather than from an extension page.
  const web = await context.newPage();
  await web.goto(`${fixture.baseUrl}/context-permission`);
  const denied = await control.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url);
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async () => {
      try { await chrome.storage.local.get("contextTasks"); return false; } catch { return true; }
    } });
    return results[0]?.result;
  }, web.url());
  assert.equal(denied, true, "untrusted content scripts must not read task notes directly");
  const snapshot = await control.evaluate(async (id) => chrome.runtime.sendMessage({ type: "prepareContextBrief", taskId: id, sourceIds: [] }), saved.id);
  const requestsBeforeRestart = hits.get("/context-unopened?token=private-path") || 0;
  await context.close();
  context = await launch();
  control = await context.newPage();
  await control.goto(`${extensionUrl}/src/sidepanel/sidepanel.html`);
  await verifyContextRestart(control, saved);
  const rejected = await control.evaluate(async (id) => chrome.runtime.sendMessage({ type: "generateContextBrief", snapshotId: id }), snapshot.snapshot.id);
  assert.equal(rejected.ok, false);
  assert.equal(hits.get("/context-unopened?token=private-path") || 0, requestsBeforeRestart);
  console.log(`Context focused PASS: ${await context.browser().version()}, trusted storage access, full restart, no background source loads`);
} catch (error) {
  if (process.env.TABWISE_E2E_ARTIFACT_DIR && control && !control.isClosed()) {
    await control.screenshot({ path: path.join(process.env.TABWISE_E2E_ARTIFACT_DIR, "context-failure.png"), fullPage: true }).catch(() => {});
    const state = await control.locator("#context-memory").textContent().catch(() => "");
    await writeFile(path.join(process.env.TABWISE_E2E_ARTIFACT_DIR, "context-failure.json"), JSON.stringify({ error: error.message, state }, null, 2));
  }
  throw error;
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
