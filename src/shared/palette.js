import { escapeHtml, highlightMatch } from "./html.js";
import { updateHTML } from "./live-ui.js";

export function filterCommands(commands, query, limit = 12) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter((command) => tokens.every((token) => `${command.label} ${command.keywords || ""}`.toLowerCase().includes(token))).slice(0, limit);
}

export function createPalette({ feedback, refresh, restoreUI, batchUI, getDashboard, saveButton }) {
  const send = (message) => chrome.runtime.sendMessage(message);
  const dialog = document.createElement("dialog");
  dialog.className = "command-palette saved-tools";
  dialog.setAttribute("aria-labelledby", "palette-heading");
  dialog.innerHTML = `<div class="saved-actions"><h2 id="palette-heading">命令面板</h2><button type="button" data-palette-close aria-label="关闭命令面板">关闭</button></div>
    <label>搜索命令或页面<input id="palette-input" type="search" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="palette-results" autocomplete="off" placeholder="保存、恢复、分组或页面关键词"></label>
    <p class="saved-hint">↑ ↓ 选择 · Enter 执行 · Esc 关闭 · ⌘ / Ctrl K 打开</p><div id="palette-results" role="listbox" aria-label="可用命令"></div><p class="palette-status" role="status"></p>`;
  document.body.append(dialog);
  const input = dialog.querySelector("input"), output = dialog.querySelector("#palette-results"), status = dialog.querySelector(".palette-status");
  let commands = [], visible = [], active = 0, generation = 0, request = 0, timer, returnFocus, restoreFocus = true;
  function draw() {
    updateHTML(output, visible.map((item, index) => `<button type="button" role="option" id="palette-option-${index}" data-key="${escapeHtml(item.id)}" data-command="${index}" tabindex="-1" aria-selected="${index === active}"><strong>${highlightMatch(item.label, input.value)}</strong>${item.detail ? `<small>${highlightMatch(item.detail, input.value)}</small>` : ""}</button>`).join("") || "<p>没有匹配的命令或页面。</p>");
    if (visible.length) input.setAttribute("aria-activedescendant", `palette-option-${active}`); else input.removeAttribute("aria-activedescendant");
  }
  async function update() {
    const current = ++request, epoch = generation, query = input.value;
    visible = filterCommands(commands, query); active = 0; draw();
    if (query.trim().length < 2) { status.textContent = ""; return; }
    status.textContent = "正在查找本地页面…";
    try {
      const pages = await send({ type: "searchPages", query, limit: 8, deduplicate: true });
      if (epoch !== generation || current !== request || !dialog.open) return;
      if (!Array.isArray(pages)) throw new Error(pages.reason || "页面搜索失败。");
      visible = [...filterCommands(commands, query), ...pages.map((page) => ({
        id: `page:${page.id}`, label: `打开 · ${page.title}`, detail: page.domain || page.url, run: () => send({ type: "openSearchResult", result: page })
      }))].slice(0, 20);
      active = 0; draw(); status.textContent = `${visible.length} 项结果`;
    } catch (error) { if (epoch === generation && current === request) status.textContent = error.message; }
  }
  async function execute(index) {
    const command = visible[index];
    if (!command) return;
    restoreFocus = false; dialog.close();
    try {
      const result = await command.run();
      if (result && result.ok === false) throw new Error(result.reason || "操作未完成。");
      if (result?.ok) feedback("操作已完成");
      await refresh();
    } catch (error) { feedback(error.message, true); }
  }
  function close() {
    // Native close events are queued; a quick reopen must keep its new request.
    if (dialog.open) return;
    generation++; request++; clearTimeout(timer);
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  dialog.addEventListener("close", close);
  dialog.querySelector("[data-palette-close]").addEventListener("click", () => dialog.close());
  input.addEventListener("input", () => { request++; clearTimeout(timer); timer = setTimeout(update, 120); });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); active = visible.length ? (active + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length : 0;
      draw(); output.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && event.target === input) { event.preventDefault(); execute(active); }
  });
  output.addEventListener("click", (event) => { const button = event.target.closest("[data-command]"); if (button) execute(Number(button.dataset.command)); });
  async function open() {
    if (dialog.open) return;
    returnFocus = document.activeElement;
    restoreFocus = true;
    const epoch = ++generation;
    commands = []; visible = []; active = 0; input.value = ""; status.textContent = "正在读取命令…"; draw();
    dialog.showModal(); input.focus();
    try {
      const [workspaces, operations] = await Promise.all([send({ type: "getWorkspaces" }), send({ type: "getOperations" })]);
      if (epoch !== generation || !dialog.open) return;
      if (!Array.isArray(workspaces) || !Array.isArray(operations)) throw new Error("命令读取失败，请重试。");
      const dashboard = getDashboard();
      const undo = operations.find((entry) => entry.status === "ready");
      commands = [
        { id: "checkpoint", label: "保存恢复点", keywords: "checkpoint save", run: () => send({ type: "createRecoveryCheckpoint" }) },
        { id: "workspace", label: "保存当前窗口为工作区", keywords: "workspace save", run: () => { saveButton.click(); } },
        { id: "suspend", label: "批量休眠预览", keywords: "suspend batch", run: () => batchUI.open() },
        { id: "budget", label: "预算回收预览", keywords: "memory budget", run: () => {
          const button = document.querySelector("[data-budget=preview]");
          if (!button) throw new Error("请开启资源预算并等待安全候选出现。");
          button.click(); button.scrollIntoView({ block: "nearest" });
        } },
        ...(undo ? [{ id: "undo", label: "撤销最近操作", detail: undo.label.split(" · ").slice(0, 2).join(" · "), keywords: "undo", run: () => send({ type: "undoOperation", operationId: undo.id }) }] : []),
        { id: "settings", label: "打开设置", keywords: "settings", run: () => chrome.runtime.openOptionsPage() },
        ...[...workspaces].sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite))).map((workspace) => ({ id: `workspace:${workspace.id}`, label: `${workspace.favorite ? "★ " : ""}恢复工作区 · ${workspace.name}`, detail: `${workspace.tabs.length} 页`, keywords: `restore ${(workspace.tags || []).join(" ")}`, run: () => restoreUI.open("workspace", workspace.id) })),
        ...(dashboard?.organization.domainGroups || []).slice(0, 12).map((group) => ({ id: `group:${group.domain}`, label: `分组预览 · ${group.domain}`, detail: `${group.tabIds.length} 页`, keywords: "group batch", run: () => batchUI.open("group", { title: group.domain, tabIds: group.tabIds }) }))
      ];
      status.textContent = ""; await update();
    } catch (error) { if (epoch === generation) status.textContent = error.message; }
  }
  document.querySelector("#open-palette").addEventListener("click", open);
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault(); if (dialog.open) dialog.close(); else open();
    }
  });
  return { open };
}
