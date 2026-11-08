import assert from "node:assert/strict";
import path from "node:path";
import { show } from "./ui-navigation.mjs";

export async function verifyEnhancements({ context, control, fixture, extensionUrl, message, waitForBrowserState, waitForWorker }) {
  const options = await context.newPage();
  const errors = [];
  control.on("pageerror", (error) => errors.push(error.message));
  options.on("pageerror", (error) => errors.push(error.message));
  await options.goto(`${extensionUrl}/src/options/options.html`);
  await options.locator('#settings-form[aria-busy="false"]').waitFor();
  await show(options, "#import-backup");
  const initial = await control.evaluate(() => chrome.storage.local.get(["settings", "workspaces"]));
  const backup = await message(control, "exportBackup");
  assert.equal(backup.schemaVersion, 2);
  assert.equal(backup.integrity.algorithm, "SHA-256");
  const saved = { id: "backup-1000", name: "完整备份验证", schemaVersion: 2, windowCount: 10,
    tabs: Array.from({ length: 1000 }, (_, i) => ({ title: `备份页面 ${i}`, url: `${fixture.baseUrl}/backup-page-${i}`, windowKey: Math.floor(i / 100),
      index: i % 100, status: i % 2 ? "suspended" : "open", pinned: i % 100 === 0, groupKey: `g${Math.floor(i / 100)}` })),
    groups: Array.from({ length: 10 }, (_, i) => ({ key: `g${i}`, windowKey: i, title: `研究 ${i}`, color: "blue", collapsed: true })) };
  saved.versions = Array.from({ length: 5 }, (_, i) => ({ ...saved, id: `v${i}`, createdAt: i + 1 }));
  const input = { schemaVersion: 1, workspaces: [saved], settings: { idleMinutes: 240 } };
  const upload = (data) => options.locator("#import-backup").setInputFiles({
    name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data))
  });
  await upload(input);
  await options.locator("#backup-preview").getByText("1000 页 · 10 个窗口 · 5 个历史版本", { exact: true }).waitFor();
  assert.deepEqual(await control.evaluate(() => chrome.storage.local.get(["settings", "workspaces"])), initial);
  await options.locator("[data-backup=confirm]").click();
  await options.locator("#backup-feedback").getByText("已导入 1 个工作区，跳过 0 个。", { exact: true }).waitFor();
  const state = await control.evaluate(() => chrome.storage.local.get(["settings", "workspaces"]));
  assert.equal(state.settings.idleMinutes, initial.settings.idleMinutes, "settings are opt-in");
  const imported = state.workspaces.find((workspace) => workspace.name === saved.name);
  assert.equal(imported.tabs.length, 1000);
  assert.equal(imported.versions.length, 5);
  assert.equal(imported.groups.length, 10);
  assert.equal(imported.tabs[999].status, "suspended");
  await control.reload();
  await control.bringToFront();
  await (await show(control, "#ai-scope")).selectOption("current");
  assert.equal(await control.locator('#ai-tab-options input[type="checkbox"]').count(), 0, "AI scope must mount lazily");
  await show(control, "#workspace-manager");
  await control.locator("#workspace-manager .saved-workspace").filter({ hasText: saved.name }).getByRole("button", { name: "编辑", exact: true }).click();
  const editor = control.locator(".workspace-editor");
  assert.equal(await editor.locator('.paged-rows input[type="checkbox"]').count(), 50);
  await editor.locator("[data-list=none]").click();
  await editor.locator('.paged-rows input[value="0"]').check();
  await editor.locator("[data-list=next]").click();
  await editor.locator('.paged-rows input[value="50"]').check();
  await editor.locator(".list-search").fill("备份页面 999");
  await editor.locator('.paged-rows input[value="999"]').check();
  await editor.locator(".list-selection").getByText("已选 3 / 1000 页", { exact: true }).waitFor();
  const name = editor.locator('input[name="workspace-name"]');
  await name.fill("跨页选择验证");
  await control.evaluate(() => { globalThis.draftNode = document.querySelector('.workspace-editor input[name="workspace-name"]'); });
  const operationBefore = control.locator("#workspace-manager .saved-workspace").first();
  const identity = await operationBefore.evaluate((element) => { globalThis.savedCardNode = element; return element.dataset.key; });
  await message(control, "createRecoveryCheckpoint");
  await waitForBrowserState(control, () => document.querySelector('.workspace-editor input[name="workspace-name"]') === globalThis.draftNode);
  assert.equal(await name.inputValue(), "跨页选择验证");
  assert.equal(await control.evaluate((id) => document.querySelector(`[data-key="${id}"]`) === globalThis.savedCardNode, identity), true);
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await waitForBrowserState(control, async (id) => (await chrome.runtime.sendMessage({ type: "getWorkspaces" })).find((workspace) => workspace.id === id).tabs.length === 3, imported.id);
  const edited = (await message(control, "getWorkspaces")).find((workspace) => workspace.id === imported.id);
  assert.deepEqual(edited.tabs.map((tab) => tab.url), [0, 50, 999].map((index) => saved.tabs[index].url));
  await control.evaluate(async (workspace) => {
    const { workspaces } = await chrome.storage.local.get("workspaces");
    await chrome.storage.local.set({ workspaces: workspaces.map((item) => item.id === workspace.id ? workspace : item) });
  }, imported);
  await waitForBrowserState(control, (name) => [...document.querySelectorAll("#workspace-manager strong")].some((node) => node.textContent === name), saved.name);
  // Native modal keyboard/focus behavior and command-to-restore routing.
  await control.locator("#open-palette").click();
  await control.locator("#palette-results [role=option]").first().waitFor();
  await control.locator("#palette-input").press("ArrowDown");
  assert.equal(await control.locator("#palette-input").getAttribute("aria-activedescendant"), "palette-option-1");
  await control.locator("#palette-input").press("Escape");
  await control.waitForFunction(() => !document.querySelector(".command-palette").open);
  assert.equal(await control.locator("#open-palette").evaluate((element) => document.activeElement === element), true);
  await control.keyboard.press("Control+k");
  await control.locator("#palette-input").fill(saved.name);
  await control.locator("#palette-results").getByText(`恢复工作区 · ${saved.name}`, { exact: true }).waitFor();
  await control.locator("#palette-input").press("Enter");
  await control.locator("#restore-preview").getByText(`选择恢复 · ${saved.name}`, { exact: true }).waitFor();
  const restore = control.locator("#restore-preview");
  assert.equal(await restore.locator('.paged-rows input[type="checkbox"]').count(), 50);
  await restore.locator("[data-restore=none]").click();
  await restore.locator('.paged-rows input[value="0"]').check();
  await restore.locator(".list-search").fill("备份页面 999");
  await restore.locator('.paged-rows input[value="999"]').check();
  await restore.locator(".selection-count").getByText("已选 2 / 1000 页", { exact: true }).waitFor();
  await restore.locator(".restore-layout").uncheck();
  await restore.locator("[data-restore=confirm]").click();
  await waitForBrowserState(control, async (name) => (await chrome.runtime.sendMessage({ type: "getRestoreTasks" })).some((task) => task.name === name && task.total === 2 && task.status === "completed"), saved.name);
  const restored = (await message(control, "getRestoreTasks")).find((task) => task.name === saved.name);
  const detail = await message(control, "getRestoreTask", { taskId: restored.id });
  assert.deepEqual(detail.results.map((page) => page.index), [0, 999]);
  assert.equal(detail.count, 2);
  await restore.locator("[data-restore=cancel]").click();
  await control.evaluate(async (workspace) => {
    const { recoveryCheckpoints = [] } = await chrome.storage.local.get("recoveryCheckpoints");
    await chrome.storage.local.set({ recoveryCheckpoints: [{ ...workspace, id: "large-diff", createdAt: Date.now() }, ...recoveryCheckpoints].slice(0, 10) });
  }, imported);
  await waitForBrowserState(control, () => [...document.querySelector(".compare-before").options].some((option) => option.value === "large-diff"));
  await show(control, "#session-tools");
  if (!await control.locator(".session-compare").evaluate((element) => element.open)) await control.locator(".session-compare > summary").click();
  await control.locator(".compare-before").selectOption("large-diff");
  await control.locator(".compare-after").selectOption("current");
  await control.locator("[data-session=compare]").click();
  const removed = control.locator(".diff-removed");
  await removed.locator('.paged-rows input[type="checkbox"]').first().waitFor();
  assert.equal(await removed.locator('.paged-rows input[type="checkbox"]').count(), 50);
  await removed.locator("[data-list=none]").click();
  const firstMissing = await removed.locator('.paged-rows input[type="checkbox"]').first().getAttribute("value");
  await removed.locator('.paged-rows input[type="checkbox"]').first().check();
  await removed.locator(".list-search").fill("备份页面 998");
  await removed.locator('.paged-rows input[value="998"]').check();
  await control.locator("[data-session=restore-missing]").click();
  await restore.locator(".selection-count").getByText("已选 2 / 1000 页", { exact: true }).waitFor();
  await restore.locator(".list-search").fill("备份页面 998");
  assert.equal(await restore.locator('.paged-rows input[value="998"]').isChecked(), true);
  assert.notEqual(Number(firstMissing), 998);
  await restore.locator("[data-restore=cancel]").click();
  // Exercise the DOM morph directly: keyed reorder, expansion, draft and scroll identity.
  const domResult = await control.evaluate(async () => {
    const { updateHTML } = await import(chrome.runtime.getURL("src/shared/live-ui.js"));
    const host = document.createElement("div"); document.body.append(host);
    updateHTML(host, '<details open><summary>State</summary><input value="original"><div data-key="a">A</div><div data-key="b">B</div></details>');
    const details = host.firstChild, draft = host.querySelector("input"), a = host.querySelector('[data-key=a]');
    details.open = false; draft.value = "unsaved";
    updateHTML(host, '<details open><summary>Updated</summary><input value="original"><div data-key="b">B2</div><div data-key="a">A2</div></details>');
    const result = { details: host.firstChild === details, open: details.open, draft: draft.value, row: a === host.querySelector('[data-key=a]'), text: a.textContent };
    host.remove(); return result;
  });
  assert.deepEqual(domResult, { details: true, open: false, draft: "unsaved", row: true, text: "A2" });
  // Real suspension effects: stop after the first five, retry remaining targets,
  // skip navigation changes and undo the successful first batch as one operation.
  await message(control, "updateSettings", { settings: { suspensionMode: "conservative", suspensionStrategy: "placeholder", resourceBudgetEnabled: false, trustedDomains: ["127.0.0.1"], resourceSampling: false } });
  const batchTabs = await control.evaluate(async (base) => {
    const current = await chrome.tabs.getCurrent();
    const tabs = [];
    for (let i = 0; i < 12; i++) tabs.push(await chrome.tabs.create({ url: `${base}/unified-batch-${i}`, windowId: current.windowId, active: false }));
    return tabs;
  }, fixture.baseUrl);
  await waitForBrowserState(control, async (expected) => (await Promise.all(expected.map(({ id }) => chrome.tabs.get(id)))).every((tab, index) => tab.status === "complete" && !tab.pendingUrl && tab.url === expected[index].url),
    batchTabs.map((tab, index) => ({ id: tab.id, url: `${fixture.baseUrl}/unified-batch-${index}` })));
  const batchWorker = await waitForWorker(context);
  await batchWorker.evaluate(() => {
    globalThis.batchUpdate = chrome.tabs.update.bind(chrome.tabs);
    globalThis.batchStarted = 0;
    const hold = new Promise((resolve) => { globalThis.releaseBatchUpdate = resolve; });
    chrome.tabs.update = async (id, changes) => {
      if (changes.url?.includes("/suspended.html")) { globalThis.batchStarted++; await hold; }
      return globalThis.batchUpdate(id, changes);
    };
  });
  let stopped;
  try {
    const preview = await message(control, "prepareBatch", { kind: "suspend" });
    const selectedIds = preview.pages.slice(-12).map((page) => page.tabId);
    assert.equal(selectedIds.length, 12);
    const started = await message(control, "startBatchPreview", { previewId: preview.previewId, tabIds: selectedIds });
    assert.ok(started.taskId);
    await waitForBrowserState(control, async (id) => (await chrome.storage.session.get("batchTasks")).batchTasks.find((task) => task.id === id).results.filter((page) => page.status === "executing").length === 5, started.taskId);
    await control.locator(`[data-task-id="${started.taskId}"] [data-task=stop]`).click();
    await batchWorker.evaluate(() => globalThis.releaseBatchUpdate());
    await waitForBrowserState(control, async (id) => Boolean((await chrome.runtime.sendMessage({ type: "getTask", taskId: id })).operationId), started.taskId);
    stopped = await message(control, "getTask", { taskId: started.taskId });
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.count, 5);
    await control.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), { id: selectedIds[5], url: `${fixture.baseUrl}/batch-changed` });
    await waitForBrowserState(control, async ({ id, url }) => { const tab = await chrome.tabs.get(id); return tab.status === "complete" && !tab.pendingUrl && tab.url === url; },
      { id: selectedIds[5], url: `${fixture.baseUrl}/batch-changed` });
    const retried = await message(control, "retryTask", { taskId: started.taskId, taskType: "batch" });
    await waitForBrowserState(control, async (id) => (await chrome.runtime.sendMessage({ type: "getTask", taskId: id })).status === "completed", retried.taskId);
    const retriedDetail = await message(control, "getTask", { taskId: retried.taskId });
    assert.equal(retriedDetail.count, 6);
    assert.equal(retriedDetail.skipped, 1);
    const undo = await message(control, "undoOperation", { operationId: stopped.operationId });
    assert.equal(undo.restored, 5);
    await waitForBrowserState(control, async (expected) => {
      const tabs = await Promise.all(expected.map((page) => chrome.tabs.get(page.tabId)));
      return tabs.every((tab, index) => tab.url === expected[index].url && !tab.pendingUrl && tab.status === "complete");
    }, preview.pages.slice(-12).slice(0, 5));
  } finally {
    await batchWorker.evaluate(() => { globalThis.releaseBatchUpdate?.(); chrome.tabs.update = globalThis.batchUpdate; delete globalThis.batchUpdate; delete globalThis.releaseBatchUpdate; });
  }
  const urlsBeforeRestart = await control.evaluate(() => chrome.tabs.query({}).then((tabs) => tabs.map((tab) => [tab.id, tab.url])));
  await control.evaluate(async () => {
    const { batchTasks } = await chrome.storage.session.get("batchTasks");
    const next = [{ id: "unified-restart", name: "批量中断验证", kind: "suspend", status: "running", createdAt: Date.now(),
      results: [{ index: 0, status: "executing", tabId: -1, url: "https://unused.test/" }, { index: 1, status: "pending", tabId: -2, url: "https://unused.test/2" }] }, ...batchTasks].slice(0, 10);
    const { batchLedgerSnapshot } = await import(chrome.runtime.getURL("src/shared/task-ledger.js"));
    await chrome.storage.local.set({ batchTaskLedger: batchLedgerSnapshot(next) });
    await chrome.storage.session.set({ batchTasks: next });
  });
  const cdp = await context.newCDPSession(control);
  const { targetInfos } = await cdp.send("Target.getTargets");
  await cdp.send("Target.closeTarget", { targetId: targetInfos.find((target) => target.type === "service_worker" && target.url === batchWorker.url()).targetId });
  const interrupted = await message(control, "getTask", { taskId: "unified-restart" });
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.results[0].status, "uncertain");
  assert.deepEqual(await control.evaluate(() => chrome.tabs.query({}).then((tabs) => tabs.map((tab) => [tab.id, tab.url]))), urlsBeforeRestart);
  await cdp.detach();
  // Actual sidebar AI and diagnostics render 1000 metadata rows in bounded pages.
  const worker = await waitForWorker(context);
  await worker.evaluate(() => {
    globalThis.enhancementQuery = chrome.tabs.query.bind(chrome.tabs);
    globalThis.enhancementScript = chrome.scripting.executeScript.bind(chrome.scripting);
    const tabs = Array.from({ length: 1000 }, (_, i) => ({ id: 200000 + i, title: `增强规模 ${i}`, url: `https://enhancement-${i}.test/`, windowId: 1, index: i, status: "complete" }));
    chrome.tabs.query = async () => tabs;
    chrome.scripting.executeScript = async () => [{ result: { usedJSHeapSize: 1048576, totalJSHeapSize: 2097152 } }];
  });
  try {
    await (await show(control, "#ai-scope")).selectOption("selected");
    await control.locator("#refresh-ai-sources").click();
    await control.locator("#ai-tab-options").getByText("增强规模 0", { exact: true }).waitFor();
    assert.equal(await control.locator('#ai-tab-options .paged-rows input[type="checkbox"]').count(), 50);
    await control.locator('#ai-tab-options input[value="200000"]').check();
    await control.locator("#ai-tab-options [data-list=next]").click();
    await control.locator('#ai-tab-options input[value="200050"]').check();
    await control.locator("#preview-ai-input").click();
    await control.locator("#ai-input-summary").getByText(/^2 页/).waitFor();
    await (await show(control, "#measure-resources")).click();
    await control.locator("#renderer-diagnostics .list-pagination").getByText("第 1 / 20 页 · 匹配 1000 项").waitFor();
    assert.equal(await control.locator("#renderer-diagnostics .paged-rows > .saved-member").count(), 50);
    await control.locator("#renderer-diagnostics .list-search").fill("增强规模 999");
    await control.locator("#renderer-diagnostics .paged-rows").getByText("增强规模 999", { exact: true }).waitFor();
    assert.equal(await control.locator("#renderer-diagnostics .paged-rows > .saved-member").count(), 1);
  } finally {
    await worker.evaluate(() => {
      chrome.tabs.query = globalThis.enhancementQuery; chrome.scripting.executeScript = globalThis.enhancementScript;
      delete globalThis.enhancementQuery; delete globalThis.enhancementScript;
    });
  }
  await (await show(control, "#ai-scope")).selectOption("current");
  await control.evaluate(() => {
    globalThis.paletteSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message) => {
      if (message.type === "searchPages" && message.query === "旧请求") return new Promise((resolve) => { globalThis.releaseOldPalette = () => resolve([{ id: "old", title: "旧内容", url: "https://old.test/", source: "open" }]); });
      if (message.type === "searchPages" && message.query === "新请求") return Promise.resolve([{ id: "new", title: "新内容", url: "https://new.test/", source: "open" }]);
      return globalThis.paletteSend(message);
    };
  });
  try {
    await control.locator("#open-palette").click();
    await control.locator("#palette-input").fill("旧请求");
    await control.waitForFunction(() => Boolean(globalThis.releaseOldPalette));
    await control.locator("#palette-input").fill("新请求");
    await control.locator("#palette-results").getByText("打开 · 新内容", { exact: true }).waitFor();
    await control.evaluate(async () => { globalThis.releaseOldPalette(); await Promise.resolve(); await Promise.resolve(); });
    assert.equal(await control.locator("#palette-results").getByText("打开 · 旧内容", { exact: true }).count(), 0);
    await control.locator("#palette-input").press("Escape");
  } finally {
    await control.evaluate(() => { chrome.runtime.sendMessage = globalThis.paletteSend; delete globalThis.paletteSend; delete globalThis.releaseOldPalette; });
  }
  // Popup has the same palette and preview entry; narrow/light/dark modal layouts.
  const popup = await context.newPage(); popup.on("pageerror", (error) => errors.push(error.message));
  await popup.goto(`${extensionUrl}/src/popup/popup.html`);
  await popup.locator("#open-palette").click();
  await popup.locator("#palette-input").fill("批量休眠");
  await popup.locator("#palette-results").getByText("批量休眠预览", { exact: true }).waitFor();
  for (const colorScheme of ["light", "dark"]) {
    await popup.emulateMedia({ colorScheme }); await popup.setViewportSize({ width: 410, height: 900 });
    assert.ok(await popup.evaluate(() => document.querySelector(".command-palette").scrollWidth <= document.querySelector(".command-palette").clientWidth));
    if (process.env.TABWISE_E2E_ARTIFACT_DIR) await popup.locator(".command-palette").screenshot({ path: path.join(process.env.TABWISE_E2E_ARTIFACT_DIR, `palette-${colorScheme}-410.png`) });
  }
  await popup.locator("#palette-input").press("Enter");
  await popup.locator("#batch-preview").getByText("休眠预览", { exact: true }).waitFor();
  await popup.locator("[data-batch=cancel]").click();
  await popup.close();
  await upload(await message(control, "exportBackup"));
  await options.locator("#backup-feedback").getByText("完整性校验通过，等待确认导入。", { exact: true }).waitFor();
  assert.equal(await options.locator("[data-backup-index]:checked").count(), 0);
  for (const colorScheme of ["light", "dark"]) {
    await options.emulateMedia({ colorScheme }); await options.setViewportSize({ width: 420, height: 900 });
    assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (process.env.TABWISE_E2E_ARTIFACT_DIR) await options.locator(".backup-note").screenshot({ path: path.join(process.env.TABWISE_E2E_ARTIFACT_DIR, `backup-${colorScheme}-420.png`) });
  }
  await options.locator("[data-backup=cancel]").click();
  const corrupt = await message(control, "exportBackup");
  corrupt.payload.settings.idleMinutes = 1;
  await upload(corrupt);
  await options.locator("#backup-feedback").getByText("备份完整性校验失败，内容可能被修改。", { exact: true }).waitFor();
  assert.equal(await options.locator("#backup-preview").isVisible(), false);
  await control.evaluate((state) => chrome.storage.local.set(state), initial);
  await options.close();
  assert.deepEqual(errors, []);
  console.log("E2E PASS: complete backup integrity, 1000-page cross-page edit/restore, lazy AI and paged diagnostics, keyed DOM identity, palette keyboard/focus/routing and responsive light/dark dialogs");
}
