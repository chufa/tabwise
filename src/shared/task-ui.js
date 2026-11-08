import { escapeHtml } from "./html.js";
import { updateHTML } from "./live-ui.js";

export const restoreStatus = { queued: "排队中", running: "执行中", stopping: "正在停止", stopped: "已停止", completed: "已完成", interrupted: "已中断" };
export const pageStatus = (page) => (page.onDemand && ["opened", "loading"].includes(page.status) ? "休眠页已建立，点击再加载" : { pending: "等待处理", executing: "正在执行", succeeded: "已完成", opening: "正在打开", opened: "已打开", loading: "仍在加载", skipped: "已跳过", failed: "失败", closed: "已关闭", uncertain: "需要重新检查" }[page.status] || page.status) + (page.reason ? ` · ${page.reason}` : "");
export const taskCounts = (task) => `${["suspend", "group", "budget"].includes(task.kind) ? "已完成" : "已打开"} ${task.count} 页 · 跳过 ${task.skipped} 页 · 失败 ${task.failed} 页`;

export function createTaskUI(host, feedback, refresh) {
  let selected;
  let offset = 0;
  let revision = 0;
  host.innerHTML = `<details open><summary>统一任务中心</summary><p class="saved-hint">查看恢复与批量操作的进度，处理完可归档。</p><details class="task-guide"><summary>记录保留与续跑说明</summary><p class="saved-hint">恢复与批量任务各保留本地最近 10 项，浏览器重启仍可查看。旧会话批量任务只保留摘要，需重新预览当前页面。停止后当前批次会完成，不确定项需检查。</p></details><label><input type="checkbox" class="show-archived-tasks">显示已归档任务</label><div class="task-list"></div><div class="task-detail" hidden></div></details>`;
  host.querySelector(".show-archived-tasks").addEventListener("change", () => update().catch((error) => feedback(error.message, true)));
  async function update() {
    const version = ++revision;
    const tasks = await chrome.runtime.sendMessage({ type: "getTasks", includeArchived: host.querySelector(".show-archived-tasks").checked });
    if (version !== revision || !Array.isArray(tasks)) return;
    updateHTML(host.querySelector(".task-list"), tasks.map((task) => `<article class="saved-workspace" data-task-id="${escapeHtml(task.id)}" data-task-type="${escapeHtml(task.taskType)}">
      <strong>${escapeHtml(task.name)} · ${restoreStatus[task.status]}</strong><small>${task.settled} / ${task.total} 页已处理 · ${taskCounts(task)}</small>
      ${task.reason ? `<p>${escapeHtml(task.reason)}</p>` : ""}
      ${task.resolvedBy ? `<p>此任务已转入后续任务。</p>${tasks.some((item) => item.id === task.resolvedBy) ? `<button type="button" data-task="successor" data-successor="${escapeHtml(task.resolvedBy)}">查看后续任务</button>` : ""}` : ""}
      <div class="saved-actions"><button type="button" data-task="details">查看详情</button>
      ${["queued", "running"].includes(task.status) ? '<button type="button" data-task="stop">停止后续批次</button>' : ""}
      ${task.resumable ? '<button type="button" data-task="resume">继续未完成页面</button>' : ""}
      ${task.retryable ? '<button type="button" data-task="retry">重试未完成页面</button>' : ""}
      ${!["queued", "running", "stopping"].includes(task.status) && !task.archivedAt ? '<button type="button" data-task="archive">归档任务</button>' : ""}
      ${task.archivedAt ? '<span>已归档</span>' : ""}</div></article>`).join("") || '<p class="saved-hint">暂无任务。</p>');
    if (!selected) return;
    const task = await chrome.runtime.sendMessage({ type: "getTask", taskId: selected.id, taskType: selected.taskType, offset });
    if (version !== revision) return;
    const detail = host.querySelector(".task-detail");
    detail.hidden = false;
    const audit = (task.audit || []).slice(-4).map((event) => `<li>${escapeHtml(event.type)} · ${new Date(event.at).toLocaleTimeString()}</li>`).join("");
    updateHTML(detail, task.ok ? `<h3>逐项结果 · ${restoreStatus[task.status]}</h3><ul>${task.results.map((page) => `<li>${escapeHtml(page.title || `页面 ${page.index + 1}`)}${page.size ? ` · ${page.size} 页` : ""}：${escapeHtml(pageStatus(page))}</li>`).join("")}</ul>
      ${audit ? `<details><summary>恢复事务记录</summary><ul>${audit}</ul></details>` : ""}
      <div class="saved-actions"><button type="button" data-task="prev" ${offset ? "" : "disabled"}>上一页</button><span>${Math.floor(offset / 50) + 1} / ${Math.max(1, Math.ceil((task.itemTotal ?? task.total) / 50))}</span><button type="button" data-task="next" ${offset + 50 >= (task.itemTotal ?? task.total) ? "disabled" : ""}>下一页</button><button type="button" data-task="close">关闭详情</button></div>` : `<p>${escapeHtml(task.reason)}</p>`);
  }
  host.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-task]");
    if (!button) return;
    const taskElement = button.closest("[data-task-id]");
    const id = taskElement?.dataset.taskId;
    const taskType = taskElement?.dataset.taskType;
    button.disabled = true;
    try {
      const action = button.dataset.task;
      if (action === "details") { selected = { id, taskType }; offset = 0; }
      else if (action === "successor") { selected = { id: button.dataset.successor, taskType }; offset = 0; }
      else if (action === "prev") offset = Math.max(0, offset - 50);
      else if (action === "next") offset += 50;
      else if (action === "close") { selected = null; host.querySelector(".task-detail").hidden = true; }
      else {
        const type = action === "stop" ? "stopTask" : action === "resume" ? "resumeRestoreTask" : action === "archive" ? "archiveTask" : "retryTask";
        const result = await chrome.runtime.sendMessage({ type, taskId: id, taskType });
        if (!result.ok) throw new Error(result.reason);
        feedback(action === "stop" ? "已请求停止后续批次" : action === "resume" ? "已创建续跑任务" : action === "archive" ? "任务已归档" : "已创建重试任务");
        if (action === "archive") { selected = null; host.querySelector(".task-detail").hidden = true; }
        if (result.taskId) { selected = { id: result.taskId, taskType }; offset = 0; }
      }
      await update();
      await refresh();
    } catch (error) { feedback(error.message, true); }
    finally { button.disabled = false; }
  });
  return { update };
}
