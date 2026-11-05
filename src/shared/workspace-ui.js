import { escapeHtml } from "./html.js";
import { sourceState } from "./restoration.js";
import { updateHTML } from "./live-ui.js";
import { pageStatus, taskCounts, restoreStatus } from "./task-ui.js";
import { createPagedList } from "./paged-ui.js";

const send = (message) => chrome.runtime.sendMessage(message);
const memberBody = (page) => `<span><strong>${escapeHtml(page.title || page.url)}</strong>
  <small>${escapeHtml(page.url)} · 窗口 ${(page.windowKey ?? 0) + 1}${page.pinned ? " · 固定" : ""}${page.status === "suspended" ? " · 休眠" : ""}${page.existing ? " · 已打开（将跳过）" : ""}</small></span>`;

export function createRestoreUI(host, feedback, refresh) {
  let preview;
  let taskId;
  let version = 0;
  let members;
  const count = () => {
    if (!preview) return;
    const selected = members.values();
    host.querySelector("[data-restore=confirm]").disabled = selected.length === 0;
    host.querySelector(".selection-count").textContent = `已选 ${selected.length} / ${preview.pages.length} 页`;
  };
  host.addEventListener("change", count);
  host.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-restore]");
    if (!button) return;
    const action = button.dataset.restore;
    if (action === "cancel") { version++; preview = null; host.hidden = true; return; }
    if (action === "all" || action === "none") {
      members.selectAll(action === "all");
      count();
      return;
    }
    if (action !== "confirm" || !preview) return;
    const current = version;
    const indices = members.values();
    const skipExisting = host.querySelector(".skip-existing").checked;
    const restoreLayout = host.querySelector(".restore-layout")?.checked || false;
    host.querySelectorAll("button, input").forEach((input) => { input.disabled = true; });
    host.querySelector(".restore-result").textContent = "正在分批恢复所选页面…";
    try {
      const result = await send({ type: "startRestore", previewId: preview.previewId, indices, skipExisting, restoreLayout });
      if (version !== current) return;
      if (!result?.ok) throw new Error(result?.reason || "恢复未完成，请重新预览。");
      preview = null;
      taskId = result.taskId;
      host.querySelector(".restore-result").textContent = "恢复任务已创建，可在任务中心查看进度或停止。";
      feedback("恢复任务已创建");
      await refresh();
    } catch (error) {
      if (version === current) {
        host.querySelector(".restore-result").textContent = error.message;
        feedback(error.message, true);
      }
    } finally {
      if (version === current) {
        host.querySelector("[data-restore=cancel]").disabled = false;
        host.querySelector("[data-restore=cancel]").textContent = "关闭预览";
      }
    }
  });
  return {
    async update() {
      if (!taskId || host.hidden) return;
      const id = taskId, current = version;
      const task = await send({ type: "getRestoreTask", taskId: id });
      if (id !== taskId || current !== version || !task.ok) return;
      updateHTML(host.querySelector(".restore-result"), `<p>${restoreStatus[task.status]}</p><p>${taskCounts(task)}</p>
        <ul>${task.results.map((item) => `<li>${escapeHtml(item.title || `页面 ${item.index + 1}`)}：${escapeHtml(pageStatus(item))}</li>`).join("")}</ul>
        ${task.total > 50 ? '<p>完整结果可在任务中心分页查看。</p>' : ""}
        ${task.layoutErrors?.length ? `<p>布局未完全恢复：${escapeHtml(task.layoutErrors.join("；"))}</p>` : ""}`);
    },
    async open(kind, sourceId, options = {}) {
      taskId = null;
      const current = ++version;
      const result = await send({ type: "prepareRestore", kind, sourceId, signature: options.signature });
      if (current !== version) return;
      if (!result?.ok) throw new Error(result?.reason || "无法读取恢复预览。");
      preview = result;
      const alreadyOpen = result.pages.filter((page) => page.existing).length;
      const suspended = result.pages.filter((page) => page.status === "suspended").length;
      host.innerHTML = `<h2>选择恢复 · ${escapeHtml(result.name)}</h2>
        <p class="saved-hint">已选页面会分批恢复，每批最多 5 页；当前标签保持打开。</p>
        <p class="saved-hint">共 ${result.pages.length} 页${alreadyOpen ? ` · ${alreadyOpen} 页已打开，默认跳过` : ""}${suspended ? ` · ${suspended} 页将保持休眠` : ""}${result.hasLayout ? ` · 目标 ${result.windowCount} 个窗口` : ""}。</p>
        <div class="saved-actions"><button type="button" data-restore="all">全选</button><button type="button" data-restore="none">全不选</button><span class="selection-count"></span></div>
        <fieldset class="saved-members"><legend>要恢复的页面</legend><div class="restore-page-list"></div></fieldset>
        <label class="saved-switch"><input class="skip-existing" type="checkbox" checked>跳过已打开的页面（所有窗口）</label>
        ${result.hasLayout ? `<label class="saved-switch"><input class="restore-layout" type="checkbox" checked>新建窗口恢复布局（仅新打开的页面）</label>
        <p class="saved-hint">快照含 ${result.windowCount} 个窗口、固定页和标签组。休眠页保持休眠；取消布局恢复后，网页会在当前窗口加载。</p>` : ""}
        <div class="saved-actions"><button type="button" data-restore="confirm">恢复所选页面</button><button type="button" data-restore="cancel">取消</button></div>
        <div class="restore-result" role="status"></div>`;
      host.hidden = false;
      members = createPagedList(host.querySelector(".restore-page-list"), { selected: true, render: memberBody, onChange: count });
      members.setData(result.pages.map((page, index) => ({ ...page, index })));
      if (options.indices) members.setValues(options.indices);
      count();
      host.scrollIntoView({ block: "nearest", behavior: "instant" });
      host.querySelector("[data-restore=all]").focus({ preventScroll: true });
    }
  };
}

