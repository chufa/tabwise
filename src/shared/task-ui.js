import { escapeHtml } from "./html.js";
import { updateHTML } from "./live-ui.js";

export const restoreStatus = { queued: "排队中", running: "恢复中", stopping: "正在停止", stopped: "已停止", completed: "已完成", interrupted: "已中断" };
export const pageStatus = (page) => ({ pending: "等待恢复", opening: "正在打开", opened: "已打开", loading: "仍在加载", skipped: "已跳过", failed: "失败", closed: "已关闭", uncertain: "需要重新检查" }[page.status] || page.status) + (page.reason ? ` · ${page.reason}` : "");
export const taskCounts = (task) => `已打开 ${task.count} 页 · 跳过 ${task.skipped} 页 · 失败 ${task.failed} 页`;

export function createTaskUI(host, feedback, refresh) {
  let selected;
  let offset = 0;
  let revision = 0;
  host.innerHTML = `<details open><summary>恢复任务中心</summary><p class="saved-hint">关闭界面后继续恢复。停止后当前批次会完成；中断任务需手动重试。保留本次浏览器会话最近 10 项。</p><div class="task-list"></div><div class="task-detail" hidden></div></details>`;
  async function update() {
    const version = ++revision;
    const tasks = await chrome.runtime.sendMessage({ type: "getRestoreTasks" });
    if (version !== revision || !Array.isArray(tasks)) return;
    updateHTML(host.querySelector(".task-list"), tasks.map((task) => `<article class="saved-workspace" data-task-id="${escapeHtml(task.id)}">
      <strong>${escapeHtml(task.name)} · ${restoreStatus[task.status]}</strong><small>${task.settled} / ${task.total} 页已处理 · ${taskCounts(task)}</small>
      ${task.reason ? `<p>${escapeHtml(task.reason)}</p>` : ""}
      <div class="saved-actions"><button type="button" data-task="details">查看详情</button>
      ${["queued", "running"].includes(task.status) ? '<button type="button" data-task="stop">停止后续批次</button>' : ""}
      ${task.retryable ? '<button type="button" data-task="retry">重试未完成页面</button>' : ""}</div></article>`).join("") || '<p class="saved-hint">暂无恢复任务。</p>');
    if (!selected) return;
    const task = await chrome.runtime.sendMessage({ type: "getRestoreTask", taskId: selected, offset });
    if (version !== revision) return;
    const detail = host.querySelector(".task-detail");
    detail.hidden = false;
    updateHTML(detail, task.ok ? `<h3>逐页结果 · ${restoreStatus[task.status]}</h3><ul>${task.results.map((page) => `<li>${escapeHtml(page.title || `页面 ${page.index + 1}`)}：${escapeHtml(pageStatus(page))}</li>`).join("")}</ul>
      <div class="saved-actions"><button type="button" data-task="prev" ${offset ? "" : "disabled"}>上一页</button><span>${Math.floor(offset / 50) + 1} / ${Math.max(1, Math.ceil(task.total / 50))}</span><button type="button" data-task="next" ${offset + 50 >= task.total ? "disabled" : ""}>下一页</button><button type="button" data-task="close">关闭详情</button></div>` : `<p>${escapeHtml(task.reason)}</p>`);
  }
  host.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-task]");
    if (!button) return;
    const id = button.closest("[data-task-id]")?.dataset.taskId;
    button.disabled = true;
    try {
      const action = button.dataset.task;
      if (action === "details") { selected = id; offset = 0; }
      else if (action === "prev") offset = Math.max(0, offset - 50);
      else if (action === "next") offset += 50;
      else if (action === "close") { selected = null; host.querySelector(".task-detail").hidden = true; }
      else {
        const result = await chrome.runtime.sendMessage({ type: action === "stop" ? "stopRestoreTask" : "retryRestoreTask", taskId: id });
        if (!result.ok) throw new Error(result.reason);
        feedback(action === "stop" ? "已请求停止后续批次" : "已创建重试任务");
        if (result.taskId) { selected = result.taskId; offset = 0; }
      }
      await update();
      await refresh();
    } catch (error) { feedback(error.message, true); }
    finally { button.disabled = false; }
  });
  return { update };
}
