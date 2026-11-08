import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";

// Toolbars use intrinsic popup sizing. Opening popup.html in a tab does not test it.
// Playwright does not attach this action target, so use public CDP Target/Input/DOM APIs.
function popupSession(cdp, sessionId) {
  let sequence = 0;
  const pending = new Map();
  cdp.on("Target.receivedMessageFromTarget", (event) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message), entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Popup CDP timeout: ${method}`)); }, 7000);
    pending.set(id, { resolve, reject, timer });
    cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }).catch((error) => {
      pending.delete(id); clearTimeout(timer); reject(error);
    });
  });
  const read = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async (condition) => {
    const deadline = Date.now() + 5000;
    // Action popups can throttle animation frames when a native dialog opens.
    // Bounded external observations also let Chrome finish extension callbacks.
    while (Date.now() < deadline) {
      if (await read(condition)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Popup state did not settle: ${condition}`);
  };
  const click = async (selector) => {
    const { root } = await send("DOM.getDocument");
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
    assert.ok(nodeId, `missing popup control: ${selector}`);
    await send("DOM.scrollIntoViewIfNeeded", { nodeId });
    const point = await read(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)}), r = node.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, disabled: node.disabled, width: r.width, height: r.height, hit: Boolean(hit && (hit === node || node.contains(hit))), hitTag: hit?.tagName, hitId: hit?.id };
    })()`);
    assert.ok(!point.disabled && point.width && point.height, `unavailable popup control: ${selector}`);
    assert.ok(point.hit, `popup control obstructed: ${selector} ${JSON.stringify(point)}`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  };
  return { send, read, wait, click };
}

const channel = process.env.TABWISE_BROWSER || "chromium";
const artifacts = process.env.TABWISE_E2E_ARTIFACT_DIR || await mkdtemp(path.join(os.tmpdir(), "tabwise-action-check-"));
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "tabwise-action-profile-"));
const server = createServer((request, response) => {
  response.setHeader("content-type", "text/html;charset=utf-8");
  response.end(`<title>Popup fixture ${request.url.slice(1)}</title><main>Isolated popup fixture</main>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext(profile, { channel, headless: process.env.TABWISE_POPUP_HEADED !== "1", viewport: null,
  args: [`--disable-extensions-except=${path.resolve(".")}`, `--load-extension=${path.resolve(".")}`] });
