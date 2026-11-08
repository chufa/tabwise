import assert from "node:assert/strict";
import { show } from "./ui-navigation.mjs";
import { sourceState } from "../src/shared/restoration.js";

export async function verifyPriorities({ context, control, fixture, extensionUrl, message, waitForBrowserState }) {
  let workspace = (await message(control, "getWorkspaces"))[0];
  await control.reload();
  await show(control, "#workspace-manager");
  await control.locator(`[data-key="${workspace.id}"]`).getByRole("button", { name: "编辑", exact: true }).click();
  const editor = control.locator(".workspace-editor");
  await editor.locator('[name="workspace-tags"]').fill("AI, 性能");
  await editor.locator('[name="workspace-notes"]').fill("本机阅读备注");
  await editor.locator('[name="workspace-favorite"]').check();
  await editor.getByRole("button", { name: "保存修改" }).click();
  await editor.waitFor({ state: "hidden" });
  await (await show(control, ".ws-favorite")).check();
  await control.locator(".ws-tag").selectOption("AI");
  await control.locator(".ws-filter-name").fill("常用 AI");
  await control.getByRole("button", { name: "保存筛选", exact: true }).click();
  await waitForBrowserState(control, async () => (await chrome.runtime.sendMessage({ type: "getWorkspaceFilters" })).some((item) => item.name === "常用 AI"));
  await control.reload();
  await control.locator(".ws-saved-filter option").filter({ hasText: "常用 AI" }).waitFor({ state: "attached" });
  await (await show(control, ".ws-saved-filter")).selectOption({ label: "常用 AI" });
  await waitForBrowserState(control, () => document.querySelector(".ws-tag").value === "AI");
  assert.equal(await control.locator(".ws-favorite").isChecked(), true);
  assert.equal(await control.locator(".ws-tag").inputValue(), "AI");
  workspace = (await message(control, "getWorkspaces")).find((item) => item.id === workspace.id);
  assert.equal(workspace.notes, "本机阅读备注");
  assert.deepEqual(workspace.tags, ["AI", "性能"]);

  const options = await context.newPage();
  await options.goto(`${extensionUrl}/src/options/options.html`);
  await show(options, "#backup-reminder-days");
  await options.locator("#backup-reminder-days").selectOption("7");
  await waitForBrowserState(options, async () => (await chrome.runtime.sendMessage({ type: "getBackupStatus" })).due);
  const before = await message(options, "getWorkspaces");
  const backup = await message(options, "exportBackup");
  assert.equal((await message(options, "getBackupStatus")).lastDownloadRequestedAt, 0, "generating JSON is not a download");
  await options.locator("#drill-backup").setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await options.locator("#backup-feedback").filter({ hasText: "恢复演练通过" }).waitFor();
  assert.deepEqual(await message(options, "getWorkspaces"), before, "drill never imports workspaces");
  const download = options.waitForEvent("download");
  await options.getByRole("button", { name: "导出工作区备份", exact: true }).click();
  await download;
  await waitForBrowserState(options, async () => (await chrome.runtime.sendMessage({ type: "getBackupStatus" })).lastDownloadRequestedAt > 0);
  assert.equal((await message(options, "getBackupStatus")).due, false);
  const privateState = await options.evaluate(() => chrome.storage.local.get("backupManagement"));
  assert.ok(!JSON.stringify(privateState).includes("本机阅读备注"));

  // Isolated saved source with a URL never loaded by this profile.
  const lazy = { ...workspace, id: "priority-lazy", name: "按需验证", tabs: [{ url: `${fixture.baseUrl}/priority-lazy`, title: "按需验证" }], schemaVersion: 1, groups: [], versions: [] };
  await control.evaluate(async (item) => {
    const { workspaces } = await chrome.storage.local.get("workspaces");
    await chrome.storage.local.set({ workspaces: [item, ...workspaces.filter((w) => w.id !== item.id)].slice(0, 20) });
  }, lazy);
  await control.reload();
  await control.locator(`[data-key="${lazy.id}"]`).getByRole("button", { name: "选择恢复", exact: true }).click();
  await control.locator(".restore-load-mode").selectOption("on-demand");
  await control.locator(".restore-concurrency").selectOption("1");
  await control.locator("#restore-preview").getByRole("button", { name: "恢复所选页面", exact: true }).click();
  await waitForBrowserState(control, async () => (await chrome.runtime.sendMessage({ type: "getRestoreTasks" })).some((task) => task.name === "按需验证" && task.status === "completed"));
  assert.equal(fixture.hits.get("priority-lazy") || 0, 0, "on-demand restore must not contact the original site");
  const suspended = (await message(control, "getDashboard")).tabs.find((tab) => tab.url === lazy.tabs[0].url);
  assert.ok(suspended?.suspended);
  assert.equal((await message(control, "restoreRecord", { recordId: suspended.recordId })).ok, true);
  await waitForBrowserState(control, async (url) => (await chrome.tabs.query({})).some((tab) => tab.url === url && tab.status === "complete"), lazy.tabs[0].url);
  assert.equal(fixture.hits.get("priority-lazy"), 1);
  await waitForBrowserState(control, async () => (await chrome.runtime.sendMessage({ type: "getDashboard" })).effects.restores > 0);

  const target = await context.newPage();
  await target.goto(`${fixture.baseUrl}/priority-protect`);
  await control.bringToFront();
  const tab = (await message(control, "getDashboard")).tabs.find((item) => item.url.endsWith("/priority-protect"));
  const popup = await context.newPage();
  await popup.goto(`${extensionUrl}/src/popup/popup.html`);
  await popup.locator("#tab-search").fill("priority-protect");
  await popup.locator("#tabs").getByRole("button", { name: "会话保护", exact: true }).click();
  await popup.locator("#tabs").getByRole("button", { name: "解除临时保护", exact: true }).waitFor();
  assert.equal((await message(control, "directSuspendTab", { tabId: tab.id })).ok, false);
  await popup.locator("#tabs").getByRole("button", { name: "解除临时保护", exact: true }).click();
  await popup.locator("#tabs").getByRole("button", { name: "保护 1 小时", exact: true }).click();
  await popup.locator("#tabs").getByRole("button", { name: "解除临时保护", exact: true }).click();
  await waitForBrowserState(control, async (id) => !(await chrome.runtime.sendMessage({ type: "getDashboard" })).tabs.find((item) => item.id === id).temporarilyProtected, tab.id);
  const success = await message(control, "directSuspendTab", { tabId: tab.id });
  assert.equal(success.ok, true);
  const effects = (await message(control, "getDashboard")).effects;
  assert.ok(effects.suspensions > 0);
  assert.equal((await message(control, "restoreRecord", { recordId: success.recordId })).ok, true);
  await waitForBrowserState(control, async (id) => (await chrome.tabs.get(id)).status === "complete", tab.id);
  await target.close();
  await popup.close();
  await options.close();
  console.log("Priority UI PASS: metadata/filter reload, drill without import, requested download, on-demand no original request, protection and effect records");
}

