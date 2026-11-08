import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Runs the same task through either a real model or an explicit protocol fixture.
export async function verifyModelTask(control, { label, artifacts, context }) {
  const send = (type, fields = {}) => control.evaluate(({ type, fields }) => chrome.runtime.sendMessage({ type, ...fields }), { type, fields });
  const memory = control.locator("#context-memory"), form = memory.locator(".context-form");
  await control.evaluate(async () => {
    const { workspaces = [] } = await chrome.storage.local.get("workspaces");
    await chrome.storage.local.set({ workspaces: [{ id: "model-source", name: "模型验证资料", tabs: [
      { title: "恢复机制对照资料", url: "https://example.test/recovery?token=synthetic-private" }
    ] }, ...workspaces] });
  });
  await memory.getByRole("button", { name: "新建任务", exact: true }).click();
  await form.locator('[name="name"]').fill(`${label} 真实链路验证`);
  await form.locator('[name="goal"]').fill("根据选定资料比较占位休眠和原生卸载，明确下一步验证内容。");
  await form.locator('[name="progress"]').fill("已完成模型配置和连接自检，尚未验证页面恢复。");
  await form.locator("summary").click();
  await form.locator('[name="confirmedNotes"]').fill("用户确认：所有页面都是合成测试资料，恢复验证仍待执行。");
  await form.locator('[name="questions"]').fill("两种模式切回标签时是否都会重新加载原网页？");
  await form.locator('[name="nextSteps"]').fill("用合成页面记录恢复前后的请求次数。");
  await form.getByRole("button", { name: "创建任务", exact: true }).click();
  await memory.locator(".context-notice").filter({ hasText: "已保存在本地" }).waitFor();
  await memory.getByRole("button", { name: "选择资料加入任务", exact: true }).click();
  const picker = memory.locator(".context-picker");
  await picker.locator("[data-source-kind]").selectOption("workspace");
  await picker.locator("[data-source-workspace]").selectOption("model-source");
  await picker.getByRole("button", { name: "读取资料列表", exact: true }).click();
  await picker.locator(".saved-member input").check();
  await picker.getByRole("button", { name: "将选定资料加入任务", exact: true }).click();
  await memory.locator(".context-notice").filter({ hasText: "已加入任务" }).waitFor();
  const source = form.locator(".context-source").first();
  await source.locator("summary").click();
  await source.locator("[data-source-excerpt]").fill("合成资料：占位休眠切回标签只显示恢复页，点击恢复才加载原网页。原生卸载在切回标签时自动重新加载原网页。两者都不能保证恢复未保存的表单或 JS 内存。");
  await form.getByRole("button", { name: "保存进度", exact: true }).click();
  await memory.locator(".context-notice").filter({ hasText: "已保存在本地" }).waitFor();
  await source.locator("[data-model-source]").check();
  const before = (await send("getDashboard")).tabs.length;
  await memory.getByRole("button", { name: "预览续接输入", exact: true }).click();
  await memory.locator(".context-preview").filter({ hasText: label }).waitFor();
  assert.ok(!(await memory.locator(".context-preview").textContent()).includes("synthetic-private"));
  await memory.getByRole("button", { name: "生成续接草稿", exact: true }).click();
  await control.waitForFunction(() => document.querySelector('.context-draft [name="summary"]') ||
    !document.querySelector('[data-context="stop"]') || document.querySelector('[data-context="stop"]').hidden, null, { timeout: 120000 });
  assert.equal(await memory.locator('.context-draft [name="summary"]').count(), 1, await memory.locator(".context-notice").textContent());
  assert.ok((await memory.locator('.context-draft [name="summary"]').inputValue()).length > 5);
  assert.ok(await memory.locator(".context-draft .context-citations a").count() > 0, "generation should cite the supplied excerpt");
  assert.equal((await send("getDashboard")).tabs.length, before, "model generation must not open source pages");
  await memory.locator('.context-draft [name="summary"]').fill("用户审阅：继续核对两种恢复方式，并记录合成页面请求次数。");
  await memory.locator("[data-adopt-confirm]").check();
  await memory.getByRole("button", { name: "确认采纳草稿", exact: true }).click();
  await memory.locator(".context-accepted").filter({ hasText: "用户审阅" }).waitFor();
  const task = (await send("listContextTasks")).tasks.find((item) => item.name === `${label} 真实链路验证`);
  assert.equal(task.acceptedBrief.summary, "用户审阅：继续核对两种恢复方式，并记录合成页面请求次数。");
  assert.equal(task.confirmedNotes, "用户确认：所有页面都是合成测试资料，恢复验证仍待执行。");
  const download = control.waitForEvent("download");
  await memory.getByRole("button", { name: "下载 Markdown", exact: true }).click();
  const text = await readFile(await (await download).path(), "utf8");
  assert.ok(text.includes("synthetic-private"));
  assert.ok(text.includes("用户审阅"));
  if (artifacts && context) {
    for (const colorScheme of ["light", "dark"]) {
      await control.emulateMedia({ colorScheme });
      for (const width of [320, 420]) {
        await control.setViewportSize({ width, height: 900 });
        assert.ok(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "task panel must fit viewport");
        await memory.screenshot({ path: `${artifacts}/model-task-${colorScheme}-${width}.png` });
      }
    }
  }
  return task;
}
