// Optional real-model smoke test; uses an isolated browser profile and Ollama
// daemon. No user tabs, model downloads or changes to the default Ollama service.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const repo = path.resolve(".");
const model = process.env.TABWISE_LIVE_MODEL || "qwen3.8:27b-mlx";
const artifacts = path.resolve("coverage/feature-verification");
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(artifacts, "live-profile-"));
let context, daemon;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${repo}`, `--load-extension=${repo}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  // URL.origin is "null" for the Chrome extension custom scheme in Node.
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
  const reserve = createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const endpoint = `http://127.0.0.1:${port}`;
  daemon = spawn("/Applications/Ollama.app/Contents/Resources/ollama", ["serve"], {
    env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_ORIGINS: extensionOrigin }, stdio: "ignore"
  });
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await fetch(`${endpoint}/api/version`, { signal: AbortSignal.timeout(1000) }).then((response) => response.ok).catch(() => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "isolated Ollama must start");
  const control = await context.newPage();
  await control.goto(`${extensionOrigin}/src/options/options.html`);
  const result = await control.evaluate(({ endpoint, model }) => chrome.runtime.sendMessage({ type: "testOllamaConnection", endpoint, model, deep: true }), { endpoint, model });
  await writeFile(path.join(artifacts, "real-model-self-check.json"), JSON.stringify({ model, result }, null, 2));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.origin, extensionOrigin);
  assert.equal(result.stage, "JSON 推理");
  const unsupported = await control.evaluate((endpoint) => chrome.runtime.sendMessage({ type: "testOllamaConnection", endpoint, model: "qwen3:8b", deep: true }), endpoint);
  assert.equal(unsupported.ok, false);
  await writeFile(path.join(artifacts, "real-model-unsupported.json"), JSON.stringify(unsupported, null, 2));
  console.log(`REAL MODEL PASS: ${model}, JSON self-check ${result.latencyMs}ms, unsupported model rejected`);
} finally {
  await context?.close();
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await new Promise((resolve) => daemon.once("exit", resolve));
  }
  await rm(profile, { recursive: true, force: true });
}
