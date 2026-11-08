import assert from "node:assert/strict";
import { show } from "./ui-navigation.mjs";
import path from "node:path";
import { sourceState } from "../src/shared/restoration.js";

export async function verifySession({ context, control, fixture, extensionUrl, message, waitForBrowserState, waitForWorker }) {
  const errors = [];
  control.on("pageerror", (error) => errors.push(error.message));
  await message(control, "updateSettings", { settings: { closedHistoryEnabled: true, closedHistoryDays: 7 } });
  // Actual Chromium windows and groups, including a placeholder whose origin must not reload.
  const layout = await control.evaluate(async (base) => {
    const first = await chrome.windows.create({ url: `${base}/session-pin`, focused: false });
    const pinned = await chrome.tabs.update(first.tabs[0].id, { pinned: true });
    const grouped = await chrome.tabs.create({ windowId: first.id, url: `${base}/session-group`, active: false });
    const sleeping = await chrome.tabs.create({ windowId: first.id, url: `${base}/session-sleep`, active: false });
    const active = await chrome.tabs.create({ windowId: first.id, url: `${base}/session-active`, active: true });
    const groupId = await chrome.tabs.group({ tabIds: [grouped.id, sleeping.id], createProperties: { windowId: first.id } });
    await chrome.tabGroups.update(groupId, { title: "研究布局", color: "blue", collapsed: true });
    const second = await chrome.windows.create({ url: `${base}/session-second`, focused: false });
    return { first: first.id, second: second.id, pinned: pinned.id, grouped: grouped.id, sleeping: sleeping.id, active: active.id };
  }, fixture.baseUrl);
  await waitForBrowserState(control, async (ids) => (await chrome.tabs.query({})).filter((tab) => [ids.first, ids.second].includes(tab.windowId)).every((tab) => tab.status === "complete"), layout);
  assert.equal((await message(control, "directSuspendTab", { tabId: layout.sleeping })).ok, true);
  await waitForBrowserState(control, async (id) => (await chrome.tabs.get(id)).url.includes("/suspended.html"), layout.sleeping);
  const saved = await message(control, "createRecoveryCheckpoint");
  assert.equal(saved.ok, true);
  const checkpoint = (await message(control, "getRecoveryCheckpoints"))[0];
  assert.equal(checkpoint.schemaVersion, 2);
  const indices = checkpoint.tabs.map((page, index) => page.url.includes("/session-") ? index : -1).filter((index) => index >= 0);
  assert.equal(indices.length, 5);
  assert.equal(checkpoint.tabs[indices.find((index) => checkpoint.tabs[index].url.endsWith("session-sleep"))].status, "suspended");
  assert.ok(checkpoint.tabs.every((item) => !("tabId" in item) && !("windowId" in item)));
  const group = checkpoint.groups.find((item) => item.title === "研究布局");
  assert.equal(group.color, "blue");
  assert.equal(group.collapsed, true);
  const before = await control.evaluate((ids) => chrome.tabs.query({}).then((tabs) => tabs.filter((tab) => [ids.first, ids.second].includes(tab.windowId)).map(({ id, index, pinned, groupId, active, url }) => ({ id, index, pinned, groupId, active, url }))), layout);
  const sleepHits = fixture.hits.get("session-sleep");
  const preview = await message(control, "prepareRestore", { kind: "checkpoint", sourceId: checkpoint.id });
  assert.equal(preview.hasLayout, true);
  const restored = await message(control, "confirmRestore", { previewId: preview.previewId, indices, skipExisting: false, restoreLayout: true });
  assert.equal(restored.count, 5);
  assert.deepEqual(restored.layoutErrors, []);
  assert.equal(fixture.hits.get("session-sleep"), sleepHits, "sleeping snapshot must never load its original server");
  const newWindows = [...new Set(restored.results.map((item) => item.windowId))];
  assert.equal(newWindows.length, 2);
  assert.ok(newWindows.every((id) => ![layout.first, layout.second].includes(id)));
  for (const id of newWindows) {
    const tabs = await control.evaluate((windowId) => chrome.tabs.query({ windowId }), id);
    const expected = restored.results.filter((item) => item.windowId === id).map((item) => checkpoint.tabs[item.index]);
    assert.deepEqual(tabs.map((tab) => tab.pinned), expected.map((page) => page.pinned));
    assert.deepEqual(tabs.map((tab) => tab.id), restored.results.filter((item) => item.windowId === id).map((item) => item.tabId));
    assert.equal(tabs.find((tab) => tab.active).id, restored.results.find((item) => item.windowId === id && checkpoint.tabs[item.index].active).tabId);
  }
  const newGroups = await control.evaluate(() => chrome.tabGroups.query({}));
  const restoredGroup = newGroups.find((item) => item.title === "研究布局" && newWindows.includes(item.windowId));
  assert.equal(restoredGroup.color, "blue");
  assert.equal(restoredGroup.collapsed, true);
  const groupMembers = await control.evaluate((id) => chrome.tabs.query({ groupId: id }).then((tabs) => tabs.map((tab) => tab.id)), restoredGroup.id);
  assert.deepEqual(groupMembers, restored.results.filter((item) => checkpoint.tabs[item.index].groupKey === group.key).map((item) => item.tabId));
  const original = await control.evaluate((ids) => chrome.tabs.query({}).then((tabs) => tabs.filter((tab) => [ids.first, ids.second].includes(tab.windowId)).map(({ id, index, pinned, groupId, active, url }) => ({ id, index, pinned, groupId, active, url }))), layout);
  assert.deepEqual(original, before, "restoration must preserve existing windows and groups");
  // Export/import must preserve the same layout fields and older backups remain valid.
  const imported = await message(control, "importBackup", { backup: { schemaVersion: 1, workspaces: [{ ...checkpoint, name: "导入的会话布局" }] } });
  assert.equal(imported.ok, true);
  const importedWorkspace = (await message(control, "getWorkspaces")).find((item) => item.name === "导入的会话布局");
  assert.equal(importedWorkspace.schemaVersion, 2);
  assert.ok(importedWorkspace.groups.some((item) => item.title === "研究布局" && item.color === "blue" && item.collapsed));
  assert.equal(importedWorkspace.tabs.filter((item) => item.status === "suspended").length, checkpoint.tabs.filter((item) => item.status === "suspended").length);
  const exported = await message(control, "exportBackup");
  assert.ok(exported.payload.workspaces.find((item) => item.name === "导入的会话布局").groups.length);
  // Live UI refresh preserves a workspace draft, page checks, search and focus.
  await control.bringToFront();
  await show(control, "#workspace-manager");
  await control.locator("#workspace-manager .saved-workspace").first().getByRole("button", { name: "编辑", exact: true }).click();
  const draft = control.locator('.workspace-editor input[name="workspace-name"]');
  await draft.fill("尚未保存的修改");
  const checkbox = control.locator('.workspace-editor .saved-members input[type="checkbox"]').first();
  await checkbox.uncheck();
  await (await show(control, "#ai-scope")).selectOption("selected");
  await (await show(control, "#page-search")).fill("session-pin");
  await control.locator("#search-results .result").first().waitFor();
  const added = await control.evaluate((base) => chrome.tabs.create({ url: `${base}/live-sync-marker`, active: false }), fixture.baseUrl);
  await waitForBrowserState(control, () => [...document.querySelectorAll("#ai-tab-options strong")].some((item) => item.textContent === "live-sync-marker"));
  assert.equal(await draft.inputValue(), "尚未保存的修改");
  assert.equal(await checkbox.isChecked(), false);
  assert.equal(await control.locator("#page-search").inputValue(), "session-pin");
  assert.equal(await control.locator("#page-search").evaluate((element) => document.activeElement === element), true);
  // UI searches use real metadata and merge sources, plus latest-result ownership.
  await control.evaluate(async (base) => {
    const { workspaces = [] } = await chrome.storage.local.get("workspaces");
    await chrome.storage.local.set({ workspaces: [{ id: "pinyin-e2e", name: "拼音工作区", createdAt: Date.now(), tabs: [
      { title: "浏览器性能调研", url: `${base}/session-pin` },
      { title: "React performance handbook", url: `${base}/typo-page` }
    ] }, ...workspaces] });
  }, fixture.baseUrl);
  await control.locator("#page-search").fill("liulanqi xingneng");
  await control.locator("#search-results").getByText("浏览器性能调研", { exact: true }).waitFor();
  await control.locator("#page-search").fill("llqxn");
  await control.locator("#search-results").getByText("浏览器性能调研", { exact: true }).waitFor();
  await control.locator("#page-search").fill("react performnace");
  await control.locator("#search-results").getByText("React performance handbook", { exact: true }).waitFor();
  await control.locator("details").filter({ has: control.locator("#search-source") }).locator("summary").click();
  await control.locator("#search-source").selectOption("workspace");
  await control.locator("#search-workspace").selectOption("pinyin-e2e");
  await control.locator("#search-status").selectOption("saved");
  await control.locator("#page-search").fill("llq");
  await control.locator("#search-results").getByText("浏览器性能调研", { exact: true }).waitFor();
  assert.equal(await control.locator("#search-results .result").count(), 1);
  await control.locator("#search-source").selectOption("all");
  await control.locator("#search-workspace").selectOption("");
  await control.locator("#search-status").selectOption("all");
  await control.locator("#page-search").fill("session-pin");
  await control.locator("#search-results").getByText("工作区：拼音工作区", { exact: false }).waitFor();
  assert.equal(await control.locator("#search-results .result").count(), 1);
  await control.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message) => {
      const result = await send(message);
      if (message.type === "searchPageCatalog" && message.query === "llq") {
        await new Promise((resolve) => { globalThis.releaseOldSearch = resolve; });
      }
      return result;
    };
  });
  await control.locator("#page-search").fill("llq");
  await waitForBrowserState(control, () => typeof globalThis.releaseOldSearch === "function");
  await control.locator("#page-search").fill("react performnace");
  await control.locator("#search-results").getByText("React performance handbook", { exact: true }).waitFor();
  await control.evaluate(() => globalThis.releaseOldSearch());
  // Drain the microtasks triggered by releasing the stale response.
  await control.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await control.locator("#search-results").getByText("浏览器性能调研", { exact: true }).count(), 0);
  // Closed metadata survives a worker restart; clear and disable both erase it.
  await control.evaluate((id) => chrome.tabs.remove(id), added.id);
  await show(control, "#session-tools");
  await control.locator(".session-history > summary").click();
  await control.locator(".closed-list").getByText("live-sync-marker", { exact: true }).waitFor();
  const cdp = await context.newCDPSession(control);
  const worker = await waitForWorker(context);
  const { targetInfos } = await cdp.send("Target.getTargets");
  await cdp.send("Target.closeTarget", { targetId: targetInfos.find((item) => item.type === "service_worker" && item.url === worker.url()).targetId });
  assert.ok((await message(control, "getClosedPages")).some((item) => item.url.endsWith("/live-sync-marker")));
  await cdp.detach();
  await control.locator(".closed-list .saved-workspace").filter({ hasText: "live-sync-marker" }).getByRole("button", { name: "找回页面" }).click();
  await waitForBrowserState(control, async () => (await chrome.tabs.query({})).some((item) => item.url?.endsWith("/live-sync-marker")));
  await control.bringToFront();
  await control.locator("[data-session=clear]").click();
  await waitForBrowserState(control, async () => (await chrome.runtime.sendMessage({ type: "getClosedPages" })).length === 0);
  const closeAgain = await control.evaluate(() => chrome.tabs.query({}).then((tabs) => chrome.tabs.remove(tabs.find((tab) => tab.url?.endsWith("/live-sync-marker")).id)));
  void closeAgain;
  await control.locator(".closed-list").getByText("live-sync-marker", { exact: true }).waitFor();
  await message(control, "updateSettings", { settings: { closedHistoryEnabled: false } });
  await waitForBrowserState(control, () => document.querySelector(".history-hint").textContent.includes("已停用"));
  assert.deepEqual((await control.evaluate(() => chrome.storage.local.get("closedPages"))).closedPages, []);
  await message(control, "updateSettings", { settings: { closedHistoryEnabled: true } });
  // Compare a baseline with the current session, then restore only missing selections.
  await control.evaluate((ids) => chrome.windows.remove(ids.first), layout);
  await control.evaluate((ids) => chrome.windows.remove(ids.second), layout);
  await control.evaluate((ids) => Promise.all(ids.map((id) => chrome.windows.remove(id))), newWindows);
  await control.locator(".session-compare > summary").click();
  await control.locator(".compare-before").selectOption(checkpoint.id);
  await control.locator(".compare-after").selectOption("current");
  await control.locator("[data-session=compare]").click();
  await control.locator(".diff-removed").getByText("session-sleep", { exact: true }).waitFor();
  const missing = await message(control, "compareCheckpoint", { beforeId: checkpoint.id, afterId: "current" });
  assert.ok(missing.removed.some((item) => item.url.endsWith("/session-sleep")));
  for (const input of await control.locator('.diff-removed input[type="checkbox"]').all()) await input.uncheck();
  const missingSleep = control.locator(".diff-removed label").filter({ hasText: "session-sleep" }).locator("input");
  await missingSleep.check();
  await control.locator("[data-session=restore-missing]").click();
  await control.waitForFunction(() => document.querySelectorAll("#restore-preview .saved-members input:checked").length === 1);
  assert.equal(await control.locator("#restore-preview .saved-members input:checked").count(), 1);
  assert.equal(await control.locator("#restore-preview .restore-layout").isChecked(), true);
  await control.locator("#restore-preview [data-restore=confirm]").click();
  await control.locator(".restore-result").getByText("已打开 1 页 · 跳过 0 页 · 失败 0 页", { exact: true }).waitFor();
  assert.equal(fixture.hits.get("session-sleep"), sleepHits);
  // Validate signature recheck and the explicit opt-out of layout restoration.
  assert.equal((await message(control, "prepareRestore", { kind: "checkpoint", sourceId: checkpoint.id, signature: "stale" })).ok, false);
  assert.equal((await message(control, "prepareRestore", { kind: "checkpoint", sourceId: checkpoint.id, signature: sourceState(checkpoint) })).ok, true);
  await control.locator("#restore-preview [data-restore=cancel]").click();
  await control.locator("[data-session=restore-missing]").click();
  await control.locator("#restore-preview .restore-layout").uncheck();
  await control.locator("#restore-preview .skip-existing").uncheck();
  const countBefore = (await control.evaluate(() => chrome.windows.getAll())).length;
  await control.locator("#restore-preview [data-restore=confirm]").click();
  await control.locator(".restore-result").getByText("已打开 1 页 · 跳过 0 页 · 失败 0 页", { exact: true }).waitFor();
  assert.equal((await control.evaluate(() => chrome.windows.getAll())).length, countBefore);
  assert.equal(fixture.hits.get("session-sleep"), sleepHits + 1);
  await control.locator("#restore-preview [data-restore=cancel]").click();
  const popup = await context.newPage();
  await popup.goto(`${extensionUrl}/src/popup/popup.html`);
  await popup.locator("#open-count").getByText(/^\d+$/).waitFor();
  // Other restored pages may finish while this popup is open. Verify the
  // specific new tab instead of assuming unrelated counts stay constant.
  await popup.locator("#tab-search").fill("popup-sync");
  const syncTab = await popup.evaluate((base) => chrome.tabs.create({ url: `${base}/popup-sync`, active: false }), fixture.baseUrl);
  await waitForBrowserState(popup, () => [...document.querySelectorAll("#tabs .row strong")].some((item) => item.textContent === "popup-sync"));
  await popup.evaluate((id) => chrome.tabs.remove(id), syncTab.id);
  await waitForBrowserState(popup, () => !document.querySelector("#tabs .row"));
  const settingsPage = await context.newPage();
  await settingsPage.goto(`${extensionUrl}/src/options/options.html`);
  await show(settingsPage, "#closed-history-enabled");
  await settingsPage.waitForFunction(() => document.querySelector("#closed-history-days").value === "7");
  await settingsPage.locator("#closed-history-enabled").uncheck();
  await settingsPage.locator("#settings-form").getByRole("button", { name: "保存设置", exact: true }).click();
  await settingsPage.getByText("已保存", { exact: true }).waitFor();
  await settingsPage.reload();
  await settingsPage.waitForFunction(() => document.querySelector("#closed-history-days").value === "7");
  assert.equal(await settingsPage.locator("#closed-history-enabled").isChecked(), false);
  await settingsPage.locator("#closed-history-enabled").check();
  await settingsPage.locator("#closed-history-days").fill("10");
  await settingsPage.locator("#settings-form").getByRole("button", { name: "保存设置", exact: true }).click();
  await settingsPage.getByText("已保存", { exact: true }).waitFor();
  assert.equal((await message(control, "getDashboard")).settings.closedHistoryDays, 10);
  await settingsPage.close();
  assert.deepEqual(errors, []);
  if (process.env.TABWISE_E2E_ARTIFACT_DIR) {
    for (const colorScheme of ["light", "dark"]) {
      await control.emulateMedia({ colorScheme });
      await control.setViewportSize({ width: 320, height: 900 });
      assert.ok(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await control.locator("#session-tools").screenshot({ path: path.join(process.env.TABWISE_E2E_ARTIFACT_DIR, `session-${colorScheme}-320.png`) });
      await popup.emulateMedia({ colorScheme });
      await popup.setViewportSize({ width: 410, height: 900 });
      assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await show(popup, "#session-tools");
      await popup.locator("#session-tools").screenshot({ path: path.join(process.env.TABWISE_E2E_ARTIFACT_DIR, `popup-session-${colorScheme}-410.png`) });
    }
  }
  await popup.close();
  console.log("E2E PASS: full window/group/pin/active/sleep snapshot, layout restore and opt-out; event UI sync; pinyin/typos/filters/dedup/latest search; closed restart/clear/disable; missing-only snapshot diff");
}
