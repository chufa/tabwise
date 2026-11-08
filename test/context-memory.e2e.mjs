import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function verifyContextMemory({ context, control, fixture, extensionUrl }) {
  const send = (type, payload = {}) => control.evaluate(({ type, payload }) => chrome.runtime.sendMessage({ type, ...payload }), { type, payload });
  const beforeTabs = (await send("getDashboard")).tabs.length;
  const url = `${fixture.baseUrl}/context-unopened?token=private-path`;
  const hitCount = () => fixture.hits.get("context-unopened") || fixture.hits.get("/context-unopened?token=private-path") || 0;
  const initialHits = hitCount();
  const saved = { id: "context-saved", name: "任务资料测试", tabs: [{ title: "Context research", url }, { title: "Unselected source", url: `${fixture.baseUrl}/context-unselected` }] };
  await control.evaluate(async (item) => {
    const { workspaces = [] } = await chrome.storage.local.get("workspaces");
    await chrome.storage.local.set({ workspaces: [item, ...workspaces].slice(0, 20) });
  }, saved);
  await send("updateSettings", { settings: { aiProvider: "browser", autoSuspend: false, resourceSamplingMode: "off" } });
  await control.reload();
  const memory = control.locator("#context-memory"), form = memory.locator(".context-form");
  await memory.getByRole("button", { name: "新建任务", exact: true }).click();
  await form.locator('[name="name"]').fill("AI 任务续接验证");
  await form.locator('[name="goal"]').fill("比较恢复方式 https://secret.test/private-path");
  await form.locator('[name="progress"]').fill("已完成第一轮检查");
  await form.locator("summary").click();
  await form.locator('[name="confirmedNotes"]').fill("确认记录 api_key=sk-private-value");
  await form.locator('[name="questions"]').fill("是否保留登录态？");
  await form.locator('[name="nextSteps"]').fill("核对恢复机制");
  await form.getByRole("button", { name: "创建任务", exact: true }).click();
  await memory.locator(".context-notice").filter({ hasText: "已保存在本地" }).waitFor();
  let task = (await send("listContextTasks")).tasks.find((item) => item.name === "AI 任务续接验证");
  assert.ok(task);
  await memory.getByRole("button", { name: "选择资料加入任务", exact: true }).click();
  const picker = memory.locator(".context-picker");
  await picker.locator("[data-source-kind]").selectOption("workspace");
  await picker.locator("[data-source-workspace]").selectOption(saved.id);
  await picker.getByRole("button", { name: "读取资料列表", exact: true }).click();
  await picker.locator(".saved-member").filter({ hasText: "Context research" }).locator("input").check();
  assert.equal(hitCount(), initialHits);
  await picker.getByRole("button", { name: "将选定资料加入任务", exact: true }).click();
  await memory.locator(".context-notice").filter({ hasText: "已加入任务" }).waitFor();
  assert.equal(await memory.locator("[data-model-source]:checked").count(), 0);
  const source = form.locator(".context-source").first();
  await source.locator("summary").click();
  await source.locator("[data-source-note]").fill("核对本地恢复行为");
  await source.locator("[data-source-excerpt]").fill("用户提供的片段 user@private.test，尚需验证正文 https://secret.test/private-path");
  await form.getByRole("button", { name: "保存进度", exact: true }).click();
  await memory.locator(".context-notice").filter({ hasText: "已保存在本地" }).waitFor();
  await source.locator("[data-model-source]").check();
  await memory.getByRole("button", { name: "预览续接输入", exact: true }).click();
  await memory.locator(".context-preview").filter({ hasText: "完整内容" }).waitFor();
  const previewText = await memory.locator(".context-preview").textContent();
  for (const secret of ["private-path", "sk-private-value", "user@private.test", "Unselected source"]) assert.ok(!previewText.includes(secret), secret);
  assert.ok(previewText.includes("已选 1 个资料"));
  assert.equal((await send("getDashboard")).tabs.length, beforeTabs);
  assert.equal(hitCount(), initialHits);
  await control.evaluate(() => {
    globalThis.contextPrompts = [];
    globalThis.LanguageModel = { availability: async () => "available", create: async () => ({
      prompt: async (prompt, options) => {
        globalThis.contextPrompts.push({ prompt, schema: options.responseConstraint });
        const input = JSON.parse(prompt.split("任务上下文：")[1]);
        const brief = { schemaVersion: 1, snapshotId: input.snapshotId, summary: "继续核对恢复限制",
          hypotheses: [{ text: "页面状态仍需检查", sourceIds: input.sources.map((s) => s.sourceId) }],
          questions: [{ text: "是否保留登录态？", sourceIds: [] }], nextSteps: [{ text: "对照资料进行验证", sourceIds: input.sources.map((s) => s.sourceId) }] };
        if (globalThis.contextHold) return new Promise((resolve) => { globalThis.contextRelease = () => resolve(JSON.stringify(brief)); });
        return JSON.stringify(brief);
      }, destroy() {}
    }) };
  });
  await memory.getByRole("button", { name: "生成续接草稿", exact: true }).click();
  await memory.locator(".context-draft").getByRole("button", { name: "确认采纳草稿", exact: true }).waitFor();
  const prompts = await control.evaluate(() => globalThis.contextPrompts);
  assert.equal(prompts.length, 1);
  for (const secret of ["private-path", "sk-private-value", "user@private.test", "Unselected source"]) assert.ok(!prompts[0].prompt.includes(secret));
  assert.equal(prompts[0].schema.additionalProperties, false);
  await memory.locator('.context-draft [name="summary"]').fill("人工修改的续接摘要");
  await memory.getByRole("button", { name: "确认采纳草稿", exact: true }).click();
  await memory.locator(".context-notice").filter({ hasText: "明确确认" }).waitFor();
  await memory.locator("[data-adopt-confirm]").check();
  await memory.getByRole("button", { name: "确认采纳草稿", exact: true }).click();
  await memory.locator(".context-accepted").filter({ hasText: "人工修改的续接摘要" }).waitFor();
  task = (await send("listContextTasks")).tasks.find((item) => item.id === task.id);
  assert.equal(task.confirmedNotes, "确认记录 api_key=sk-private-value");
  assert.equal(task.acceptedBrief.summary, "人工修改的续接摘要");
  assert.equal((await send("getDashboard")).tabs.length, beforeTabs);
  const jsonDownload = control.waitForEvent("download");
  await memory.getByRole("button", { name: "导出任务 JSON", exact: true }).click();
  const file = await jsonDownload;
  const exported = JSON.parse(await readFile(await file.path(), "utf8"));
  assert.equal(exported.task.acceptedBrief.summary, task.acceptedBrief.summary);
  assert.equal(exported.task.sources[0].url, url);
  const markdown = control.waitForEvent("download");
  await memory.getByRole("button", { name: "下载 Markdown", exact: true }).click();
  const text = await readFile(await (await markdown).path(), "utf8");
  assert.ok(text.includes(url));
  assert.ok(text.includes("资料 1"));

  // Live refresh must preserve unfinished edits; AI preview requires saved state.
  await form.locator('[name="progress"]').fill("未保存的修改");
  await send("resumeContextTask", { taskId: task.id });
  await memory.getByRole("button", { name: "预览续接输入", exact: true }).click();
  await memory.locator(".context-notice").filter({ hasText: "有未保存" }).waitFor();
  assert.equal(await form.locator('[name="progress"]').inputValue(), "未保存的修改");
  await memory.getByRole("button", { name: "重新读取", exact: true }).click();
  await memory.locator(".context-notice").filter({ hasText: "已重新读取" }).waitFor();
  assert.equal(await form.locator('[name="progress"]').inputValue(), "已完成第一轮检查");
  await source.locator("[data-model-source]").check();
  await memory.getByRole("button", { name: "预览续接输入", exact: true }).click();
  await memory.locator(".context-preview").filter({ hasText: "完整内容" }).waitFor();
  await control.evaluate(() => { globalThis.contextHold = true; });
  await memory.getByRole("button", { name: "生成续接草稿", exact: true }).click();
  await control.waitForFunction(() => !!globalThis.contextRelease);
  await memory.getByRole("button", { name: "停止生成", exact: true }).click();
  await control.evaluate(() => { globalThis.contextHold = false; globalThis.contextRelease(); });
  await memory.locator(".context-notice").filter({ hasText: "生成已停止" }).waitFor();
  assert.equal(await memory.locator(".context-draft button").count(), 0);
  assert.equal((await send("listContextTasks")).tasks.find((item) => item.id === task.id).acceptedBrief.summary, "人工修改的续接摘要");

  if (fixture.ai) {
    await send("updateSettings", { settings: { aiProvider: "ollama", ollamaEndpoint: fixture.baseUrl, ollamaModel: "fixture:latest" } });
    await memory.getByRole("button", { name: "预览续接输入", exact: true }).click();
    await memory.locator(".context-preview").filter({ hasText: "本机 Ollama" }).waitFor();
    await memory.getByRole("button", { name: "生成续接草稿", exact: true }).click();
    await memory.locator(".context-draft").getByRole("button", { name: "确认采纳草稿", exact: true }).waitFor();
    assert.ok(fixture.ai.contextRequests.length > 0);
    assert.ok(!fixture.ai.contextRequests.at(-1).prompt.includes("private-path"));
  }
  if (process.env.TABWISE_E2E_ARTIFACT_DIR) {
    for (const colorScheme of ["light", "dark"]) {
      await control.emulateMedia({ colorScheme });
      await control.setViewportSize({ width: 320, height: 900 });
      assert.ok(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "task memory fits 320px");
      await memory.screenshot({ path: path.join(process.env.TABWISE_E2E_ARTIFACT_DIR, `context-${colorScheme}-320.png`) });
    }
  }
  await control.reload();
  await memory.locator(`[data-task-id="${task.id}"]`).getByRole("button").click();
  await memory.locator(".context-accepted").filter({ hasText: "人工修改的续接摘要" }).waitFor();
  assert.equal(hitCount(), initialHits, "returning to a task never loads its sources");
  await memory.getByRole("button", { name: "选择资料继续", exact: true }).click();
  const restore = control.locator("#restore-preview");
  await restore.locator(".restore-load-mode").selectOption("on-demand");
  await restore.getByRole("button", { name: "恢复所选页面", exact: true }).click();
  await control.waitForFunction(async (id) => (await chrome.runtime.sendMessage({ type: "getRestoreTasks" }))
    .some((task) => task.kind === "context" && task.sourceId === id && task.status === "completed"), task.id);
  assert.equal(hitCount(), initialHits, "on-demand task restore never requests original website");
  await memory.getByRole("button", { name: "归档任务", exact: true }).click();
  await memory.locator(".context-notice").filter({ hasText: "归档状态已保存" }).waitFor();
  await memory.locator(".context-filter select").selectOption("archived");
  await memory.locator(`[data-task-id="${task.id}"]`).getByRole("button").waitFor();
  await memory.getByRole("button", { name: "取消归档", exact: true }).click();
  await memory.getByRole("button", { name: "归档任务", exact: true }).waitFor();
  assert.equal((await send("listContextTasks")).tasks.find((item) => item.id === task.id).status, "active");
  await send("updateSettings", { settings: { aiProvider: "ollama" } });
  console.log(`Context memory PASS: chosen inputs, edited cited drafts, ${fixture.ai ? "browser/Ollama" : "browser"} schema, cancellation, local exports, dirty edits, archive and on-demand resume`);
  return { id: task.id, summary: "人工修改的续接摘要" };
}

export async function verifyContextRestart(control, saved) {
  const memory = control.locator("#context-memory");
  await memory.locator(`[data-task-id="${saved.id}"]`).getByRole("button").click();
  await memory.locator(".context-accepted").filter({ hasText: saved.summary }).waitFor();
  assert.equal(await memory.locator('.context-form [name="progress"]').inputValue(), "已完成第一轮检查");
  assert.equal(await memory.locator(".context-draft button").count(), 0);
  console.log("Context restart PASS: task state and adopted brief survive; pending model drafts are absent");
}
