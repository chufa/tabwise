import { escapeHtml } from "./html.js";
import { updateHTML } from "./live-ui.js";

const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
export function createBudgetUI(host, feedback, refresh) {
  let preview;
  let busy = false;
  host.innerHTML = '<div class="budget-summary"></div><div class="budget-preview" hidden></div>';
  function update(budget) {
    if (!budget) return;
    updateHTML(host.querySelector(".budget-summary"), budget.enabled ? `<h2>资源预算</h2>
      <p>已加载网页 ${budget.openPages} / ${budget.tabLimit} · 已采样 JS 堆 ${mb(budget.heapBytes)} / ${mb(budget.heapLimitBytes)}</p>
      <p class="saved-hint">最近 5 分钟采样覆盖 ${budget.measuredPages} / ${budget.openPages} 页${budget.updatedAt ? ` · 最早采样 ${new Date(budget.updatedAt).toLocaleTimeString()}` : ""}。JS 堆不代表物理内存。</p>
      <p>${budget.overTabs || budget.overHeapBytes ? `超出 ${budget.overTabs} 页 · ${mb(budget.overHeapBytes)}。安全候选 ${budget.candidates.length} 页。` : "当前采样在预算范围内。"}</p>
      ${budget.growth.length ? `<details><summary>${budget.growth.length} 页持续增长</summary><ul>${budget.growth.slice(0, 20).map((page) => `<li>${escapeHtml(page.title)} · 增长 ${mb(page.growthBytes)}</li>`).join("")}</ul><p class="saved-hint">这是采样趋势提示，尚不能判断是否存在内存泄漏。</p></details>` : ""}
      ${budget.candidates.length ? '<button type="button" data-budget="preview">预览预算回收</button>' : budget.overTabs || budget.overHeapBytes ? '<p class="saved-hint">暂无安全候选，请检查智能保护模式和闲置时长。</p>' : ""}` :
      '<details><summary>资源预算未启用</summary><p class="saved-hint">在设置中开启网页数量和 JS 堆预算提醒。</p></details>');
  }
  host.addEventListener("change", () => {
    const button = host.querySelector("[data-budget=confirm]");
    if (button) button.disabled = busy || !host.querySelector(".budget-preview input:checked");
  });
  host.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-budget]");
    if (!button || busy) return;
    const pane = host.querySelector(".budget-preview");
    if (button.dataset.budget === "cancel") { preview = null; pane.hidden = true; return; }
    busy = true;
    button.disabled = true;
    try {
      if (button.dataset.budget === "preview") {
        preview = await chrome.runtime.sendMessage({ type: "prepareBudgetReclaim" });
        if (!preview.ok) throw new Error(preview.reason);
        pane.innerHTML = `<h3>选择回收页面</h3><p class="saved-hint">确认时再次检查网址、活动和网页保护状态。每次最多 50 页。</p>
          <fieldset class="saved-members"><legend>预算回收候选</legend>${preview.pages.map((page) => `<label class="saved-member"><input type="checkbox" value="${page.tabId}" checked><span><strong>${escapeHtml(page.title)}</strong><small>${page.heapBytes ? `已采样 JS 堆 ${mb(page.heapBytes)}` : "无新鲜采样"} · ${escapeHtml(page.url)}</small></span></label>`).join("")}</fieldset>
          <div class="saved-actions"><button type="button" data-budget="confirm" ${preview.pages.length ? "" : "disabled"}>确认休眠所选页面</button><button type="button" data-budget="cancel">取消</button></div><div class="budget-result" role="status"></div>`;
        pane.hidden = false;
      } else if (preview) {
        const tabIds = [...pane.querySelectorAll("input:checked")].map((input) => Number(input.value));
        pane.querySelectorAll("input, button").forEach((input) => { input.disabled = true; });
        const result = await chrome.runtime.sendMessage({ type: "confirmBudgetReclaim", previewId: preview.previewId, tabIds });
        if (!result.ok) throw new Error(result.reason);
        preview = null;
        pane.querySelector(".budget-result").innerHTML = `<p>已休眠 ${result.count} 页 · 跳过 ${result.results.length - result.count} 页</p><ul>${result.results.map((page) => `<li>${escapeHtml(page.title)}：${escapeHtml(page.ok ? "已休眠" : page.reason)}</li>`).join("")}</ul>`;
        feedback(`预算回收完成，已休眠 ${result.count} 页`);
        await refresh();
      }
    } catch (error) {
      if (pane.querySelector(".budget-result")) pane.querySelector(".budget-result").textContent = error.message;
      feedback(error.message, true);
    } finally {
      busy = false; button.disabled = false;
      const close = pane.querySelector("[data-budget=cancel]");
      if (close) { close.disabled = false; close.textContent = "关闭"; }
    }
  });
  return { update };
}
