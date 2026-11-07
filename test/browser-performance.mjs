import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Matched isolated browser runs; no user profile or real websites.
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  response.end(`<!doctype html><title>Benchmark ${request.url}</title><h1>Benchmark</h1>
    <script>globalThis.fixture = Array.from({length:250000}, (_, i) => i);</script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const extension = path.resolve(".");
const samples = [];
async function sample(enabled) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "tabwise-perf-"));
  let context;
  const started = performance.now();
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium", headless: true,
      args: enabled ? [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] : ["--disable-extensions"]
    });
    const pages = [];
    for (let i = 0; i < 12; i++) {
      const page = await context.newPage();
      await page.goto(`${base}/fixture-${i}`);
      pages.push(page);
    }
    let dashboardMs = null, sampledPages = null;
    if (enabled) {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
      const control = await context.newPage();
      await control.goto(`chrome-extension://${new URL(worker.url()).host}/src/sidepanel/sidepanel.html`);
      const at = performance.now();
      const dashboard = await control.evaluate(() => chrome.runtime.sendMessage({ type: "getDashboard" }));
      dashboardMs = performance.now() - at;
      sampledPages = dashboard.summary.jsHeapMeasuredTabs;
    }
    let pageHeapBytes = 0;
    for (const page of pages) {
      const session = await context.newCDPSession(page);
      pageHeapBytes += (await session.send("Runtime.getHeapUsage")).usedSize;
      await session.detach();
    }
    const cdp = await context.browser().newBrowserCDPSession();
    const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
    await cdp.detach();
    const pids = processInfo.map((item) => item.id);
    const rows = execFileSync("ps", ["-p", pids.join(","), "-o", "rss="], { encoding: "utf8" }).trim().split(/\s+/);
    const rss = rows.reduce((sum, value) => sum + Number(value) * 1024, 0);
    return { enabled, pages: pages.length, elapsedMs: Math.round(performance.now() - started),
      pageHeapBytes, processRssSumBytes: rss > 0 ? rss : null,
      processCpuSeconds: processInfo.reduce((sum, item) => sum + item.cpuTime, 0), processCount: pids.length,
      dashboardMs: dashboardMs === null ? null : Math.round(dashboardMs), sampledPages };
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
}
try {
  for (let round = 0; round < 3; round++) {
    for (const enabled of round % 2 ? [true, false] : [false, true]) {
      const result = { round, ...await sample(enabled) };
      samples.push(result);
      console.log(JSON.stringify(result));
    }
  }
  const median = (enabled, field) => samples.filter((item) => item.enabled === enabled).map((item) => item[field]).sort((a, b) => a - b)[1];
  console.log(JSON.stringify({ medians: Object.fromEntries([false, true].map((enabled) => [enabled ? "extension" : "baseline",
    Object.fromEntries(["elapsedMs", "pageHeapBytes", "processRssSumBytes", "processCpuSeconds", "processCount"].map((field) => [field, median(enabled, field)]))])),
    note: "12 synthetic pages, 3 runs per mode. Extension mode includes one visible sidepanel. RSS null means this environment did not expose RSS. Available RSS sums double-count shared pages; CPU includes startup and page loads. These are scenario costs, not unique physical RAM or energy savings." }));
} finally { await new Promise((resolve) => server.close(resolve)); }
