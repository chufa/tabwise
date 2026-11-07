import { escapeHtml } from "./html.js";
import { createPagedList } from "./paged-ui.js";

export function createOrganizationUI(feedback, refresh) {
  const dialog = document.createElement("dialog");
  dialog.className = "command-palette saved-tools";
  document.body.append(dialog);
  let preview, list, generation = 0;
  const send = (message) => chrome.runtime.sendMessage(message);
  dialog.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-organize]");
    if (!button) return;
    if (button.dataset.organize === "cancel") { dialog.close(); return; }
    const indices = list.values();
    if (!indices.length) { feedback("请至少选择一页", true); return; }
    button.disabled = true;
    const current = generation, request = preview;
    try {
      if (request.kind === "links") {
        const origins = [...new Set(indices.map((index) => { const url = new URL(request.pages[index].url); return `${url.protocol}//${url.hostname}/*`; }))];
        if (!await chrome.permissions.request({ origins })) throw new Error("未授予所选网站权限。");
      }
      if (current !== generation) return;
      const result = await send({ type: request.kind === "links" ? "checkWorkspaceLinks" : "consolidateDuplicates",
        previewId: request.id, indices, confirm: true });
      if (current !== generation) return;
      if (!result.ok) throw new Error(result.reason);
      dialog.querySelector(".organization-result").textContent = result.results.map((item) =>
        `${item.title || `页面 ${item.index + 1}`}：${item.label || item.reason || (item.status === "closed" ? "已关闭重复页" : item.status)}`).join("\n");
      button.hidden = true;
      feedback(request.kind === "links" ? "链接检测完成" : `已关闭 ${result.count} 个重复页`);
      await refresh();
    } catch (error) { if (current === generation) dialog.querySelector(".organization-result").textContent = error.message; }
    finally { button.disabled = false; }
  });
  async function open(type, payload) {
    const current = ++generation;
    const result = await send({ type, ...payload });
    if (current !== generation) return;
    if (!result.ok) throw new Error(result.reason);
    preview = result;
    list?.destroy();
    const links = result.kind === "links";
    dialog.innerHTML = `<h2>${links ? "检测保存的链接" : "合并重复标签页"}</h2>
      <p>${links ? "选择后点击检测，将向所选网站发送不含登录凭据的 HEAD 请求，最多 50 页。不打开网页；网络异常或需登录不会标为失效。" : "仅列出当前窗口可安全关闭的完全相同网址，每组保留一页。确认前会重新检查页面活动与保护状态。"}</p>
      <div class="organization-pages"></div><div class="saved-actions"><button type="button" data-organize="apply">${links ? "检测所选链接" : "确认关闭所选重复页"}</button><button type="button" data-organize="cancel">关闭</button></div>
      <pre class="organization-result" role="status"></pre>`;
    list = createPagedList(dialog.querySelector(".organization-pages"), { selected: !links, limit: links ? 50 : Infinity,
      render: (page) => `<span><strong>${escapeHtml(page.title || page.url)}</strong><small>${escapeHtml(page.url)}${links ? "" : ` · 保留标签 ${page.keepTabId}`}</small></span>` });
    list.setData(result.pages);
    dialog.showModal();
  }
  return { duplicates: (payload = {}) => open("prepareDuplicateConsolidation", payload),
    links: (workspaceId) => open("prepareWorkspaceLinkCheck", { workspaceId }) };
}