let popup;
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`);
  await control.evaluate(async (base) => {
    await chrome.runtime.sendMessage({ type: "updateSettings", settings: { autoSuspend: true, idleMinutes: 10, resourceSamplingMode: "off" } });
    for (let index = 0; index < 24; index++) await chrome.tabs.create({ url: `${base}/${index}`, active: false });
  }, baseUrl);
  await control.bringToFront();
  await control.waitForFunction(async () => (await chrome.tabs.query({})).filter((tab) => tab.url?.startsWith("http://127.0.0.1:")).every((tab) => tab.status === "complete"));
  const cdp = await context.newCDPSession(control);
  const openPopup = async () => {
    await control.bringToFront();
    await control.evaluate(() => chrome.action.openPopup());
  };
  await openPopup();
  const target = (await cdp.send("Target.getTargets")).targetInfos.find((item) => item.url.endsWith("/src/popup/popup.html"));
  assert.ok(target, "the toolbar action must create its own popup target");
  const nativeContexts = await control.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["POPUP"] }));
  assert.equal(nativeContexts.length, 1);
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
  popup = popupSession(cdp, sessionId);
  await popup.wait('document.querySelectorAll("#tabs .row").length >= 24');
  const geometry = async () => popup.read(`(() => {
    const rect = selector => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x: r.x, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollWidth: document.documentElement.scrollWidth,
      brand: rect(".brand-lockup"), title: rect(".topbar h1"), actions: rect(".topbar-actions"),
      tabs: [...document.querySelectorAll(".surface-tabs button")].map(node => ({ height: node.getBoundingClientRect().height, text: node.textContent.trim() })) };
  })()`);
  const assertLayout = async () => {
    const result = await geometry();
    assert.equal(result.width, 410, "actual action popup must use its intrinsic 410px width");
    assert.ok(result.height <= 600 && result.height > 200, "actual action popup fits Chrome's height limit");
    assert.equal(result.scrollWidth, result.width, "no horizontal overflow in the toolbar popup");
    assert.ok(result.brand.right <= result.actions.x, "header brand and actions do not overlap");
    assert.ok(result.title.right <= result.actions.x, "title does not overflow into header actions");
    assert.ok(result.tabs.every((tab) => tab.height < 55), "navigation stays on one line");
    return result;
  };
  const baseline = await assertLayout();
  for (const colorScheme of ["light", "dark"]) {
    await popup.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: colorScheme }] });
    for (const view of ["tabs", "organize", "saved"]) {
      await popup.click(`[data-view-button="${view}"]`);
      await popup.wait(`document.querySelector('[data-view-button="${view}"]').getAttribute("aria-selected") === "true"`);
      await assertLayout();
      const shot = await popup.send("Page.captureScreenshot");
      await writeFile(path.join(artifacts, `actual-popup-${channel}-${view}-${colorScheme}.png`), Buffer.from(shot.data, "base64"));
    }
  }
  await popup.click('[data-view-button="tabs"]');
  await popup.click("#tab-search");
  await popup.send("Input.insertText", { text: "Popup fixture 7" });
  await popup.wait('document.querySelectorAll("#tabs .row").length === 1 && document.querySelector("#tabs").textContent.includes("Popup fixture 7")');
  await popup.click('[data-view-button="saved"]');
  await popup.click('[data-view-button="tabs"]');
  assert.equal(await popup.read('document.querySelector("#tab-search").value'), "Popup fixture 7");
  await popup.click('[data-filter="protected"]');
  assert.equal(await popup.read('document.querySelector(\'[data-filter="protected"]\').getAttribute("aria-pressed")'), "true");
  await popup.click('[data-view-button="organize"]');
  await popup.click("#suspend-eligible");
  await popup.wait('!document.querySelector("#batch-preview").hidden');
  const oldPreview = await control.evaluate(async () => (await chrome.storage.session.get("batchPreviews")).batchPreviews[0]);
  assert.equal(oldPreview.owner, nativeContexts[0].documentId, "preview belongs to the actual browser popup document");
  await popup.click("[data-batch=cancel]");
  await popup.wait('document.querySelector("#batch-preview").hidden');
  await popup.click("#open-palette");
  await popup.wait('document.querySelector(\'dialog[aria-labelledby="palette-heading"]\').open && document.querySelectorAll("#palette-results button").length > 0');
  await popup.click("#palette-input");
  await popup.send("Input.insertText", { text: "保存当前窗口为工作区" });
  await popup.wait('document.querySelector("#palette-results button")?.textContent === "保存当前窗口为工作区"');
  await popup.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await popup.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await popup.wait('!document.querySelector("#workspace-form").hidden && document.querySelector(\'[data-view-button="saved"]\').getAttribute("aria-selected") === "true"');
  await popup.click("#workspace-name");
  await popup.send("Input.insertText", { text: "Popup action workspace" });
  await popup.click("#workspace-form button[type=submit]");
  await popup.wait('document.querySelector(".workspace-list").textContent.includes("Popup action workspace")');
  const saved = await control.evaluate(() => chrome.runtime.sendMessage({ type: "getWorkspaces" }));
  assert.ok(saved.some((item) => item.name === "Popup action workspace" && item.tabs.length === 24));
  await assertLayout();
  // Closing and reopening must also retain the correct browser-computed width.
  await cdp.send("Target.closeTarget", { targetId: target.targetId });
  await control.bringToFront();
  await openPopup();
  const reopened = (await cdp.send("Target.getTargets")).targetInfos.find((item) => item.url.endsWith("/src/popup/popup.html"));
  assert.ok(reopened);
  assert.notEqual(reopened.targetId, target.targetId, "reopening creates a fresh action popup document");
  const attached = await cdp.send("Target.attachToTarget", { targetId: reopened.targetId, flatten: false });
  popup = popupSession(cdp, attached.sessionId);
  await popup.wait('document.querySelectorAll("#tabs .row").length >= 24');
  await assertLayout();
  const rejected = await popup.read(`chrome.runtime.sendMessage({ type: "startBatchPreview", previewId: ${JSON.stringify(oldPreview.id)}, tabIds: [] })`);
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /预览已过期或已执行/);
  await writeFile(path.join(artifacts, `actual-popup-${channel}-result.json`), JSON.stringify({
    channel, browser: await context.browser().version(), baseline,
    cases: ["intrinsic toolbar size", "header/nonwrapping navigation", "light/dark three views", "real pointer search/filter",
      "draft search retention", "batch preview/cancel", "keyboard palette route", "workspace save", "close/reopen"]
  }, null, 2));
  console.log(`Actual action popup PASS: ${channel} ${await context.browser().version()}, ${baseline.width}x${baseline.height}, DPR ${baseline.dpr}; real clicks/search/palette/save/reopen. Evidence: ${artifacts}`);
} catch (error) {
  console.error(`Actual popup failure evidence: ${artifacts}`);
  if (popup) {
    const shot = await popup.send("Page.captureScreenshot").catch(() => null);
    if (shot) await writeFile(path.join(artifacts, `actual-popup-${channel}-failure.png`), Buffer.from(shot.data, "base64"));
  }
  throw error;
} finally {
  await context.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
