import assert from "node:assert/strict";

export async function verifyReliability({ context, control, fixture, extensionUrl, message, waitForBrowserState, waitForWorker }) {
  const originalSettings = await control.evaluate(() => chrome.storage.local.get("settings")).then((state) => state.settings);
  await message(control, "updateSettings", { settings: { autoSuspend: false, resourceSamplingMode: "off", suspensionMode: "conservative", trustedDomains: ["127.0.0.1"] } });

  // Saved-page categories and remembered options remain side-effect-free until confirmation.
  const source = { id: "reliability-preset", name: "可靠性预设", favorite: true, tabs: [
    { title: "研究 A", url: `${fixture.baseUrl}/preset-a`, tags: ["研究"] },
    { title: "其他 B", url: `${fixture.baseUrl}/preset-b`, tags: ["其他"] }
  ], restorePreset: { loadMode: "on-demand", concurrency: 2, restoreLayout: false, skipExisting: true, tag: "研究" } };
  await control.evaluate(async (item) => {
    const { workspaces } = await chrome.storage.local.get("workspaces");
    await chrome.storage.local.set({ workspaces: [item, ...workspaces.filter((workspace) => workspace.id !== item.id)].slice(0, 20) });
  }, source);
  await control.reload();
  await control.locator(".workspace-favorites").getByRole("button", { name: "★ 可靠性预设", exact: true }).click();
  assert.equal(await control.locator(".restore-load-mode").inputValue(), "on-demand");
  assert.equal(await control.locator(".restore-concurrency").inputValue(), "2");
  assert.equal(await control.locator(".restore-tag").inputValue(), "研究");
  assert.equal(await control.locator(".selection-count").textContent(), "已选 1 / 2 页");
  assert.equal(fixture.hits.get("preset-a") || 0, 0);
  await control.locator("#restore-preview").getByRole("button", { name: "恢复所选页面", exact: true }).click();
  await waitForBrowserState(control, async () => (await chrome.runtime.sendMessage({ type: "getRestoreTasks" })).some((task) => task.sourceId === "reliability-preset" && task.status === "completed"));
  assert.equal(fixture.hits.get("preset-a") || 0, 0);
  assert.equal(fixture.hits.get("preset-b") || 0, 0);

  // Duplicate preview revalidates keeper navigation and cannot be replayed.
  const pages = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
  for (const page of pages) await page.goto(`${fixture.baseUrl}/duplicate-fault`);
  await control.bringToFront();
  const ids = (await control.evaluate(() => chrome.tabs.query({}))).filter((tab) => tab.url.endsWith("/duplicate-fault")).map((tab) => tab.id);
  const preview = await message(control, "prepareDuplicateConsolidation", { tabIds: ids });
  assert.equal(preview.pages.length, 2);
  await control.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), { id: preview.pages[0].keepTabId, url: `${fixture.baseUrl}/keeper-changed` });
  const skipped = await message(control, "consolidateDuplicates", { previewId: preview.id, indices: [0, 1], confirm: true });
  assert.equal(skipped.count, 0);
  assert.equal((await message(control, "consolidateDuplicates", { previewId: preview.id, indices: [0], confirm: true })).ok, false);
  const next = await message(control, "prepareDuplicateConsolidation", { tabIds: ids });
  assert.equal(next.pages.length, 1);
  assert.equal((await message(control, "consolidateDuplicates", { previewId: next.id, indices: [0], confirm: true })).count, 1);
  await Promise.all(pages.map((page) => page.close().catch(() => {})));

  // Opt-in HEAD checks classify offline pages as unknown, and leave saved state untouched.
  let linkPreview = await message(control, "prepareWorkspaceLinkCheck", { workspaceId: source.id });
  const beforeLinks = await message(control, "getWorkspaces");
  const checked = await message(control, "checkWorkspaceLinks", { previewId: linkPreview.id, indices: [0], confirm: true });
  assert.equal(checked.ok, true);
  assert.equal(checked.results[0].status, "reachable");
  assert.equal(fixture.hits.get("preset-a"), 1);
  assert.equal(fixture.hits.get("preset-b") || 0, 0);
  assert.deepEqual(await message(control, "getWorkspaces"), beforeLinks);
  linkPreview = await message(control, "prepareWorkspaceLinkCheck", { workspaceId: source.id });
  await context.setOffline(true);
  try {
    const offline = await message(control, "checkWorkspaceLinks", { previewId: linkPreview.id, indices: [1], confirm: true });
    assert.equal(offline.results[0].status, "unknown");
  } finally { await context.setOffline(false); }

  // Runtime permission denial models revoked website access without changing the profile policy.
  let worker = await waitForWorker(context);
  await worker.evaluate(() => { globalThis.__originalContains = chrome.permissions.contains; chrome.permissions.contains = async () => false; });
  try {
    const denied = await message(control, "getResourceDiagnostics");
    assert.equal(denied.ok, false);
    assert.ok(denied.permissionRequest);
  } finally { await worker.evaluate(() => { chrome.permissions.contains = globalThis.__originalContains; delete globalThis.__originalContains; }); }

  // Force-stop the real worker while a durable restore reservation is opening.
  const cdp = await context.newCDPSession(control);
  const { sourceState } = await import("../src/shared/restoration.js");
  const task = { id: "force-stop-restore", name: "强制停止恢复", kind: "workspace", sourceId: source.id,
    signature: sourceState(source), status: "running", total: 2, indices: [0, 1], createdAt: Date.now(),
    skipExisting: true, restoreLayout: false, loadMode: "on-demand", concurrency: 1,
    results: [{ index: 0, status: "opening" }, { index: 1, status: "pending" }] };
  await control.evaluate((item) => chrome.storage.session.set({ restoreTasks: [item] }), task);
  await control.evaluate((item) => chrome.storage.local.set({ restoreTaskLedger: [item] }), task);
  worker = await waitForWorker(context);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const target = targetInfos.find((item) => item.type === "service_worker" && item.url === worker.url());
  assert.ok(target);
  const beforeRestart = fixture.hits.get("preset-b") || 0;
  assert.equal((await cdp.send("Target.closeTarget", { targetId: target.targetId })).success, true);
  const interrupted = await message(control, "getRestoreTask", { taskId: task.id });
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.results[0].status, "uncertain");
  assert.equal(fixture.hits.get("preset-b") || 0, beforeRestart);
  const successors = await Promise.all([message(control, "retryRestoreTask", { taskId: task.id }),
    message(control, "resumeRestoreTask", { taskId: task.id, taskType: "restore" })]);
  assert.equal(successors.filter((item) => item.ok).length, 1);
  await waitForBrowserState(control, async (id) => (await chrome.runtime.sendMessage({ type: "getRestoreTask", taskId: id })).status === "completed", successors.find((item) => item.ok).taskId);
  assert.equal(fixture.hits.get("preset-b") || 0, beforeRestart);
  await cdp.detach();

  // Actual extension-page UI verifies selected synchronization and stale-preview rejection.
  const options = await context.newPage();
  await options.goto(`${extensionUrl}/src/options/options.html`);
  await options.locator("#sync-metadata").click();
  await options.waitForFunction(() => !document.querySelector("#sync-metadata").disabled);
  assert.equal(await options.locator("#sync-preview").isVisible(), true, await options.locator("#sync-feedback").textContent());
  for (const checkbox of await options.locator("[data-sync-workspace]").all()) await checkbox.uncheck();
  await options.locator(`[data-sync-workspace="${source.id}"]`).check();
  await options.locator('[data-sync="apply"]').click();
  await options.locator("#sync-preview").waitFor({ state: "hidden" });
  const synced = await options.evaluate(async () => {
    const { readSyncMetadata } = await import("../shared/sync-transport.js");
    return (await readSyncMetadata()).metadata;
  });
  assert.deepEqual(synced.workspaces.map((workspace) => workspace.id), [source.id]);
  assert.equal(synced.workspaces[0].restorePreset.concurrency, 2);
  assert.equal(JSON.stringify(synced).includes("本机阅读备注"), false);
  await options.locator("#sync-metadata").click();
  await options.locator("#sync-preview").waitFor({ state: "visible" });
  await control.evaluate(async () => {
    const { workspaces } = await chrome.storage.local.get("workspaces");
    workspaces[0].name += "已改变";
    await chrome.storage.local.set({ workspaces });
  });
  await options.locator('[data-sync="apply"]').click();
  await options.locator("#sync-feedback").filter({ hasText: "预览已变化" }).waitFor();
  await options.close();
  await message(control, "updateSettings", { settings: originalSettings });
  console.log("Reliability E2E PASS: presets/tags without loads, stale/replayed duplicates, scoped HEAD/offline, permission denial simulation, real worker termination, atomic retry/resume, selected sync UI");
}
