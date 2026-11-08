import { createPagedList } from "./paged-ui.js";

export function createBatchUI(feedback, refresh) {
  const host = document.createElement("section");
  host.className = "saved-tools restore-preview";
  host.setAttribute("aria-label", "批量操作预览");
  host.id = "batch-preview"; host.hidden = true;
  // A preview must stay visible regardless of the selected workbench destination.
  document.querySelector("#restore-preview").after(host);
  let preview, members, revision = 0;
  host.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-batch]");
    if (!button) return;
    if (button.dataset.batch === "cancel") { revision++; preview = null; host.hidden = true; return; }
    const current = revision, selected = members.values();
    button.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "startBatchPreview", previewId: preview.previewId, tabIds: selected });
      if (current !== revision) return;
      if (!result.ok) throw new Error(result.reason);
      preview = null; host.hidden = true;
      feedback("批量任务已创建，可在统一任务中心查看进度");
      await refresh();
    } catch (error) { feedback(error.message, true); }
    finally { button.disabled = false; }
  });
  return {
    async open(kind = "suspend", options = {}) {
      const current = ++revision;
      const result = await chrome.runtime.sendMessage({ type: "prepareBatch", kind, ...options });
      if (current !== revision) return;
      if (!result.ok) throw new Error(result.reason);
      preview = result;
      host.innerHTML = `<h2>${kind === "group" ? "分组" : "休眠"}预览</h2><p>请选择页面；确认时重新检查网址、活动与保护状态。分组按窗口逐个执行，同一窗口至少选择两页；休眠每批最多 5 页。</p>
        <div class="batch-members"></div><div class="saved-actions"><button type="button" data-batch="confirm" ${result.pages.length ? "" : "disabled"}>确认执行所选页面</button><button type="button" data-batch="cancel">取消</button></div>`;
      members = createPagedList(host.querySelector(".batch-members"), { key: (page) => page.tabId, selected: true, onChange: (values) => { host.querySelector("[data-batch=confirm]").disabled = !values.length; } });
      members.setData(result.pages);
      host.hidden = false; host.scrollIntoView({ block: "nearest" });
      host.querySelector("[data-batch=cancel]").focus({ preventScroll: true });
    }
  };
}
