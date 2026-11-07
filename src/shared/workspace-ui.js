import { escapeHtml } from "./html.js";
import { sourceState } from "./restoration.js";
import { updateHTML } from "./live-ui.js";
import { pageStatus, taskCounts, restoreStatus } from "./task-ui.js";
import { createPagedList } from "./paged-ui.js";
import { filterWorkspaces } from "./workspace-metadata.js";
import { restoreTagIndices } from "./workspace-presets.js";
import { createOrganizationUI } from "./organization-ui.js";
import { highlightMatch } from "./html.js";

const send = (message) => chrome.runtime.sendMessage(message);
const memberBody = (page, query = "") => `<span><strong>${highlightMatch(page.title || page.url, query)}</strong>
  <small>${highlightMatch(page.url, query)} · 窗口 ${(page.windowKey ?? 0) + 1}${page.pinned ? " · 固定" : ""}${page.status === "suspended" ? " · 休眠" : ""}${page.existing ? " · 已打开（将跳过）" : ""}</small>
  ${page.tags?.length ? `<small>标签：${highlightMatch(page.tags.join(" · "), query)}</small>` : ""}</span>`;

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
  host.addEventListener("change", (event) => {
    if (preview && event.target.matches(".restore-tag")) members.setValues(restoreTagIndices(preview.pages, event.target.value));
    count();
  });
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
    const loadMode = host.querySelector(".restore-load-mode").value;
    const concurrency = Number(host.querySelector(".restore-concurrency").value);
    host.querySelectorAll("button, input, select").forEach((input) => { input.disabled = true; });
    host.querySelector(".restore-result").textContent = "正在分批恢复所选页面…";
    try {
      const result = await send({ type: "startRestore", previewId: preview.previewId, indices, skipExisting, restoreLayout, loadMode, concurrency,
        tag: host.querySelector(".restore-tag").value, rememberPreset: host.querySelector(".remember-preset")?.checked || false });
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
        <label class="saved-switch">页面标签<select class="restore-tag"><option value="">全部页面</option>${[...new Set(result.pages.flatMap((page) => page.tags || []))].map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join("")}</select></label>
        <fieldset class="saved-members"><legend>要恢复的页面</legend><div class="restore-page-list"></div></fieldset>
        <label class="saved-switch"><input class="skip-existing" type="checkbox" checked>跳过已打开的页面（所有窗口）</label>
        <label class="saved-switch">加载方式<select class="restore-load-mode"><option value="eager">分批加载网页</option><option value="on-demand">先建立休眠页，点击再加载</option></select></label>
        <label class="saved-switch">每批页数<select class="restore-concurrency">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${n === 5 ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <p class="saved-hint">按需恢复不会请求原网站；恢复的是网址和布局，不包含未保存的网页内容。</p>
        ${kind === "workspace" ? '<label class="saved-switch"><input class="remember-preset" type="checkbox" checked>记住此工作区的恢复方式</label>' : ""}
        ${result.hasLayout ? `<label class="saved-switch"><input class="restore-layout" type="checkbox" checked>新建窗口恢复布局（仅新打开的页面）</label>
        <p class="saved-hint">快照含 ${result.windowCount} 个窗口、固定页和标签组。勾选布局时保留原休眠状态；取消后使用当前窗口，加载方式由上方选择决定。</p>` : ""}
        <div class="saved-actions"><button type="button" data-restore="confirm">恢复所选页面</button><button type="button" data-restore="cancel">取消</button></div>
        <div class="restore-result" role="status"></div>`;
      host.hidden = false;
      members = createPagedList(host.querySelector(".restore-page-list"), { selected: true, render: memberBody, onChange: count });
      members.setData(result.pages.map((page, index) => ({ ...page, index })));
      const preset = result.preset;
      host.querySelector(".restore-load-mode").value = preset.loadMode;
      host.querySelector(".restore-concurrency").value = preset.concurrency;
      host.querySelector(".skip-existing").checked = preset.skipExisting;
      if (host.querySelector(".restore-layout")) host.querySelector(".restore-layout").checked = preset.restoreLayout;
      if ([...host.querySelector(".restore-tag").options].some((option) => option.value === preset.tag)) {
        host.querySelector(".restore-tag").value = preset.tag;
        members.setValues(restoreTagIndices(result.pages, preset.tag));
      }
      if (options.indices) members.setValues(options.indices);
      count();
      host.scrollIntoView({ block: "nearest", behavior: "instant" });
      host.querySelector("[data-restore=all]").focus({ preventScroll: true });
    }
  };
}

export function createWorkspaceUI(host, restoreUI, feedback, refresh) {
  const organizationUI = createOrganizationUI(feedback, refresh);
  let workspaces = [];
  let trash = [];
  let filter = "";
  let externalFilter = "";
  let busy = 0;
  let bindings = {};
  let editorMembers;
  let pageTags = {};
  let savedFilters = [];
  let facets = { tag: "", status: "all", favorite: false };
  const selected = new Set();
  host.innerHTML = `<div class="workspace-filters saved-actions">
    <input class="ws-query" type="search" maxlength="200" aria-label="搜索工作区" placeholder="搜索名称、标签或备注">
    <label>标签<select class="ws-tag"><option value="">全部标签</option></select></label>
    <label>状态<select class="ws-status"><option value="all">全部状态</option><option value="active">未归档</option><option value="archived">已归档</option></select></label>
    <label><input class="ws-favorite" type="checkbox">仅收藏</label>
    <label>已保存筛选<select class="ws-saved-filter"><option value="">选择筛选</option></select></label>
    <input class="ws-filter-name" maxlength="40" aria-label="筛选名称" placeholder="筛选名称">
    <button type="button" data-filter="save">保存筛选</button><button type="button" data-filter="delete">删除筛选</button>
    <button type="button" data-organize-duplicates>合并当前窗口重复页</button>
    </div><div class="workspace-favorites saved-actions" aria-label="收藏工作区快捷入口"></div><div class="workspace-list"></div>
    <form class="merge-workspaces" hidden><label>合并后的名称<input name="merge-name" maxlength="80" required placeholder="新工作区名称"></label>
    <p class="saved-hint">合并所选工作区；布局快照保留窗口和重复页面，原工作区保留。</p><button type="submit">合并所选工作区</button></form>
    <div class="workspace-editor" hidden></div>
    <details class="workspace-trash"><summary>回收站 <span></span></summary><p class="saved-hint">仅移除保存的快照，网页标签保持打开。最多保留 20 个，可手动恢复。</p><div class="trash-list"></div></details>`;
  const draw = () => {
    if (busy) return;
    for (const id of selected) if (!workspaces.some((item) => item.id === id)) selected.delete(id);
    const visible = filterWorkspaces(workspaces, { ...facets, query: filter });
    updateHTML(host.querySelector(".workspace-favorites"), workspaces.filter((workspace) => workspace.favorite).map((workspace) =>
      `<span data-id="${escapeHtml(workspace.id)}"><button type="button" data-ws="open">★ ${escapeHtml(workspace.name)}</button></span>`).join(""));
    updateHTML(host.querySelector(".ws-tag"), `<option value="">全部标签</option>${[...new Set(workspaces.flatMap((item) => item.tags || []))].map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join("")}`);
    host.querySelector(".ws-tag").value = facets.tag;
    updateHTML(host.querySelector(".ws-saved-filter"), `<option value="">选择筛选</option>${savedFilters.map((item, i) => `<option value="${i}">${escapeHtml(item.name)}</option>`).join("")}`);
    updateHTML(host.querySelector(".workspace-list"), visible.map((workspace) => `<article class="saved-workspace" data-key="${escapeHtml(workspace.id)}">
      <div class="saved-workspace-heading"><input type="checkbox" data-ws-select="${escapeHtml(workspace.id)}" aria-label="选择 ${escapeHtml(workspace.name)}" ${selected.has(workspace.id) ? "checked" : ""}>
      <div><strong>${workspace.favorite ? "★ " : ""}${highlightMatch(workspace.name, filter)}</strong><small>${workspace.tabs.length} 页 · ${workspace.archived ? "已归档" : workspace.pinned ? "已固定" : "已保存"}${workspace.lastOpenedAt ? ` · 打开于 ${new Date(workspace.lastOpenedAt).toLocaleDateString()}` : ""}${Object.entries(bindings).filter(([, id]) => id === workspace.id).map(([id]) => ` · 关联窗口 ${id}`).join("")}</small>
      ${(workspace.tags || []).length ? `<small>${escapeHtml(workspace.tags.join(" · "))}</small>` : ""}
      ${workspace.notes ? `<small class="workspace-notes">${highlightMatch(workspace.notes, filter)}</small>` : ""}</div></div>
      <div class="saved-actions" data-id="${escapeHtml(workspace.id)}">
        <button type="button" data-ws="open">选择恢复</button><button type="button" data-ws="edit">编辑</button>
        <button type="button" data-ws="links">检测链接</button>
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
    if (event.target.matches(".ws-tag, .ws-status, .ws-favorite")) {
      facets = { tag: host.querySelector(".ws-tag").value, status: host.querySelector(".ws-status").value, favorite: host.querySelector(".ws-favorite").checked };
      draw(); return;
    }
    if (event.target.matches(".ws-saved-filter")) {
      const saved = savedFilters[event.target.value];
      if (saved) {
        filter = saved.query; facets = { tag: saved.tag, status: saved.status, favorite: saved.favorite };
        host.querySelector(".ws-query").value = filter;
        host.querySelector(".ws-status").value = saved.status; host.querySelector(".ws-favorite").checked = saved.favorite;
        host.querySelector(".ws-filter-name").value = saved.name;
        draw();
      }
      return;
    }
    const id = event.target.dataset.wsSelect;
    if (!id) return;
    if (event.target.checked) selected.add(id); else selected.delete(id);
    host.querySelector(".merge-workspaces").hidden = selected.size < 2;
  });
  host.addEventListener("input", (event) => {
    if (event.target.matches(".ws-query")) { filter = event.target.value.trim(); draw(); }
    if (event.target.matches("[data-page-tags]")) pageTags[event.target.dataset.pageTags] = event.target.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
  });
  const finish = async (result) => {
    if (!result?.ok) throw new Error(result?.reason || "操作未完成。");
    feedback("工作区已更新");
    await refresh();
  };
  host.addEventListener("click", async (event) => {
    if (event.target.closest("[data-organize-duplicates]")) {
      try { await organizationUI.duplicates(); } catch (error) { feedback(error.message, true); }
      return;
    }
    const filterAction = event.target.closest("[data-filter]")?.dataset.filter;
    if (filterAction) {
      try {
        const name = host.querySelector(".ws-filter-name").value.trim();
        const next = savedFilters.filter((item) => item.name !== name);
        if (filterAction === "save") next.push({ name, query: filter, ...facets });
        const result = await send({ type: "saveWorkspaceFilters", filters: next });
        if (!result.ok) throw new Error(result.reason);
        savedFilters = next; draw(); feedback("筛选条件已更新");
      } catch (error) { feedback(error.message, true); }
      return;
    }
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
      if (action === "links") { await organizationUI.links(id); return; }
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
        pageTags = Object.fromEntries(workspace.tabs.map((page, index) => [index, page.tags || []]));
        editor.innerHTML = `<form data-id="${escapeHtml(id)}" data-signature="${escapeHtml(sourceState(workspace))}">
          <h3>编辑工作区</h3><label>工作区名称<input name="workspace-name" value="${escapeHtml(workspace.name)}" maxlength="80" required></label>
          <label>标签（逗号分隔，最多 12 个）<input name="workspace-tags" value="${escapeHtml((workspace.tags || []).join(", "))}" maxlength="400"></label>
          <label>备注（仅本机，最多 2000 字）<textarea name="workspace-notes" maxlength="2000" rows="3">${escapeHtml(workspace.notes || "")}</textarea></label>
          <label class="saved-switch"><input name="workspace-favorite" type="checkbox" ${workspace.favorite ? "checked" : ""}>收藏为常用工作区</label>
          <fieldset class="saved-members"><legend>保留的页面</legend><div class="editor-page-list"></div></fieldset>
          <div class="saved-actions"><button type="submit">保存修改</button><button type="button" data-ws="cancel-edit">取消</button></div><p class="editor-feedback" role="status"></p></form>`;
        editor.hidden = false;
        editorMembers = createPagedList(editor.querySelector(".editor-page-list"), { selected: true,
          render: (page, query) => `${memberBody(page, query)}<input type="text" data-page-tags="${page.index}" value="${escapeHtml(pageTags[page.index].join(", "))}" maxlength="400" aria-label="页面 ${page.index + 1} 标签" placeholder="页面标签（逗号分隔）">` });
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
          metadata: { tags: form.elements["workspace-tags"].value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
            notes: form.elements["workspace-notes"].value, favorite: form.elements["workspace-favorite"].checked, pageTags },
          indices: editorMembers.values() }));
        host.querySelector(".workspace-editor").hidden = true;
      }
    } catch (error) {
      if (form.querySelector(".editor-feedback")) form.querySelector(".editor-feedback").textContent = error.message;
      feedback(error.message, true);
    } finally { busy--; buttons.forEach((button) => { button.disabled = false; }); draw(); }
  });
  send({ type: "getWorkspaceFilters" }).then((values) => { if (Array.isArray(values)) { savedFilters = values; draw(); } }).catch(() => {});
  return {
    setData(next, nextTrash, nextBindings = {}) { workspaces = next; trash = nextTrash; bindings = nextBindings; draw(); },
    setFilter(value) {
      if (value === externalFilter) return;
      externalFilter = value; filter = value.trim();
      host.querySelector(".ws-query").value = filter; draw();
    }
  };
}
