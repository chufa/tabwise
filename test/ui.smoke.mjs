import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import { show } from "./ui-navigation.mjs";

const artifacts = process.env.TABWISE_E2E_ARTIFACT_DIR || await mkdtemp(path.join(os.tmpdir(), "tabwise-ui-check-"));
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "tabwise-ui-test-"));
const context = await chromium.launchPersistentContext(profile, { channel: process.env.TABWISE_BROWSER || "chromium", headless: true,
  args: [`--disable-extensions-except=${path.resolve(".")}`, `--load-extension=${path.resolve(".")}`] });
const errors = [];
context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
let control;
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionUrl = `chrome-extension://${new URL(worker.url()).host}`;
  control = await context.newPage();
  control.setDefaultTimeout(5000);
  await control.setViewportSize({ width: 420, height: 900 });
  await control.goto(`${extensionUrl}/src/sidepanel/sidepanel.html`);
  await control.locator(".context-list").filter({ hasNotText: "正在读取" }).waitFor();
  await control.locator('[data-context="new"]').click();
  const form = control.locator(".context-form");
  await form.locator('[name="name"]').fill("浏览器恢复机制调研");
  await form.locator('[name="goal"]').fill("对照两种休眠方式，确认恢复时机");
  await form.locator('[name="progress"]').fill("已经对照文档，下一步验证标签刷新");
  await form.locator('button[type="submit"]').click();
  await control.locator(".context-notice").filter({ hasText: "已保存在本地" }).waitFor();

  // Edits survive navigation and live browser events, and block stale AI previews.
  const progress = form.locator('[name="progress"]');
  await progress.fill("这段修改尚未保存");
  await control.locator("#nav-pages").click();
  await control.locator("#page-search").fill("恢复");
  await control.locator("#nav-tasks").click();
  assert.equal(await progress.inputValue(), "这段修改尚未保存");
  await show(control, '[data-context="preview"]');
  await control.locator('[data-context="preview"]').click();
  assert.match(await control.locator(".context-notice").textContent(), /未保存/);
  await control.locator('[data-context="reload"]').click();
  await control.locator(".context-notice").filter({ hasText: "已重新读取" }).waitFor();
  assert.equal(await progress.inputValue(), "已经对照文档，下一步验证标签刷新");
  await show(control, progress);
  await progress.fill("");
  await form.locator('[name="goal"]').fill("");
  await control.locator("#context-tab-ai").click();
  await form.locator('button[type="submit"]').click();
  assert.equal(await control.locator("#context-tab-progress").getAttribute("aria-selected"), "true");
  assert.equal(await form.locator('[name="goal"]').evaluate((node) => node === document.activeElement), true);
  await form.locator('[name="goal"]').fill("对照两种休眠方式，确认恢复时机");
  await progress.fill("已经对照文档，下一步验证标签刷新");
  await form.locator('button[type="submit"]').click();
  await control.locator(".context-notice").filter({ hasText: "已保存在本地" }).waitFor();

  // Keyboard navigation, explicit search shortcut and retained query.
  await control.locator("#nav-tasks").focus();
  await control.keyboard.press("ArrowRight");
  assert.equal(await control.locator("#nav-pages").getAttribute("aria-selected"), "true");
  assert.equal(await control.locator("#page-search").inputValue(), "恢复");
  await control.locator("#nav-resources").click();
  await control.keyboard.press("/");
  assert.equal(await control.locator("#page-search").evaluate((node) => node === document.activeElement), true);
  await control.locator("#nav-tasks").click();
  await control.locator("#open-palette").click();
  await control.locator("#palette-input").fill("保存当前窗口为工作区");
  await control.locator("#palette-results").getByText("保存当前窗口为工作区", { exact: true }).waitFor();
  await control.locator("#palette-input").press("Enter");
  await control.locator("#save-workspace-form input").waitFor();
  assert.equal(await control.locator("#nav-workspaces").getAttribute("aria-selected"), "true");
  await control.locator("#cancel-workspace").click();

  const options = await context.newPage();
  options.setDefaultTimeout(5000);
  await options.goto(`${extensionUrl}/src/options/options.html#sleep`);
  await options.locator('#settings-form[aria-busy="false"]').waitFor();
  await options.locator("#idle-minutes").fill("1");
  await options.locator("#settings-nav-model").click();
  assert.match(await options.locator("#saved").textContent(), /未保存/);
  await options.locator('button[type="submit"]').click();
  assert.equal(await options.locator("#settings-nav-sleep").getAttribute("aria-selected"), "true");
  assert.equal(await options.locator("#idle-minutes").evaluate((node) => node === document.activeElement), true);
  await options.locator("#idle-minutes").fill("35");
  await options.locator("#settings-nav-sites").click();
  await options.locator("#site-idle-rules").fill("docs.example.test 1");
  await options.locator("#settings-nav-model").click();
  await options.locator('button[type="submit"]').click();
  assert.equal(await options.locator("#settings-nav-sites").getAttribute("aria-selected"), "true");
  await options.locator("#site-idle-rules").fill("");
  await options.locator('button[type="submit"]').click();
  await options.locator("#saved").filter({ hasText: "已保存" }).waitFor();
  const persisted = await options.evaluate(async () => (await chrome.runtime.sendMessage({ type: "getDashboard" })).settings.idleMinutes);
  assert.equal(persisted, 35);

  const popup = await context.newPage();
  popup.setDefaultTimeout(5000);
  await popup.goto(`${extensionUrl}/src/popup/popup.html`);
  await popup.locator("#tabs .row").first().waitFor();
  assert.equal(await popup.locator("#popup-nav-tabs").getAttribute("aria-selected"), "true");
  await popup.locator("#tab-search").fill("TabWise");
  await popup.locator("#popup-nav-organize").click();
  await popup.locator("#popup-nav-tabs").click();
  assert.equal(await popup.locator("#tab-search").inputValue(), "TabWise");
  await popup.locator('[data-filter="protected"]').click();
  assert.equal(await popup.locator('[data-filter="protected"]').getAttribute("aria-pressed"), "true");
  await popup.locator("#refresh").click();
  await popup.locator("#action-feedback").filter({ hasText: "已刷新" }).waitFor();
  await popup.getByRole("button", { name: "关闭提示", exact: true }).click();
  assert.equal(await popup.locator("#action-feedback").textContent(), "");
  await popup.locator("#open-palette").click();
  await popup.locator("#palette-input").fill("批量休眠");
  await popup.locator("#palette-results").getByText("批量休眠预览", { exact: true }).waitFor();
  await popup.locator("#palette-input").press("Enter");
  await popup.locator("#batch-preview h2").waitFor();
  assert.equal(await popup.locator("#batch-preview").isVisible(), true, "batch preview stays visible from the default tab view");
  await popup.locator("[data-batch=cancel]").click();

  // Inspect all shipped routes at their real widths in both system themes.
  for (const colorScheme of ["light", "dark"]) {
    for (const width of [320, 420]) {
      await control.emulateMedia({ colorScheme });
      await control.setViewportSize({ width, height: 900 });
      for (const view of ["tasks", "pages", "resources", "history"]) {
        await control.locator(`[data-view-button="${view}"]`).first().click();
        assert.ok(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${view} ${width} ${colorScheme}`);
        await control.screenshot({ path: path.join(artifacts, `panel-${view}-${colorScheme}-${width}.png`), fullPage: true });
      }
    }
    await options.emulateMedia({ colorScheme });
    for (const width of [420, 1280]) {
      await options.setViewportSize({ width, height: 900 });
      for (const view of ["model", "sleep", "sites", "data", "about"]) {
        await options.locator(`[data-view-button="${view}"]`).click();
        assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `settings ${view} ${width}`);
      }
      await options.screenshot({ path: path.join(artifacts, `settings-${colorScheme}-${width}.png`), fullPage: true });
    }
    await popup.setViewportSize({ width: 410, height: 620 });
    await popup.emulateMedia({ colorScheme });
    for (const view of ["tabs", "organize", "saved"]) {
      await popup.locator(`[data-view-button="${view}"]`).click();
      assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `popup ${view}`);
      await popup.screenshot({ path: path.join(artifacts, `popup-${view}-${colorScheme}.png`), fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  console.log(`UI PASS: ${await context.browser().version()}, draft/search retention, keyboard navigation, hidden-field validation, command routing, all views light/dark 320/420/1280. Evidence: ${artifacts}`);
} catch (error) {
  if (control && !control.isClosed()) {
    await control.screenshot({ path: path.join(artifacts, "ui-failure.png"), fullPage: true }).catch(() => {});
    const state = await control.locator("#context-memory").textContent().catch(() => "");
    await writeFile(path.join(artifacts, "ui-failure.json"), JSON.stringify({ error: error.message, errors, state }, null, 2));
  }
  throw error;
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
