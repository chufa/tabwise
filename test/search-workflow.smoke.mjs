import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { show } from "./ui-navigation.mjs";

const profile = await mkdtemp(path.join(os.tmpdir(), "tabwise-search-workflow-"));
const server = createServer((request, response) => {
  const title = request.url.includes("research") ? "浏览器性能研究" : "浏览器设计文档";
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<title>${title}</title><main>${title}</main>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: process.env.TABWISE_BROWSER || "chromium", headless: true,
    args: [`--disable-extensions-except=${path.resolve(".")}`, `--load-extension=${path.resolve(".")}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionUrl = `chrome-extension://${new URL(worker.url()).host}`;
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await context.newPage();
  await page.goto(`${base}/research`);
  const control = await context.newPage();
  control.setDefaultTimeout(8000);
  await control.setViewportSize({ width: 420, height: 900 });
  await control.goto(`${extensionUrl}/src/sidepanel/sidepanel.html`);
  const send = (type, payload = {}) => control.evaluate(({ type, payload }) => chrome.runtime.sendMessage({ type, ...payload }), { type, payload });

  await show(control, '[data-context="new"]');
  await control.locator('[data-context="new"]').click();
  await control.locator("#context-memory [name=\"name\"]").fill("搜索续接任务");
  await control.locator("#context-memory [name=\"goal\"]").fill("验证搜索页面可以加入任务");
  await control.locator("#context-memory .context-form").getByRole("button", { name: "创建任务" }).click();
  await control.locator(".context-editor-title").getByText("搜索续接任务").waitFor();

  await show(control, "#page-search");
  await control.locator("#page-search").fill("liulanqi");
  await control.locator("#search-results .result").filter({ hasText: "浏览器性能研究" }).waitFor();
  await control.locator("details").filter({ has: control.locator("#search-source") }).locator("summary").click();
  await control.locator("#search-period").selectOption("7");
  await control.locator("#search-sort").selectOption("recent");
  await control.locator("#search-domain").fill("127.0.0.1");
  await control.locator("#search-context-task").selectOption({ label: "搜索续接任务" });
  const row = control.locator("#search-results .result").filter({ hasText: "浏览器性能研究" });
  await row.getByRole("button", { name: "固定", exact: true }).click();
  const tab = (await control.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((item) => item.url === url)), `${base}/research`));
  assert.equal(tab.pinned, true);
  await row.getByRole("button", { name: "加入任务", exact: true }).click();
  await control.locator("#feedback").filter({ hasText: "已加入任务" }).waitFor();
  const task = (await send("listContextTasks")).tasks.find((item) => item.name === "搜索续接任务");
  assert.equal(task.sources.length, 1);
  assert.equal(task.sources[0].url, `${base}/research`);

  await control.evaluate(() => { window.prompt = () => "本周浏览器资料"; });
  await control.locator("#save-search-preset").click();
  await control.locator("#search-preset").selectOption({ label: "本周浏览器资料" });
  assert.equal(await control.locator("#search-domain").inputValue(), "127.0.0.1");

  await show(control, "#history-excluded-domains");
  await control.locator("#history-excluded-domains").fill("example.com\ninvalid domain");
  await control.locator("#save-history-policy").click();
  await control.locator("#feedback").filter({ hasText: "历史排除域名已保存" }).waitFor();
  const settings = await control.evaluate(() => chrome.storage.local.get("settings"));
  assert.deepEqual(settings.settings.historyExcludedDomains, ["example.com"]);
  await control.locator("#clear-history-cache").click();
  await control.locator("#feedback").filter({ hasText: "缓存已清空" }).waitFor();

  await control.locator("#page-search").focus();
  await control.keyboard.press("ArrowDown");
  await control.keyboard.press("Enter");
  assert.equal((await control.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.filter((item) => item.url === url).length), `${base}/research`)), 1);
  console.log("Search workflow PASS: filters, keyboard, pinning, task attachment, presets, and history privacy policy");
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