export function createWorkspaceUI(host, restoreUI, feedback, refresh) {
  let workspaces = [];
  let trash = [];
  let filter = "";
  let busy = 0;
  let bindings = {};
  let editorMembers;
  const selected = new Set();
  host.innerHTML = `<div class="workspace-list"></div>
    <form class="merge-workspaces" hidden><label>合并后的名称<input name="merge-name" maxlength="80" required placeholder="新工作区名称"></label>
    <p class="saved-hint">合并所选工作区；布局快照保留窗口和重复页面，原工作区保留。</p><button type="submit">合并所选工作区</button></form>
    <div class="workspace-editor" hidden></div>
    <details class="workspace-trash"><summary>回收站 <span></span></summary><p class="saved-hint">仅移除保存的快照，网页标签保持打开。最多保留 20 个，可手动恢复。</p><div class="trash-list"></div></details>`;
  const draw = () => {
    if (busy) return;
    for (const id of selected) if (!workspaces.some((item) => item.id === id)) selected.delete(id);
    const visible = workspaces.filter((item) => !filter || `${item.name} ${item.tabs.map((tab) => `${tab.title} ${tab.url}`).join(" ")}`.toLowerCase().includes(filter));
    updateHTML(host.querySelector(".workspace-list"), visible.map((workspace) => `<article class="saved-workspace" data-key="${escapeHtml(workspace.id)}">
      <div class="saved-workspace-heading"><input type="checkbox" data-ws-select="${escapeHtml(workspace.id)}" aria-label="选择 ${escapeHtml(workspace.name)}" ${selected.has(workspace.id) ? "checked" : ""}>
      <div><strong>${escapeHtml(workspace.name)}</strong><small>${workspace.tabs.length} 页 · ${workspace.archived ? "已归档" : workspace.pinned ? "已固定" : "已保存"}${workspace.lastOpenedAt ? ` · 打开于 ${new Date(workspace.lastOpenedAt).toLocaleDateString()}` : ""}${Object.entries(bindings).filter(([, id]) => id === workspace.id).map(([id]) => ` · 关联窗口 ${id}`).join("")}</small></div></div>
      <div class="saved-actions" data-id="${escapeHtml(workspace.id)}">
        <button type="button" data-ws="open">选择恢复</button><button type="button" data-ws="edit">编辑</button>
        <button type="button" data-ws="bind">关联当前窗口</button><button type="button" data-ws="update">更新预览</button><button type="button" data-ws="versions">历史版本</button>
        <button type="button" data-ws="pin">${workspace.pinned ? "取消固定" : "固定"}</button>
        <button type="button" data-ws="archive">${workspace.archived ? "取消归档" : "归档"}</button>
        <button type="button" data-ws="trash">移入回收站</button>
      </div></article>`).join("") || '<p class="saved-hint">暂无匹配的工作区。保存当前窗口后可在这里恢复和编辑。</p>');
    host.querySelector(".merge-workspaces").hidden = selected.size < 2;
    host.querySelector(".workspace-trash summary span").textContent = `(${trash.length})`;
    updateHTML(host.querySelector(".trash-list"), trash.map((workspace) => `<article class="saved-workspace" data-key="${escapeHtml(workspace.id)}">
      <strong>${escapeHtml(workspace.name)}</strong><small>${workspace.tabs.length} 页 · ${new Date(workspace.deletedAt).toLocaleDateString()} 移入</small>
      <div class="saved-actions" data-id="${escapeHtml(workspace.id)}"><button type="button" data-ws="restore-trash">恢复工作区</button><button type="button" data-ws="delete">永久删除</button></div></article>`).join("") || '<p class="saved-hint">回收站为空。</p>');
  };
  host.addEventListener("change", (event) => {
    const id = event.target.dataset.wsSelect;
    if (!id) return;
    if (event.target.checked) selected.add(id); else selected.delete(id);
    host.querySelector(".merge-workspaces").hidden = selected.size < 2;
  });
  const finish = async (result) => {
    if (!result?.ok) throw new Error(result?.reason || "操作未完成。");
    feedback("工作区已更新");
    await refresh();
  };
  host.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-ws]");
    if (!button) return;
    const action = button.dataset.ws;
    const id = button.closest("[data-id]")?.dataset.id;
    const workspace = [...workspaces, ...trash].find((item) => item.id === id);
    const editor = host.querySelector(".workspace-editor");
    if (action === "cancel-edit") { editor.hidden = true; return; }
    if (!workspace) return;
    busy++;
    button.disabled = true;
    try {
      if (action === "open") { await restoreUI.open("workspace", id); return; }
      if (action === "bind") { await finish(await send({ type: "bindWorkspace", workspaceId: id })); return; }
      if (action === "confirm-update") {
        await finish(await send({ type: "confirmWorkspaceUpdate", previewId: button.dataset.previewId }));
        editor.hidden = true;
        return;
      }
      if (action === "versions") {
        const versions = await send({ type: "getWorkspaceVersions", workspaceId: id });
        if (!Array.isArray(versions)) throw new Error(versions.reason);
        editor.innerHTML = `<h3>历史版本 · ${escapeHtml(workspace.name)}</h3><p class="saved-hint">保留最近 5 个旧版本。回退先预览差异，只更新保存内容。</p>
          <div data-id="${escapeHtml(id)}">${versions.map((item) => `<p>${new Date(item.createdAt).toLocaleString()} · ${item.count} 页 <button type="button" data-ws="update" data-version-id="${escapeHtml(item.id)}">预览回退</button></p>`).join("") || "<p>暂无历史版本。</p>"}</div><button type="button" data-ws="cancel-edit">关闭</button>`;
        editor.hidden = false;
        return;
      }
      if (action === "update") {
        const result = await send({ type: "prepareWorkspaceUpdate", workspaceId: id, versionId: button.dataset.versionId });
        if (!result.ok) throw new Error(result.reason);
        const changes = (items, label, type) => `<details><summary>${label} (${items.length})</summary><div data-changes="${type}"></div></details>`;
        editor.innerHTML = `<h3>${result.rollback ? "回退" : "更新"}预览 · ${escapeHtml(result.name)}</h3><p class="saved-hint">新增 ${result.added.length} · 移除 ${result.removed.length} · 布局或标题变化 ${result.changed.length}。确认后保存旧版本，网页保持打开。</p>
          ${changes(result.added, "新增页面", "added")}${changes(result.removed, "移除页面", "removed")}${changes(result.changed, "变化页面", "changed")}
          <div class="saved-actions" data-id="${escapeHtml(id)}"><button type="button" data-ws="confirm-update" data-preview-id="${escapeHtml(result.previewId)}">确认${result.rollback ? "回退" : "更新"}</button><button type="button" data-ws="cancel-edit">取消</button></div>`;
        editor.hidden = false;
        for (const type of ["added", "removed", "changed"]) createPagedList(editor.querySelector(`[data-changes="${type}"]`), { selectable: false }).setData(result[type].map((page, index) => ({ ...page, index })));
        editor.scrollIntoView({ block: "nearest" });
        return;
      }
      if (action === "edit") {
        editor.innerHTML = `<form data-id="${escapeHtml(id)}" data-signature="${escapeHtml(sourceState(workspace))}">
          <h3>编辑工作区</h3><label>工作区名称<input name="workspace-name" value="${escapeHtml(workspace.name)}" maxlength="80" required></label>
          <fieldset class="saved-members"><legend>保留的页面</legend><div class="editor-page-list"></div></fieldset>
          <div class="saved-actions"><button type="submit">保存修改</button><button type="button" data-ws="cancel-edit">取消</button></div><p class="editor-feedback" role="status"></p></form>`;
        editor.hidden = false;
        editorMembers = createPagedList(editor.querySelector(".editor-page-list"), { selected: true });
        editorMembers.setData(workspace.tabs.map((page, index) => ({ ...page, index })));
        editor.scrollIntoView({ block: "nearest", behavior: "instant" });
        editor.querySelector("input").focus({ preventScroll: true });
        return;
      }
      const types = { pin: "toggleWorkspacePinned", archive: "toggleWorkspaceArchived", trash: "trashWorkspace", "restore-trash": "restoreWorkspaceTrash", delete: "deleteWorkspacePermanently" };
      if (action === "delete" && !window.confirm(`永久删除“${workspace.name}”？此快照无法恢复。`)) return;
      await finish(await send({ type: types[action], workspaceId: id, signature: sourceState(workspace), confirm: action === "delete" }));
    } catch (error) { feedback(error.message, true); }
    finally { busy--; button.disabled = false; draw(); }
  });
  host.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    busy++;
    const buttons = [...form.querySelectorAll("button")];
    buttons.forEach((button) => { button.disabled = true; });
    try {
      if (form.classList.contains("merge-workspaces")) {
        await finish(await send({ type: "mergeWorkspaces", workspaceIds: [...selected], name: form.elements["merge-name"].value,
          signatures: Object.fromEntries(workspaces.filter((item) => selected.has(item.id)).map((item) => [item.id, sourceState(item)])) }));
        selected.clear(); form.reset(); draw();
      } else {
        await finish(await send({ type: "editWorkspace", workspaceId: form.dataset.id, signature: form.dataset.signature, name: form.elements["workspace-name"].value,
          indices: editorMembers.values() }));
        host.querySelector(".workspace-editor").hidden = true;
      }
    } catch (error) {
      if (form.querySelector(".editor-feedback")) form.querySelector(".editor-feedback").textContent = error.message;
      feedback(error.message, true);
    } finally { busy--; buttons.forEach((button) => { button.disabled = false; }); draw(); }
  });
  return {
    setData(next, nextTrash, nextBindings = {}) { workspaces = next; trash = nextTrash; bindings = nextBindings; draw(); },
    setFilter(value) { filter = value.trim().toLowerCase(); draw(); }
  };
}