export async function prepareRestart({ control, fixture, message }) {
  const workspaces = await message(control, "getWorkspaces");
  const source = { ...workspaces.find((item) => item.id === "priority-lazy"),
    tabs: [{ url: `${fixture.baseUrl}/restart-pending`, title: "未完成页面" }] };
  const task = { id: "browser-restart-restore", name: "浏览器重启恢复", kind: "workspace", sourceId: source.id,
    signature: sourceState(source), status: "running", createdAt: Date.now(), total: 1, indices: [0],
    skipExisting: true, restoreLayout: false, loadMode: "on-demand", concurrency: 1,
    results: [{ index: 0, url: `${fixture.baseUrl}/restart-pending`, title: "未完成页面", status: "opening", tabId: 999999, windowId: 999999 }] };
  // Match the exact saved source and implementation task contract.
  task.results[0].url = source.tabs[0].url;
  await control.evaluate(async ({ task, source }) => {
    const { workspaces } = await chrome.storage.local.get("workspaces");
    await chrome.storage.local.set({
      workspaces: workspaces.map((item) => item.id === source.id ? source : item),
      restoreTaskLedger: [task],
      batchTaskLedger: [{ id: "browser-restart-batch", name: "重启摘要", kind: "suspend", status: "running", createdAt: Date.now(),
        results: [{ index: 0, status: "executing", title: "旧页面" }] }]
    });
  }, { task, source });
  return { source, beforeHits: fixture.hits.get("restart-pending") || 0 };
}

export async function verifyRestart({ control, fixture, message, waitForBrowserState, restart }) {
  const tasks = await message(control, "getTasks");
  const restore = tasks.find((item) => item.id === "browser-restart-restore");
  const batch = tasks.find((item) => item.id === "browser-restart-batch");
  assert.equal(restore.status, "interrupted");
  assert.equal(batch.status, "interrupted");
  assert.equal(batch.retryable, false, "stale browser targets must not be retried");
  const local = await control.evaluate(() => chrome.storage.session.get(["restoreTasks", "batchTasks"]));
  assert.equal(local.restoreTasks[0].results[0].status, "uncertain");
  assert.equal(local.restoreTasks[0].results[0].tabId, undefined);
  assert.equal(fixture.hits.get("restart-pending") || 0, restart.beforeHits, "restart never replays unfinished page loads");
  assert.equal((await message(control, "getWorkspaces")).find((item) => item.id === restart.source.id).notes, restart.source.notes);
  assert.equal((await message(control, "getWorkspaceFilters"))[0].name, "常用 AI");
  assert.ok((await message(control, "getBackupStatus")).lastDownloadRequestedAt > 0);
  assert.equal((await message(control, "retryTask", { taskId: batch.id, taskType: "batch" })).ok, false);
  assert.equal((await message(control, "archiveTask", { taskType: "batch", taskId: batch.id })).ok, true);
  assert.equal((await message(control, "getTasks")).some((item) => item.id === batch.id), false);
  const retried = await message(control, "retryTask", { taskId: restore.id, taskType: "restore" });
  assert.equal(retried.ok, true);
  await waitForBrowserState(control, async (id) => (await chrome.runtime.sendMessage({ type: "getRestoreTask", taskId: id })).status === "completed", retried.taskId);
  assert.equal(fixture.hits.get("restart-pending") || 0, restart.beforeHits, "manual retry preserves on-demand loading");
  assert.equal((await message(control, "getRestoreTask", { taskId: retried.taskId })).count, 1);
  console.log("Browser restart PASS: durable records, interrupted uncertain state, no automatic replay, stale batch targets disabled, local metadata preserved");
}
