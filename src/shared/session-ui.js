import { escapeHtml } from "./html.js";
import { createPageIndex } from "./search.js";
import { updateHTML } from "./live-ui.js";

export function createSessionUI(host, restoreUI, feedback, refresh) {
  const send = (message) => chrome.runtime.sendMessage(message);
  let history = [];
  let version = 0;
  let difference;
  const index = createPageIndex();
  host.innerHTML = `<details class="session-history"><summary>最近关闭 <span class="closed-count"></span></summary>
    <p class="saved-hint history-hint"></p><label>查找关闭的页面<input class="closed-search" type="search" placeholder="标题、拼音或网址"></label>
    <div class="closed-list"></div><button type="button" data-session="clear">清空最近关闭</button></details>
    <details class="session-compare"><summary>快照对比</summary>
    <p class="saved-hint">比较恢复点与当前会话或另一恢复点，选择找回缺失的页面。</p>
    <div class="compare-fields"><label>基准恢复点<select class="compare-before"></select></label>
    <label>对比目标<select class="compare-after"><option value="current">当前会话</option></select></label></div>
    <button type="button" data-session="compare">对比</button><div class="compare-result" role="status"></div></details>`;
  const drawHistory = () => {
    const query = host.querySelector(".closed-search").value.trim();
    const pages = query ? index.search(query, 100) : history;
    updateHTML(host.querySelector(".closed-list"), pages.map((page) => `<article class="saved-workspace">
      <strong>${escapeHtml(page.title || page.url)}</strong><small>${escapeHtml(page.url)} · ${new Date(page.closedAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
      <button type="button" data-session="open-closed" data-id="${escapeHtml(page.closedId || page.id)}">找回页面</button></article>`).join("")
      || `<p class="saved-hint">${query ? "没有匹配的关闭记录。" : "暂无关闭记录。"}</p>`);
  };
  host.querySelector(".closed-search").addEventListener("input", drawHistory);
  host.addEventListener("change", (event) => {
    if (event.target.matches("select")) {
      version++; difference = null; host.querySelector(".compare-result").textContent = "";
    }
  });
  host.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-session]");
    if (!button) return;
    button.disabled = true;
    try {
      const action = button.dataset.session;
      if (action === "open-closed") {
        const page = history.find((item) => item.id === button.dataset.id);
        if (!page) throw new Error("关闭记录已失效，请刷新。");
        const result = await send({ type: "openSearchResult", result: { source: "closed", closedId: page.id, url: page.url } });
        if (!result?.ok) throw new Error(result?.reason || "找回失败。");
        feedback("已找回页面"); await refresh();
      } else if (action === "clear") {
        await send({ type: "clearClosedPages" }); feedback("已清空最近关闭"); await refresh();
      } else if (action === "compare") {
        const current = ++version;
        const result = await send({ type: "compareCheckpoint", beforeId: host.querySelector(".compare-before").value, afterId: host.querySelector(".compare-after").value });
        if (current !== version) return;
        if (!result?.ok) throw new Error(result?.reason || "对比失败。");
        difference = result;
        const list = (pages, removed) => pages.map((page) => `<label class="saved-member">${removed ? `<input type="checkbox" value="${page.index}" checked>` : ""}
          <span><strong>${escapeHtml(page.title || page.url)}</strong><small>${escapeHtml(page.url)}</small></span></label>`).join("");
        host.querySelector(".compare-result").innerHTML = `<p>新增 ${result.added.length} 页 · 缺失 ${result.removed.length} 页 · 布局或休眠变化 ${result.changed.length} 页</p>
          <p class="saved-hint">对比于 ${new Date().toLocaleTimeString()}。找回前会再次检查快照和已打开页面。</p>
          <details open><summary>缺失页面 (${result.removed.length})</summary><div class="diff-removed saved-members">${list(result.removed, true) || "没有缺失页面。"}</div></details>
          <details><summary>新增页面 (${result.added.length})</summary>${list(result.added)}</details>
          <details><summary>变化页面 (${result.changed.length})</summary>${list(result.changed)}</details>
          ${result.removed.length ? '<button type="button" data-session="restore-missing">预览找回所选缺失页</button>' : ""}`;
      } else if (action === "restore-missing" && difference) {
        const indices = [...host.querySelectorAll(".diff-removed input:checked")].map((input) => Number(input.value));
        if (!indices.length) throw new Error("请至少选择一个缺失页面。");
        await restoreUI.open("checkpoint", difference.beforeId, { indices, signature: difference.signature });
      }
    } catch (error) { feedback(error.message, true); }
    finally { button.disabled = false; }
  });
  return {
    setData(checkpoints, closed, settings) {
      history = closed;
      index.replace(closed.map((page) => ({ ...page, closedId: page.id, source: "closed" })));
      host.querySelector(".closed-count").textContent = `(${closed.length})`;
      host.querySelector(".history-hint").textContent = settings.closedHistoryEnabled
        ? `本地保留 ${settings.closedHistoryDays} 天、最多 100 页，仅含标题与网址；无痕页面不记录。`
        : "最近关闭记录已停用，可在设置中开启。";
      drawHistory();
      const options = checkpoints.map((item) => `<option value="${escapeHtml(item.id)}">${new Date(item.createdAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${item.tabs.length} 页</option>`).join("");
      for (const selector of [".compare-before", ".compare-after"]) {
        const select = host.querySelector(selector);
        const value = select.value;
        updateHTML(select, (selector.endsWith("after") ? '<option value="current">当前会话</option>' : "") + options);
        if ([...select.options].some((item) => item.value === value)) select.value = value;
        else if (value) {
          version++; difference = null;
          host.querySelector(".compare-result").textContent = "恢复点已移除，请重新对比。";
        }
      }
      host.querySelector("[data-session=compare]").disabled = !checkpoints.length;
      host.querySelector("[data-session=clear]").disabled = !closed.length;
    }
  };
}
