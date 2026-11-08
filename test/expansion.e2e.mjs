import assert from "node:assert/strict";
import path from "node:path";
import { show } from "./ui-navigation.mjs";

export async function verifyExpansion({ context, control, fixture, extensionUrl, message, waitForBrowserState, waitForWorker }) {
  const errors = [];
  control.on("pageerror", (error) => errors.push(error.message));
  await control.bringToFront();
  await message(control, "updateSettings", { settings: { autoSuspend: false, resourceSampling: false } });
  const source = { id: "task-expansion", name: "批量恢复验证", tabs: Array.from({ length: 12 }, (_, i) => ({ title: `Task ${i}`, url: `${fixture.baseUrl}/task-batch-${i}` })) };
  await control.evaluate(async (source) => {
    const { workspaces } = await chrome.storage.local.get("workspaces");
    await chrome.storage.local.set({ workspaces: [source, ...workspaces] });
  }, source);
  fixture.heldPages.enabled = true;
  const preview = await message(control, "prepareRestore", { kind: "workspace", sourceId: source.id });
  const started = await message(control, "startRestore", { previewId: preview.previewId, indices: source.tabs.map((_, i) => i), skipExisting: true });
  assert.ok(started.taskId);
  await show(control, "#restore-tasks");
  await waitForBrowserState(control, async (id) => {
    const { restoreTasks } = await chrome.storage.session.get("restoreTasks");
    return restoreTasks.find((task) => task.id === id)?.results.filter((page) => page.status === "opening" && page.tabId).length === 5;
  }, started.taskId);
  await control.locator(`[data-task-id="${started.taskId}"]`).getByRole("button", { name: "停止后续批次" }).click();
  fixture.heldPages.release();
  await waitForBrowserState(control, async (id) => (await chrome.runtime.sendMessage({ type: "getRestoreTask", taskId: id })).status === "stopped", started.taskId);
  assert.equal((await message(control, "getRestoreTask", { taskId: started.taskId })).count, 5);
  await control.locator(`[data-task-id="${started.taskId}"]`).getByRole("button", { name: "重试未完成页面" }).click();
  await waitForBrowserState(control, async (id) => (await chrome.runtime.sendMessage({ type: "getRestoreTasks" })).some((task) => task.retryOf === id && task.status === "completed"), started.taskId);
  const restored = await control.evaluate(() => chrome.tabs.query({}).then((tabs) => tabs.filter((tab) => tab.url?.includes("/task-batch-"))));
  assert.equal(restored.length, 12);
  assert.equal(new Set(restored.map((tab) => tab.url)).size, 12);
  // A real service-worker restart must not open more pages.
  await control.evaluate(async () => {
    const { restoreTasks } = await chrome.storage.session.get("restoreTasks");
    const next = [{ ...restoreTasks[0], id: "restart-task", status: "running", total: 1, indices: [0], results: [{ index: 0, status: "opening" }] }, ...restoreTasks];
    await chrome.storage.local.set({ restoreTaskLedger: next });
    await chrome.storage.session.set({ restoreTasks: next });
  });
  const worker = await waitForWorker(context);
  const cdp = await context.newCDPSession(control);
  const { targetInfos } = await cdp.send("Target.getTargets");
  await cdp.send("Target.closeTarget", { targetId: targetInfos.find((target) => target.type === "service_worker" && target.url === worker.url()).targetId });
  const interrupted = await message(control, "getRestoreTask", { taskId: "restart-task" });
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.results[0].status, "uncertain");
  assert.equal((await control.evaluate(() => chrome.tabs.query({}).then((tabs) => tabs.filter((tab) => tab.url?.includes("/task-batch-"))))).length, 12);
  await cdp.detach();

  const workspace = await message(control, "saveWorkspace", { name: "增量更新验证" });
  await waitForBrowserState(control, (id) => Boolean(document.querySelector(`[data-id="${id}"]`)), workspace.id);
  const card = control.locator(".saved-workspace").filter({ hasText: "增量更新验证" });
  await show(control, card);
  await (await show(control, card.locator('[data-ws="bind"]'))).click();
  const added = await control.evaluate((base) => chrome.tabs.create({ url: `${base}/incremental-new`, active: false }), fixture.baseUrl);
  await waitForBrowserState(control, async (id) => (await chrome.tabs.get(id)).status === "complete", added.id);
  await card.getByRole("button", { name: "更新预览", exact: true }).click();
  await control.locator(".workspace-editor details").filter({ hasText: "新增页面" }).locator("summary").click();
  await control.locator(".workspace-editor").getByText("incremental-new", { exact: true }).waitFor();
  await control.locator("[data-ws=confirm-update]").click();
  await waitForBrowserState(control, async (id) => (await chrome.runtime.sendMessage({ type: "getWorkspaceVersions", workspaceId: id })).length === 1, workspace.id);
  let versions = await message(control, "getWorkspaceVersions", { workspaceId: workspace.id });
  assert.equal(versions.length, 1);
  await card.getByRole("button", { name: "历史版本" }).click();
  await control.locator(".workspace-editor").getByRole("button", { name: "预览回退" }).click();
  await control.locator("[data-ws=confirm-update]").getByText("确认回退").waitFor();
  await control.locator("[data-ws=confirm-update]").click();
  await waitForBrowserState(control, async (id) => (await chrome.runtime.sendMessage({ type: "getWorkspaceVersions", workspaceId: id })).length === 2, workspace.id);
  assert.equal((await message(control, "getWorkspaces")).find((item) => item.id === workspace.id).tabs.some((page) => page.url.endsWith("/incremental-new")), false);
  assert.equal((await control.evaluate((id) => chrome.tabs.get(id), added.id)).url, `${fixture.baseUrl}/incremental-new`);

  // Real protected pages must be omitted; becoming active after preview skips the reclaim.
  let budgetTabs = await control.evaluate(async (base) => {
    const tabs = [];
    for (const name of ["budget-safe", "budget-pin", "budget-dirty", "budget-unknown"]) tabs.push(await chrome.tabs.create({ url: `${base}/${name}`, active: false }));
    await chrome.tabs.update(tabs[1].id, { pinned: true });
    return tabs;
  }, fixture.baseUrl);
  await waitForBrowserState(control, async (ids) => (await Promise.all(ids.map((id) => chrome.tabs.get(id)))).every((tab) => tab.status === "complete"), budgetTabs.map((tab) => tab.id));
  budgetTabs = await control.evaluate((ids) => Promise.all(ids.map((id) => chrome.tabs.get(id))), budgetTabs.map((tab) => tab.id));
  await message(control, "updateSettings", { settings: { resourceBudgetEnabled: true, resourceBudgetTabs: 1, resourceBudgetHeapMB: 1024, idleMinutes: 5, suspensionMode: "smart" } });
  await control.evaluate(async (tabs) => {
    const { lastActivity = {} } = await chrome.storage.session.get("lastActivity");
    for (const tab of tabs) lastActivity[tab.id] = Date.now() - 3600000;
    await chrome.storage.session.set({ lastActivity, pageProtectionStates: { [tabs[0].id]: { ready: true }, [tabs[1].id]: { ready: true }, [tabs[2].id]: { ready: true, dirty: true } } });
  }, budgetTabs);
  await control.reload();
  await show(control, "[data-budget=preview]");
  await control.locator("[data-budget=preview]").waitFor();
  await control.locator("[data-budget=preview]").click();
  await control.locator('.budget-preview input[type="checkbox"]').first().waitFor();
  const candidates = await control.locator(".budget-preview input").evaluateAll((inputs) => inputs.map((input) => Number(input.value)));
  assert.deepEqual(candidates, [budgetTabs[0].id]);
  await control.evaluate((id) => chrome.tabs.update(id, { active: true }), budgetTabs[0].id);
  await control.locator("[data-budget=confirm]").click();
  await control.locator(".budget-result").getByText("预算回收任务已创建，可在统一任务中心查看结果、停止或重试。", { exact: true }).waitFor();
  await waitForBrowserState(control, async () => (await chrome.runtime.sendMessage({ type: "getTasks" })).some((task) => task.kind === "budget" && task.status === "completed" && task.skipped === 1));
  assert.equal((await control.evaluate((id) => chrome.tabs.get(id), budgetTabs[0].id)).url, budgetTabs[0].url);
  // A fresh safe preview successfully suspends via the same guarded path.
  await control.bringToFront();
  const reclaimPreview = await message(control, "prepareBudgetReclaim");
  assert.equal(reclaimPreview.pages.some((page) => page.tabId === budgetTabs[0].id), false, "recent activation must reset idle tracking");
  await control.evaluate(async (tab) => {
    const { lastActivity = {} } = await chrome.storage.session.get("lastActivity");
    lastActivity[tab.id] = Date.now() - 3600000;
    await chrome.storage.session.set({ lastActivity });
  }, budgetTabs[0]);
  const safePreview = await message(control, "prepareBudgetReclaim");
  const reclaimed = await message(control, "confirmBudgetReclaim", { previewId: safePreview.previewId, tabIds: [budgetTabs[0].id] });
  assert.equal(reclaimed.count, 1);
  const savedTaskMatches = await message(control, "searchPages", { query: "Task", source: "workspace", workspaceId: workspace.id, deduplicate: true });
  assert.equal(savedTaskMatches.length, 12);
  assert.ok(savedTaskMatches.every((page) => page.source === "workspace" && page.workspaceId === workspace.id));
  const pinnedSearch = await message(control, "searchPages", { query: "budget pin", source: "open", windowId: budgetTabs[1].windowId, status: "protected" });
  assert.equal(pinnedSearch.length, 1);
  assert.equal(pinnedSearch[0].tabId, budgetTabs[1].id);

  // Metadata-scale fixture: exercise the actual dashboard/popup with 1000 rows,
  // without opening 1000 websites.
  await message(control, "updateSettings", { settings: { resourceBudgetEnabled: false, resourceSampling: false } });
  const perfWorker = await waitForWorker(context);
  await perfWorker.evaluate(() => {
    globalThis.originalTabQuery = chrome.tabs.query.bind(chrome.tabs);
    const tabs = Array.from({ length: 1000 }, (_, i) => ({ id: 100000 + i, title: `规模标签 ${i}`, url: `https://scale-${i}.test/`, windowId: 1, index: i, status: "complete" }));
    chrome.tabs.query = async () => tabs;
  });
  const popup = await context.newPage();
  popup.on("pageerror", (error) => errors.push(error.message));
  await popup.goto(`${extensionUrl}/src/popup/popup.html`);
  await popup.locator("#open-count").getByText("1000", { exact: true }).waitFor();
  assert.equal(await popup.locator("#tabs .row").count(), 50);
  await popup.locator("#tab-pagination [data-page=next]").click();
  await popup.locator("#tab-pagination").getByText("第 2 / 20 页 · 共 1000 页").waitFor();
  await popup.locator("#refresh").click();
  await popup.locator("#tab-pagination").getByText("第 2 / 20 页 · 共 1000 页").waitFor();
  assert.equal(await popup.locator("#tabs .row").count(), 50);
  await popup.locator("#tab-search").fill("规模标签 999");
  await popup.locator("#tabs").getByText("规模标签 999", { exact: true }).waitFor();
  assert.equal(await popup.locator("#tabs .row").count(), 1);
  await perfWorker.evaluate(() => { chrome.tabs.query = globalThis.originalTabQuery; delete globalThis.originalTabQuery; });
  await popup.locator("#tab-search").fill("");
  await popup.locator("#refresh").click();
  for (const colorScheme of ["light", "dark"]) {
    await control.emulateMedia({ colorScheme }); await control.setViewportSize({ width: 320, height: 900 });
    await popup.emulateMedia({ colorScheme }); await popup.setViewportSize({ width: 410, height: 900 });
    assert.ok(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (process.env.TABWISE_E2E_ARTIFACT_DIR) {
      await control.locator("#restore-tasks").screenshot({ path: path.join(process.env.TABWISE_E2E_ARTIFACT_DIR, `tasks-${colorScheme}-320.png`) });
      await popup.locator("#tab-pagination").screenshot({ path: path.join(process.env.TABWISE_E2E_ARTIFACT_DIR, `pagination-${colorScheme}-410.png`) });
    }
  }
  const options = await context.newPage();
  await options.goto(`${extensionUrl}/src/options/options.html`);
  await options.waitForFunction(() => document.querySelector("#budget-tabs").value === "1");
  await (await show(options, "#budget-enabled")).check(); await options.locator("#budget-tabs").fill("60");
  await options.locator("#settings-form").getByRole("button", { name: "保存设置", exact: true }).click();
  await options.getByText("已保存", { exact: true }).waitFor();
  await options.reload(); await options.waitForFunction(() => document.querySelector("#budget-tabs").value === "60");
  for (const colorScheme of ["light", "dark"]) {
    await options.emulateMedia({ colorScheme }); await options.setViewportSize({ width: 420, height: 900 });
    assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await options.close(); await popup.close();
  assert.deepEqual(errors, []);
  console.log("E2E PASS: task stop/retry/worker restart, workspace bind/diff/version rollback, guarded budget reclaim/options, real filtered search and 1000-row popup pagination, light/dark responsive layouts");
}
