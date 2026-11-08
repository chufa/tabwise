import { escapeHtml as e } from "../shared/html.js";
import { createPagedList } from "../shared/paged-ui.js";
import { updateHTML } from "../shared/live-ui.js";

const send = async (type, payload = {}) => {
  const result = await chrome.runtime.sendMessage({ type, ...payload });
  if (!result?.ok) throw new Error(result?.reason || "无法读取任务，请重新打开侧栏。");
  return result;
};
const field = (key, label, value, max, rows = 3, required = false) => `<label>${label}<textarea name="${key}" rows="${rows}" maxlength="${max}" ${required ? "required" : ""}>${e(value || "")}</textarea></label>`;
const reference = (task, ids) => ids.length ? ids.map((id) => {
  const index = task.sources.findIndex((source) => source.id === id), source = task.sources[index];
  return source ? `<a href="${e(source.url)}" target="_blank" rel="noopener noreferrer">资料 ${index + 1} · ${e(source.title)}</a>` : "";
}).filter(Boolean).join("；") : "无资料引用 · 需自行核对";
const accepted = (task) => {
  const brief = task.acceptedBrief;
  if (!brief) return "";
  return `<div class="context-accepted"><h3>已采纳的 AI 续接建议</h3>
    <small>${e(brief.provider === "browser" ? "浏览器内置模型" : `${brief.provider === "ollama" ? "Ollama" : "兼容 API"} · ${brief.model}`)} · ${brief.stale ? "输入已变化，请重新生成核对" : "已保存在本地"}</small>
    <p>${e(brief.summary)}</p>${[["hypotheses", "待验证判断"], ["questions", "待验证问题"], ["nextSteps", "建议下一步"]].map(([key, label]) =>
      `<h3>${label}</h3>${brief[key].length ? `<ul>${brief[key].map((item) => `<li>${e(item.text)}<div class="context-citations">${reference(task, item.sourceIds)}</div></li>`).join("")}</ul>` : "<p>暂无建议。</p>"}`).join("")}</div>`;
};
function download(name, content, type, suffix) {
  const blobUrl = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = blobUrl; link.download = `${name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 80) || "task"}${suffix}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

export function createContextUI(host, { restoreUI, createLocalModel }) {
  let tasks = [], workspaces = [], task, dirty = false, prepared, draft, picker, sourceSelection;
  let version = 0, busy = false, writing = false, controller, session, port;
  host.innerHTML = `<div class="section-heading"><h2>任务记忆</h2><button type="button" data-context="new">新建任务</button></div>
    <p class="saved-hint">保存目标和进度，下次回来继续。选定资料可交给您配置的 AI 模型生成续接草稿。</p>
    <label class="context-filter">任务范围<select aria-label="任务范围"><option value="active">进行中</option><option value="archived">已归档</option><option value="all">全部任务</option></select></label>
    <div class="context-list">正在读取任务。</div><div class="context-editor" hidden></div>
    <p class="context-notice" role="status"></p>`;
  const editor = host.querySelector(".context-editor");
  const notice = (message, error = false) => {
    host.querySelector(".context-notice").textContent = message;
    host.querySelector(".context-notice").classList.toggle("is-error", error);
  };
  const clean = () => { if (dirty) throw new Error("有未保存的编辑，请先保存进度，或点击重新读取。"); };
  const lockEditor = () => {
    const fields = [...editor.querySelectorAll("input, textarea, button, select")].map((input) => [input, input.disabled]);
    fields.forEach(([input]) => { input.disabled = true; });
    return () => fields.forEach(([input, disabled]) => { if (input.isConnected) input.disabled = disabled; });
  };
  const reset = () => {
    version++;
    if (prepared) send("cancelContextBrief", { snapshotId: prepared.snapshot.id }).catch(() => {});
    controller?.abort(); session?.destroy?.(); port?.disconnect();
    controller = session = port = null; prepared = draft = null; busy = false;
    editor.querySelector(".context-preview")?.replaceChildren();
    editor.querySelector(".context-draft")?.replaceChildren();
    if (editor.querySelector('[data-context="stop"]')) editor.querySelector('[data-context="stop"]').hidden = true;
    if (editor.querySelector('[data-context="generate"]')) editor.querySelector('[data-context="generate"]').disabled = true;
    if (editor.querySelector('[data-context="preview"]')) editor.querySelector('[data-context="preview"]').disabled = false;
  };
  const drawList = () => {
    const filter = host.querySelector(".context-filter select").value;
    updateHTML(host.querySelector(".context-list"), tasks.filter((item) => filter === "all" || item.status === filter).map((item) =>
      `<article class="context-row" data-task-id="${e(item.id)}"><button type="button" data-context="open">${e(item.name)}</button>
        <small>${item.sources.length} 个资料 · ${item.status === "archived" ? "已归档" : "进行中"} · ${e(item.progress.slice(0, 100) || "尚未记录进度")}</small></article>`).join("")
      || '<p class="saved-hint">暂无任务。新建任务后记录目标，并选择本次需要的资料。</p>');
  };
  const refreshList = async () => {
    const result = await send("listContextTasks");
    tasks = result.tasks; workspaces = result.workspaces; drawList();
    if (task && !writing && !tasks.some((item) => item.id === task.id)) {
      reset(); task = null; dirty = false; editor.hidden = true; notice("该任务已从另一个侧栏删除。");
    } else if (task && tasks.find((item) => item.id === task.id)?.revision !== task.revision) {
      notice("任务已在另一个侧栏更新。请重新读取后继续编辑。", true);
    }
  };
  const renderEditor = (value) => {
    reset(); sourceSelection?.destroy(); sourceSelection = null; picker = null;
    task = value; dirty = false; editor.hidden = false;
    editor.innerHTML = `<form class="context-form">
      <div class="context-fields"><label>任务名称<input name="name" maxlength="80" value="${e(task?.name || "")}" required placeholder="例如：Chrome 内存调研"></label>
      ${field("goal", "任务目标", task?.goal, 2000, 3, true)}
      ${field("progress", "当前进度", task?.progress, 4000)}
      <details><summary>确认记录、问题与下一步</summary><div class="context-fields">
      ${field("confirmedNotes", "用户确认的记录", task?.confirmedNotes, 4000)}
      ${field("questions", "未决问题（每行一项，最多 20 项）", task?.questions.join("\n"), 10020)}
      ${field("nextSteps", "下一步（每行一项，最多 20 项）", task?.nextSteps.join("\n"), 10020)}</div></details></div>
      <div class="saved-actions"><button type="submit">${task ? "保存进度" : "创建任务"}</button>
        ${task ? '<button type="button" data-context="reload">重新读取</button>' : '<button type="button" data-context="close">取消创建</button>'}</div>
      ${task ? `<h3>任务资料</h3><p class="saved-hint">勾选本次交给 AI 的资料；默认不选。笔记和片段由你手动提供，插件不会读取网页正文。</p>
        <div class="context-sources">${task.sources.map((source, index) => `<div class="context-source" data-source-id="${e(source.id)}">
        <label><input type="checkbox" data-model-source value="${e(source.id)}"><span><a href="${e(source.url)}" target="_blank" rel="noopener noreferrer">${index + 1}. ${e(source.title)}</a>
        <small>${e(new URL(source.url).hostname)}</small></span></label>
        <details><summary>编辑资料笔记与片段</summary><label>资料笔记<textarea data-source-note maxlength="1000" rows="2">${e(source.note)}</textarea></label>
        <label>手动提供的片段<textarea data-source-excerpt maxlength="2000" rows="3">${e(source.excerpt)}</textarea></label>
        <label><input type="checkbox" data-source-remove>保存时移除此资料</label></details></div>`).join("") || '<p class="saved-hint">暂无资料，也可以只根据已记录的进度生成续接草稿。</p>'}</div>
        <div class="saved-actions"><button type="button" data-context="sources">选择资料加入任务</button>
        <button type="button" data-context="restore" ${task.sources.length ? "" : "disabled"}>选择资料继续</button></div>` : ""}
      </form>
      ${task ? `<div class="context-picker" hidden></div>
        <h3>AI 任务续接</h3><p class="saved-hint">先核对将交给哪个模型的内容，再生成草稿。AI 判断仍需验证，采纳后会单独保存。</p>
        <div class="saved-actions"><button type="button" data-context="preview">预览续接输入</button>
        <button type="button" data-context="generate" disabled>生成续接草稿</button><button type="button" data-context="stop" hidden>停止生成</button></div>
        <div class="context-preview"></div><div class="context-draft"></div>${accepted(task)}
        <h3>上下文交接</h3><p class="saved-hint">复制或下载包含原始网址的上下文包，交给 AI 对话或 IDE。任务仅保存在本机。</p>
        <div class="saved-actions"><button type="button" data-context="copy">复制 Markdown</button><button type="button" data-context="markdown">下载 Markdown</button>
        <button type="button" data-context="json">导出任务 JSON</button><button type="button" data-context="archive">${task.status === "archived" ? "取消归档" : "归档任务"}</button></div>
        <details><summary>删除任务记忆</summary><p>删除此任务及其笔记和草稿，已打开的页面保持打开。</p>
        <label><input type="checkbox" data-delete-confirm>我确认删除此任务记忆</label><div class="saved-actions"><button type="button" data-context="delete">删除任务记忆</button></div></details>` : ""}`;
  };
  const preview = async () => {
    clean(); reset(); const current = version, id = task.id;
    const sourceIds = [...editor.querySelectorAll("[data-model-source]:checked")].map((input) => input.value);
    const result = await send("prepareContextBrief", { taskId: id, sourceIds });
    if (current !== version || task?.id !== id) return;
    prepared = result;
    const input = result.snapshot.input;
    editor.querySelector(".context-preview").innerHTML = `<details open><summary>本次交给模型的完整内容</summary>
      <p>接收方：${e(result.provider === "browser" ? "浏览器内置模型" : `${result.provider === "ollama" ? "本机 Ollama" : "兼容 API"} · ${result.model} · ${result.endpoint}`)}</p>
      <dl>${[["goal", "目标"], ["progress", "进度"], ["confirmedNotes", "用户确认记录"], ["questions", "未决问题"], ["nextSteps", "下一步"]].map(([key, label]) =>
        `<dt>${label}</dt><dd>${e(Array.isArray(input[key]) ? input[key].join("\n") || "无" : input[key] || "无")}</dd>`).join("")}</dl>
      ${input.sources.map((source) => `<div class="context-input-source"><strong>${e(source.title)}</strong><small> · ${e(source.domain)}</small>
        <dl><dt>资料笔记</dt><dd>${e(source.note || "无")}</dd><dt>手动片段</dt><dd>${e(source.excerpt || "无")}</dd></dl></div>`).join("")}
      <p>已选 ${input.sources.length} 个资料。网址、邮箱和常见凭据已清理，原始网址留在本地；请核对其他私密内容。预览 10 分钟有效。</p></details>`;
    editor.querySelector('[data-context="generate"]').disabled = false;
    notice("输入已准备，请核对后生成。");
  };
  const showDraft = () => {
    editor.querySelector(".context-preview details").open = false;
    editor.querySelector(".context-draft").innerHTML = `<h3>审阅续接草稿</h3><p class="saved-hint">可修改文字；引用可打开核对。采纳保存为 AI 建议，不会改写用户确认记录。</p>
      ${field("summary", "续接摘要", draft.summary, 1600)}
      ${[["hypotheses", "待验证判断"], ["questions", "待验证问题"], ["nextSteps", "建议下一步"]].map(([key, label]) =>
        `<fieldset><legend>${label}</legend>${draft[key].map((item, index) =>
          `<label>${label} ${index + 1}<textarea data-draft-key="${key}" data-draft-index="${index}" maxlength="600" rows="2">${e(item.text)}</textarea></label>
          <div class="context-citations">${reference(task, item.sourceIds)}</div>`).join("") || "<p>暂无建议。</p>"}</fieldset>`).join("")}
      <label class="context-confirm"><input type="checkbox" data-adopt-confirm>我已审阅，保存为此任务的 AI 续接建议</label>
      <div class="saved-actions"><button type="button" data-context="adopt">确认采纳草稿</button></div>`;
  };
  const generate = async () => {
    clean(); if (!prepared || busy) return;
    const current = version, input = prepared;
    busy = true; controller = new AbortController();
    port = chrome.runtime.connect({ name: "tabwise-context-ai" });
    const activePort = port;
    port.postMessage({ snapshotId: input.snapshot.id });
    editor.querySelector('[data-context="generate"]').disabled = true;
    editor.querySelector('[data-context="preview"]').disabled = true;
    editor.querySelector('[data-context="stop"]').hidden = false;
    notice("正在生成续接草稿…");
    let activeSession;
    try {
      let result;
      if (input.provider !== "browser") result = await send("generateContextBrief", { snapshotId: input.snapshot.id });
      else {
        await send("beginContextBrief", { snapshotId: input.snapshot.id });
        if (current !== version) return;
        activeSession = await createLocalModel();
        if (current !== version) return;
        session = activeSession;
        const answer = await activeSession.prompt(input.prompt, { responseConstraint: input.schema, signal: controller.signal });
        if (current !== version) return;
        result = await send("acceptContextBrief", { snapshotId: input.snapshot.id, answer });
      }
      if (current !== version) return;
      draft = result.brief; showDraft(); notice(`草稿已生成${result.latencyMs === undefined ? "" : ` · ${(result.latencyMs / 1000).toFixed(1)} 秒`}，请核对引用并审阅文字。`);
    } catch (error) {
      if (current === version) { reset(); notice(`${error.message} 请重新预览后重试。`, true); }
    } finally {
      activeSession?.destroy?.(); activePort.disconnect();
      if (current === version) {
        busy = false; controller = session = port = null;
        editor.querySelector('[data-context="stop"]').hidden = true;
        editor.querySelector('[data-context="preview"]').disabled = false;
      }
    }
  };
  const openPicker = async () => {
    clean(); const hostPicker = editor.querySelector(".context-picker");
    sourceSelection?.destroy(); sourceSelection = null;
    hostPicker.hidden = false;
    hostPicker.innerHTML = `<h3>选择资料</h3><label>资料范围<select data-source-kind><option value="current">当前窗口</option><option value="workspace">已保存工作区</option></select></label>
      <label data-source-workspace-label hidden>工作区<select data-source-workspace>${workspaces.map((item) => `<option value="${e(item.id)}">${e(item.name)}</option>`).join("")}</select></label>
      <div class="saved-actions"><button type="button" data-context="source-preview">读取资料列表</button><button type="button" data-context="source-close">取消</button></div>
      <p class="saved-hint">仅列出所选范围的标题和网址，不打开页面。勾选资料后明确加入此任务。</p>
      <div class="context-source-picker"></div><div class="saved-actions"><button type="button" data-context="attach" disabled>将选定资料加入任务</button></div>`;
    picker = null;
  };
  editor.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (writing) return;
    const form = event.target, current = version;
    const patch = Object.fromEntries(new FormData(form));
    if (task) {
      patch.sourceIds = task.sources.filter((source) => ![...form.querySelectorAll(".context-source")].find((row) =>
        row.dataset.sourceId === source.id)?.querySelector("[data-source-remove]").checked).map((source) => source.id);
      patch.sourceNotes = Object.fromEntries([...form.querySelectorAll(".context-source")].filter((row) => patch.sourceIds.includes(row.dataset.sourceId)).map((row) =>
        [row.dataset.sourceId, { note: row.querySelector("[data-source-note]").value, excerpt: row.querySelector("[data-source-excerpt]").value }]));
    }
    writing = true; const unlock = lockEditor(); notice("正在保存任务…");
    try {
      const result = await send(task ? "updateContextTask" : "createContextTask", task ? { taskId: task.id, revision: task.revision, patch } : { fields: patch });
      if (current !== version) return;
      renderEditor(result.task); await refreshList(); notice("任务进度已保存在本地。");
    } catch (error) { notice(error.message, true); }
    finally { writing = false; unlock(); }
  });
  host.addEventListener("input", (event) => {
    if (event.target.closest(".context-form")) {
      if (event.target.matches("[data-model-source]")) { reset(); return; }
      dirty = true; reset(); notice("有未保存的编辑。");
    }
  });
  host.addEventListener("change", (event) => {
    if (event.target.matches(".context-filter select")) drawList();
    if (event.target.matches("[data-source-kind], [data-source-workspace]")) {
      version++;
      picker = null; sourceSelection?.destroy(); sourceSelection = null;
      editor.querySelector(".context-source-picker").replaceChildren();
      editor.querySelector('[data-context="attach"]').disabled = true;
      editor.querySelector("[data-source-workspace-label]").hidden = editor.querySelector("[data-source-kind]").value !== "workspace";
    }
  });
  host.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-context]");
    if (!button || button.disabled || writing) return;
    const action = button.dataset.context;
    let unlock;
    try {
      if (action === "stop") { reset(); notice("生成已停止，请重新预览。"); return; }
      if (action === "reload") {
        await refreshList(); const fresh = tasks.find((item) => item.id === task?.id);
        if (fresh) renderEditor(fresh); notice("已重新读取本地记录。"); return;
      }
      if (action === "close") { reset(); editor.hidden = true; dirty = false; return; }
      if (action === "new") { clean(); renderEditor(null); editor.querySelector('[name="name"]').focus(); return; }
      if (action === "open") {
        clean(); reset(); const current = version;
        const result = await send("resumeContextTask", { taskId: button.closest("[data-task-id]").dataset.taskId });
        if (current !== version) return;
        renderEditor(result.task); notice("已返回任务。可以更新进度，或选择资料继续。"); return;
      }
      clean();
      if (["attach", "adopt", "archive", "delete"].includes(action)) {
        writing = true; unlock = lockEditor(); notice("正在保存任务…");
      }
      if (action === "sources") return await openPicker();
      if (action === "source-close") { editor.querySelector(".context-picker").hidden = true; picker = null; return; }
      if (action === "source-preview") {
        const current = version;
        const result = await send("prepareContextSources", { kind: editor.querySelector("[data-source-kind]").value, workspaceId: editor.querySelector("[data-source-workspace]").value });
        if (current !== version) return;
        picker = result;
        sourceSelection?.destroy();
        sourceSelection = createPagedList(editor.querySelector(".context-source-picker"), { key: (source) => source.id, limit: 20,
          onChange: (ids) => { editor.querySelector('[data-context="attach"]').disabled = !ids.length; },
          render: (source) => `<span><strong>${e(source.title)}</strong><small>${e(source.url)}</small></span>` });
        sourceSelection.setData(picker.sources); return;
      }
      if (action === "attach") {
        if (!picker) return;
        const result = await send("attachContextSources", { taskId: task.id, revision: task.revision, previewId: picker.id, sourceIds: sourceSelection.values(), confirm: true });
        renderEditor(result.task); await refreshList(); notice("选定资料已加入任务，相同网址只保留一次。"); return;
      }
      if (action === "restore") return await restoreUI.open("context", task.id);
      if (action === "preview") return await preview();
      if (action === "generate") return await generate();
      if (action === "adopt") {
        if (!draft || !prepared) return;
        const brief = structuredClone(draft);
        brief.summary = editor.querySelector('.context-draft [name="summary"]').value;
        for (const input of editor.querySelectorAll("[data-draft-key]")) brief[input.dataset.draftKey][Number(input.dataset.draftIndex)].text = input.value;
        const result = await send("adoptContextBrief", { snapshotId: prepared.snapshot.id, brief, confirm: editor.querySelector("[data-adopt-confirm]").checked });
        renderEditor(result.task); await refreshList(); notice("已采纳草稿，用户确认记录保持原样。"); return;
      }
      if (["copy", "markdown", "json"].includes(action)) {
        const result = await send("exportContextTask", { taskId: task.id });
        if (action === "copy") {
          try { await navigator.clipboard.writeText(result.markdown); notice("带出处的 Markdown 已复制。"); }
          catch { throw new Error("浏览器未允许复制，请使用下载 Markdown。"); }
        } else {
          download(result.name, action === "json" ? result.json : result.markdown, action === "json" ? "application/json" : "text/markdown;charset=utf-8", action === "json" ? ".json" : ".md");
          notice("已请求下载上下文包。");
        }
        return;
      }
      if (action === "archive") {
        const result = await send("updateContextTask", { taskId: task.id, revision: task.revision, patch: { status: task.status === "active" ? "archived" : "active" } });
        renderEditor(result.task); await refreshList(); notice("任务归档状态已保存。"); return;
      }
      if (action === "delete") {
        await send("deleteContextTask", { taskId: task.id, revision: task.revision, confirm: editor.querySelector("[data-delete-confirm]").checked });
        reset(); task = null; dirty = false; editor.hidden = true; await refreshList(); notice("任务记忆已删除。");
      }
    } catch (error) { notice(error.message, true); }
    finally { if (unlock) { writing = false; unlock(); } }
  });
  window.addEventListener("pagehide", reset);
  return { update: () => refreshList().catch((error) => notice(error.message, true)) };
}
