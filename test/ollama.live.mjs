// Optional real-model smoke test; uses an isolated browser profile and Ollama
// daemon. No user tabs, model downloads or changes to the default Ollama service.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, cp, symlink, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import { verifyModelTask } from "./model-task.e2e.mjs";

const repo = path.resolve(".");
const model = process.env.TABWISE_LIVE_MODEL;
assert.ok(model, "Set TABWISE_LIVE_MODEL to an installed model before running this test.");
const artifacts = process.env.TABWISE_E2E_ARTIFACT_DIR || await mkdtemp(path.join(os.tmpdir(), "tabwise-real-model-"));
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(artifacts, "live-profile-"));
const modelDirectory = await mkdtemp(path.join(os.tmpdir(), "tabwise-models-"));
let context, daemon;
try {
  const original = process.env.TABWISE_OLLAMA_MODELS || path.join(os.homedir(), ".ollama/models");
  // Copy small manifests and link immutable tensors. Startup migrations/pruning
  // run solely in the disposable directory, never against the installed library.
  await cp(path.join(original, "manifests"), path.join(modelDirectory, "manifests"), { recursive: true });
  await mkdir(path.join(modelDirectory, "blobs"));
  const manifests = await readdir(path.join(modelDirectory, "manifests"), { recursive: true, withFileTypes: true });
  const digests = new Set();
  for (const entry of manifests.filter((entry) => entry.isFile())) {
    const manifest = JSON.parse(await readFile(path.join(entry.parentPath, entry.name), "utf8"));
    for (const layer of [manifest.config, ...manifest.layers]) digests.add(layer.digest.replace(":", "-"));
  }
  for (const digest of digests) await symlink(path.join(original, "blobs", digest), path.join(modelDirectory, "blobs", digest));
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
    env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_ORIGINS: extensionOrigin,
      OLLAMA_MODELS: modelDirectory, OLLAMA_NOPRUNE: "true", OLLAMA_NO_CLOUD: "true" }, stdio: ["ignore", "pipe", "pipe"]
  });
  let startupLog = "";
  const rememberLog = (chunk) => { startupLog = (startupLog + chunk.toString()).slice(-4000); };
  daemon.stdout.on("data", rememberLog); daemon.stderr.on("data", rememberLog);
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await fetch(`${endpoint}/api/version`, { signal: AbortSignal.timeout(1000) }).then((response) => response.ok).catch(() => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `isolated Ollama must start; ${startupLog}`);
  const control = await context.newPage();
  await control.goto(`${extensionOrigin}/src/options/options.html`);
  const result = await control.evaluate(({ endpoint, model }) => chrome.runtime.sendMessage({ type: "testOllamaConnection", endpoint, model, deep: true }), { endpoint, model });
  await writeFile(path.join(artifacts, "real-model-self-check.json"), JSON.stringify({ model, result }, null, 2));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.origin, extensionOrigin);
  assert.equal(result.stage, "JSON 推理");
  if (process.env.TABWISE_UNSUPPORTED_MODEL) {
    const unsupported = await control.evaluate(({ endpoint, model }) => chrome.runtime.sendMessage({ type: "testOllamaConnection", endpoint, model, deep: true }),
      { endpoint, model: process.env.TABWISE_UNSUPPORTED_MODEL });
    assert.equal(unsupported.ok, false);
    await writeFile(path.join(artifacts, "real-model-unsupported.json"), JSON.stringify(unsupported, null, 2));
  }
  await control.locator("#ai-provider-ollama").check();
  await control.locator("#ollama-endpoint").fill(endpoint);
  await control.locator("#ollama-model").fill(model);
  await control.locator('button[type="submit"]').click();
  await control.locator("#saved").filter({ hasText: "已保存" }).waitFor();
  await control.goto(`${extensionOrigin}/src/sidepanel/sidepanel.html`);
  const task = await verifyModelTask(control, { label: "Ollama", artifacts, context });
  await writeFile(path.join(artifacts, "real-model-task.json"), JSON.stringify({ model, task }, null, 2));
  console.log(`REAL MODEL PASS: ${model}, JSON self-check ${result.latencyMs}ms, task generation/citations/edit/adopt/export; artifacts ${artifacts}`);
} finally {
  await context?.close();
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await new Promise((resolve) => daemon.once("exit", resolve));
  }
  await rm(profile, { recursive: true, force: true });
  await rm(modelDirectory, { recursive: true, force: true });
}
