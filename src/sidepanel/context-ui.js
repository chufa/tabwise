import { escapeHtml as e } from "../shared/html.js";
import { createPagedList } from "../shared/paged-ui.js";
import { updateHTML } from "../shared/live-ui.js";
import { createNavigation, revealElement } from "../shared/navigation.js";

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
const handoffReview = (task) => task.status !== "archived" ? "" : `<details class="context-completion" open>
  <summary>任务交接清单</summary>
  <p>本地根据当前任务记录生成，可在重新开始任务前核对。</p>
  <dl><dt>目标</dt><dd>${e(task.goal)}</dd><dt>完成进度</dt><dd>${e(task.progress || "尚未记录")}</dd>
  <dt>下一步</dt><dd>${task.nextSteps.length ? e(task.nextSteps.join("\n")) : "暂无记录"}</dd>
  <dt>资料</dt><dd>${task.sources.length ? task.sources.map((source, index) => `${index + 1}. ${source.title}`).map(e).join("\n") : "暂无资料"}</dd></dl>
</details>`;
function download(name, content, type, suffix) {
  const blobUrl = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = blobUrl; link.download = `${name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 80) || "task"}${suffix}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

export function createContextUI(host, { restoreUI, createLocalModel }) {
  let tasks = [], workspaces = [], task, dirty = false, prepared, draft, evidencePrepared, evidenceDraft, picker, sourceSelection;
  let version = 0, busy = false, writing = false, controller, session, port;
  host.innerHTML = `<div class="section-heading"><h2>继续你的工作</h2><button class="primary-button" type="button" data-context="new">新建任务</button></div>
    <p class="saved-hint">记住目标、进度和资料，下次回来从这里继续。</p>
    <p class="context-notice" role="status" aria-live="polite"></p>
    <details class="context-browser" open><summary hidden>切换任务</summary>
      <label class="context-filter">任务范围<select aria-label="任务范围"><option value="active">进行中</option><option value="archived">已归档</option><option value="all">全部任务</option></select></label>
      <label class="context-search">查找任务<input type="search" placeholder="搜索任务名称或目标" aria-label="查找任务"></label>
      <div class="context-list">正在读取任务。</div>
    </details><div class="context-editor" hidden></div>`;
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
    if (evidencePrepared) send("cancelEvidenceAnswer", { snapshotId: evidencePrepared.snapshot.id }).catch(() => {});
    controller?.abort(); session?.destroy?.(); port?.disconnect();
    controller = session = port = null; prepared = draft = evidencePrepared = evidenceDraft = null; busy = false;
    editor.querySelector(".context-preview")?.replaceChildren();
    editor.querySelector(".context-draft")?.replaceChildren();
    if (editor.querySelector('[data-context="stop"]')) editor.querySelector('[data-context="stop"]').hidden = true;
    if (editor.querySelector('[data-context="generate"]')) editor.querySelector('[data-context="generate"]').disabled = true;
    if (editor.querySelector('[data-context="preview"]')) editor.querySelector('[data-context="preview"]').disabled = false;
  };
  const drawList = () => {
    const filter = host.querySelector(".context-filter select").value;
    const query = host.querySelector(".context-search input").value.trim().toLocaleLowerCase();
    const visible = tasks.filter((item) => (filter === "all" || item.status === filter) && (!query || `${item.name} ${item.goal}`.toLocaleLowerCase().includes(query)));
    host.querySelector(".context-browser summary").textContent = `切换任务 · ${visible.length} 个${filter === "archived" ? "已归档" : filter === "active" ? "进行中" : ""}`;
    updateHTML(host.querySelector(".context-list"), visible.map((item) =>
      `<article class="context-row ${item.id === task?.id ? "is-current" : ""}" data-task-id="${e(item.id)}"><button type="button" data-context="open" ${item.id === task?.id ? 'aria-current="true"' : ""}>${e(item.name)}</button>
        <small>${item.sources.length} 个资料 · ${item.status === "archived" ? "已归档" : "进行中"} · ${e(item.progress.slice(0, 100) || "尚未记录进度")}</small></article>`).join("")
      || (tasks.length ? '<p class="saved-hint">没有匹配的任务。试试其他关键词或任务范围。</p>' : '<div class="context-empty"><h3>让下一次开始更轻松</h3><p class="saved-hint">新建一个任务，写下目标和做到哪一步。需要时再加入页面资料，或使用 AI 整理续接建议。</p></div>'));
  };
  const refreshList = async () => {
    const result = await send("listContextTasks");
    tasks = result.tasks; workspaces = result.workspaces; drawList();
    if (task && !writing && !tasks.some((item) => item.id === task.id)) {
      reset(); task = null; dirty = false; editor.hidden = true; host.querySelector(".context-browser").open = true; notice("该任务已从另一个侧栏删除。");
    } else if (task && tasks.find((item) => item.id === task.id)?.revision !== task.revision) {
      notice("任务已在另一个侧栏更新。请重新读取后继续编辑。", true);
    }
  };
  const renderEditor = (value) => {
    const sameTask = value?.id && value.id === task?.id;
    const currentView = sameTask ? editor.querySelector('[role="tab"][aria-selected="true"]')?.dataset.viewButton : null;
    const handoffOpen = sameTask && editor.querySelector(".context-handoff")?.open;
    const scrollPosition = window.scrollY;
    reset(); sourceSelection?.destroy(); sourceSelection = null; picker = null;
    task = value; dirty = false; editor.hidden = false;
    host.querySelector(".context-browser").open = false;
    host.querySelector(".context-browser summary").hidden = false;
    editor.dataset.navigation = "context";
    editor.innerHTML = `<div class="context-editor-title"><h3>${e(task?.name || "记录一个新任务")}</h3>${task ? '<button type="button" data-context="back">任务列表</button>' : ""}</div>
      ${task ? `<nav class="sub-tabs" role="tablist" aria-label="任务步骤">
        <button id="context-tab-progress" role="tab" aria-controls="context-view-progress" data-view-button="progress" type="button">记录进度</button>
        <button id="context-tab-sources" role="tab" aria-controls="context-view-sources" data-view-button="sources" type="button">任务资料</button>
        <button id="context-tab-ai" role="tab" aria-controls="context-view-ai" data-view-button="ai" type="button">AI 续接</button>
        <button id="context-tab-evidence" role="tab" aria-controls="context-view-evidence" data-view-button="evidence" type="button">证据问答</button></nav>` : ""}
      <form class="context-form" novalidate>
      <div id="context-view-progress" ${task ? 'role="tabpanel" aria-labelledby="context-tab-progress" data-view="progress"' : ""}>
      <div class="context-fields"><label>任务名称<input name="name" maxlength="80" value="${e(task?.name || "")}" required placeholder="例如：Chrome 内存调研"></label>
      <label>优先级<select name="priority"><option value="high" ${task?.priority === "high" ? "selected" : ""}>高</option><option value="medium" ${!task || task?.priority === "medium" ? "selected" : ""}>中</option><option value="low" ${task?.priority === "low" ? "selected" : ""}>低</option></select></label>
      <label>截止日期<input name="dueAt" type="date" value="${e(task?.dueAt || "")}"></label>
      <label>默认工作区<select name="workspaceId"><option value="">不绑定工作区</option>${workspaces.map((item) => `<option value="${e(item.id)}" ${task?.workspaceId === item.id ? "selected" : ""}>${e(item.name)}</option>`).join("")}</select></label>
      ${field("goal", "任务目标", task?.goal, 2000, 3, true)}
      ${field("progress", "当前进度", task?.progress, 4000)}
      <details><summary>确认记录、问题与下一步</summary><div class="context-fields">
      ${field("confirmedNotes", "用户确认的记录", task?.confirmedNotes, 4000)}
      ${field("questions", "未决问题（每行一项，最多 20 项）", task?.questions.join("\n"), 10020)}
      ${field("nextSteps", "下一步（每行一项，最多 20 项）", task?.nextSteps.join("\n"), 10020)}
      ${field("todos", "待办（[x] 表示完成，每行一项）", task?.todos.map((item) => `${item.completed ? "[x]" : "[ ]"} ${item.text}`).join("\n"), 15030)}</div></details></div>
      </div>
      ${task ? `<div id="context-view-sources" role="tabpanel" aria-labelledby="context-tab-sources" data-view="sources" hidden><h3>任务资料 · ${task.sources.length} 个</h3><p class="saved-hint">勾选本次交给 AI 的资料；默认不选。笔记和片段由你手动提供，插件不会读取网页正文。</p>
        <div class="context-sources">${task.sources.map((source, index) => `<div class="context-source" data-source-id="${e(source.id)}">
        <label><input type="checkbox" data-model-source value="${e(source.id)}"><span><a href="${e(source.url)}" target="_blank" rel="noopener noreferrer">${index + 1}. ${e(source.title)}</a>
        <small>${e(new URL(source.url).hostname)}</small></span></label>
        <details><summary>编辑资料笔记与片段</summary><label>资料笔记<textarea data-source-note maxlength="1000" rows="2">${e(source.note)}</textarea></label>
        <label>手动提供的片段<textarea data-source-excerpt maxlength="2000" rows="3">${e(source.excerpt)}</textarea></label>
        <label><input type="checkbox" data-source-remove>保存时移除此资料</label></details></div>`).join("") || '<p class="saved-hint">暂无资料，也可以只根据已记录的进度生成续接草稿。</p>'}</div>
        <div class="saved-actions"><button type="button" data-context="sources">选择资料加入任务</button>
        <button type="button" data-context="related-sources" ${task.sources.length ? "" : "disabled"}>推荐相关打开页面</button>
        <button type="button" data-context="workspace" ${task.workspaceId ? "" : "disabled"}>打开默认工作区</button>
        <button type="button" data-context="restore" ${task.sources.length ? "" : "disabled"}>选择资料继续</button></div><div class="context-picker" hidden></div></div>` : ""}
      <div class="context-savebar"><button class="primary-button" type="submit">${task ? "保存进度" : "创建任务"}</button>
        ${task ? '<button type="button" data-context="reload">重新读取</button><span>编辑后保存到本机</span>' : '<button type="button" data-context="close">取消创建</button>'}</div>
      </form>
      ${task ? `<div id="context-view-ai" role="tabpanel" aria-labelledby="context-tab-ai" data-view="ai" hidden>
        <h3>AI 任务续接</h3><p class="saved-hint">先核对将交给哪个模型的内容，再生成草稿。AI 判断仍需验证，采纳后会单独保存。</p>
        <ol class="flow-steps" aria-label="续接步骤"><li>预览输入</li><li>生成草稿</li><li>审阅采纳</li></ol>
        <p class="saved-hint"><span class="context-chosen">本次未选择资料，将仅使用任务记录。</span> <button type="button" data-context="choose-model-sources">选择本次资料</button></p>
        <div class="saved-actions"><button class="primary-button" type="button" data-context="preview">预览续接输入</button></div>
        <div class="context-preview"></div>
        <div class="saved-actions"><button class="primary-button" type="button" data-context="generate" disabled>生成续接草稿</button><button type="button" data-context="stop" hidden>停止生成</button></div>
        <div class="context-draft"></div>${accepted(task)}${handoffReview(task)}</div>
      ${task ? `<div id="context-view-evidence" role="tabpanel" aria-labelledby="context-tab-evidence" data-view="evidence" hidden>
        <h3>跨资料证据问答</h3><p class="saved-hint">只使用你勾选资料的标题、笔记和手动片段；不会读取网页正文。回答会标出引用与待核对项。</p>
        <label>问题<textarea data-evidence-question maxlength="800" rows="3" placeholder="例如：这些资料是否支持当前恢复方案？"></textarea></label>
        <fieldset class="context-evidence-sources"><legend>本次资料</legend>${task.sources.map((source, index) => `<label><input type="checkbox" data-evidence-source value="${e(source.id)}"><span>${index + 1}. ${e(source.title)}</span></label>`).join("") || "<p>请先在任务资料中添加页面。</p>"}</fieldset>
        <div class="saved-actions"><button type="button" class="primary-button" data-context="evidence-preview" ${task.sources.length ? "" : "disabled"}>预览问答输入</button></div>
        <div class="context-evidence-preview"></div><div class="saved-actions"><button type="button" class="primary-button" data-context="evidence-generate" disabled>生成证据回答</button><button type="button" data-context="evidence-stop" hidden>停止生成</button></div>
        <div class="context-evidence-draft"></div>
        <div class="context-evidence-history">${(task.evidenceAnswers || []).map((item) => `<article><strong>${e(item.question)}</strong><p>${e(item.answer)}</p><small>${item.sourceIds.length ? reference(task, item.sourceIds) : "无可用资料引用"}${item.uncertainties.length ? ` · 待核对：${e(item.uncertainties.join("；"))}` : ""}${item.stale ? " · 资料已变化" : ""}</small></article>`).join("")}</div>
      </div>` : ""}
        <details class="context-handoff"><summary>导出与交接</summary><p class="saved-hint">复制或下载包含原始网址的上下文包，交给 AI 对话或 IDE。任务仅保存在本机。</p>
        <div class="saved-actions"><button type="button" data-context="copy">复制 Markdown</button><button type="button" data-context="markdown">下载 Markdown</button>
        <button type="button" data-context="json">导出任务 JSON</button><button type="button" data-context="archive">${task.status === "archived" ? "取消归档" : "归档任务"}</button></div>
        <details><summary>删除任务记忆</summary><p>删除此任务及其笔记和草稿，已打开的页面保持打开。</p>
        <label><input type="checkbox" data-delete-confirm>我确认删除此任务记忆</label><div class="saved-actions"><button type="button" data-context="delete">删除任务记忆</button></div></details></details>` : ""}`;
    if (task) createNavigation(editor, { initial: currentView || "progress" });
    if (handoffOpen) editor.querySelector(".context-handoff").open = true;
    drawList();
    if (sameTask) window.scrollTo({ top: scrollPosition, behavior: "instant" });
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
  const previewEvidence = async () => {
    clean(); reset();
    const question = editor.querySelector("[data-evidence-question]").value;
    const sourceIds = [...editor.querySelectorAll("[data-evidence-source]:checked")].map((input) => input.value);
    const result = await send("prepareEvidenceAnswer", { taskId: task.id, question, sourceIds });
    evidencePrepared = result;
    editor.querySelector(".context-evidence-preview").innerHTML = `<details open><summary>本次交给模型的问答输入</summary>
      <p>接收方：${e(result.provider === "browser" ? "浏览器内置模型" : `${result.provider} · ${result.model}`)}</p>
      <p>问题：${e(result.snapshot.input.question)}</p>${result.snapshot.input.sources.map((source) =>
        `<p><strong>${e(source.title)}</strong> · ${e(source.domain)}<br>笔记：${e(source.note || "无")}<br>片段：${e(source.excerpt || "无")}</p>`).join("")}
      <p>只发送以上资料，不含完整网址或网页正文。预览 10 分钟有效。</p></details>`;
    editor.querySelector('[data-context="evidence-generate"]').disabled = false;
    notice("问答输入已准备，请核对后生成。");
  };
  const showEvidence = () => {
    const citations = reference(task, evidenceDraft.sourceIds);
    editor.querySelector(".context-evidence-draft").innerHTML = `<h3>审阅证据回答</h3>
      <label>回答<textarea data-evidence-answer maxlength="2400" rows="5">${e(evidenceDraft.answer)}</textarea></label>
      <p class="context-citations">${citations}</p>
      <p>待核对：${e(evidenceDraft.uncertainties.join("；") || "无")}</p>
      <label class="context-confirm"><input type="checkbox" data-evidence-confirm>我已审阅，保存这条证据回答</label>
      <div class="saved-actions"><button type="button" data-context="evidence-save">保存证据回答</button></div>`;
  };
  const generateEvidence = async () => {
    if (!evidencePrepared || busy) return;
    const current = version, input = evidencePrepared;
    busy = true; controller = new AbortController();
    port = chrome.runtime.connect({ name: "tabwise-context-ai" });
    const activePort = port;
    port.postMessage({ snapshotId: input.snapshot.id });
    editor.querySelector('[data-context="evidence-generate"]').disabled = true;
    editor.querySelector('[data-context="evidence-stop"]').hidden = false;
    notice("正在生成证据回答…");
    let activeSession;
    try {
      let result;
      if (input.provider !== "browser") result = await send("generateEvidenceAnswer", { snapshotId: input.snapshot.id });
      else {
        await send("beginEvidenceAnswer", { snapshotId: input.snapshot.id });
        activeSession = await createLocalModel();
        if (current !== version) return;
        session = activeSession;
        const answer = await activeSession.prompt(input.prompt, { responseConstraint: input.schema, signal: controller.signal });
        if (current !== version) return;
        result = await send("acceptEvidenceAnswer", { snapshotId: input.snapshot.id, answer });
      }
      if (current !== version) return;
      evidenceDraft = result.evidence; showEvidence(); notice("证据回答已生成，请核对引用与待核对项。");
    } catch (error) {
      if (current === version) { reset(); notice(`${error.message} 请重新预览后重试。`, true); }
    } finally {
      activeSession?.destroy?.(); activePort.disconnect();
      if (current === version) {
        busy = false; controller = session = port = null;
        editor.querySelector('[data-context="evidence-stop"]').hidden = true;
      }
    }
  };
  const openPicker = async (initialKind = "current") => {
    clean(); const hostPicker = editor.querySelector(".context-picker");
    sourceSelection?.destroy(); sourceSelection = null;
    hostPicker.hidden = false;
    hostPicker.innerHTML = `<h3>选择资料</h3><label>资料范围<select data-source-kind><option value="current">当前窗口</option><option value="related">与任务资料相关的打开页面</option><option value="workspace">已保存工作区</option></select></label>
      <label data-source-workspace-label hidden>工作区<select data-source-workspace>${workspaces.map((item) => `<option value="${e(item.id)}">${e(item.name)}</option>`).join("")}</select></label>
      <div class="saved-actions"><button type="button" data-context="source-preview">读取资料列表</button><button type="button" data-context="source-close">取消</button></div>
      <p class="saved-hint">仅列出所选范围的标题和网址，不打开页面。勾选资料后明确加入此任务。</p>
      <div class="context-source-picker"></div><div class="saved-actions"><button type="button" data-context="attach" disabled>将选定资料加入任务</button></div>`;
    hostPicker.querySelector("[data-source-kind]").value = initialKind;
    hostPicker.querySelector("[data-source-workspace-label]").hidden = initialKind !== "workspace";
    picker = null;
  };
  editor.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (writing) return;
    const form = event.target, current = version;
    const invalid = [...form.elements].find((input) => input.validity && !input.validity.valid);
    if (invalid) { revealElement(invalid); invalid.reportValidity(); notice("请填写任务名称和目标，再保存进度。", true); return; }
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
      const selected = [...editor.querySelectorAll("[data-model-source]:checked")].map((input) => input.value);
      const destination = editor.querySelector('[role="tab"][aria-selected="true"]')?.dataset.viewButton;
      renderEditor(result.task);
      for (const input of editor.querySelectorAll("[data-model-source]")) input.checked = selected.includes(input.value);
      const count = editor.querySelectorAll("[data-model-source]:checked").length;
      editor.querySelector(".context-chosen").textContent = count ? `本次已选 ${count} 个资料。` : "本次未选择资料，将仅使用任务记录。";
      if (destination) revealElement(editor.querySelector(`[data-view="${destination}"]`));
      await refreshList(); notice("任务进度已保存在本地。");
    } catch (error) { notice(error.message, true); }
    finally { writing = false; unlock(); }
  });
  host.addEventListener("input", (event) => {
    if (event.target.matches(".context-search input")) { drawList(); return; }
    if (event.target.closest(".context-picker")) return;
    if (event.target.matches("[data-evidence-source], [data-evidence-question]")) {
      if (evidencePrepared) send("cancelEvidenceAnswer", { snapshotId: evidencePrepared.snapshot.id }).catch(() => {});
      evidencePrepared = evidenceDraft = null;
      editor.querySelector(".context-evidence-preview")?.replaceChildren();
      editor.querySelector(".context-evidence-draft")?.replaceChildren();
      if (editor.querySelector('[data-context="evidence-generate"]')) editor.querySelector('[data-context="evidence-generate"]').disabled = true;
      return;
    }
    if (event.target.closest(".context-form")) {
      if (event.target.matches("[data-model-source]")) {
        reset();
        const count = editor.querySelectorAll("[data-model-source]:checked").length;
        editor.querySelector(".context-chosen").textContent = count ? `本次已选 ${count} 个资料。` : "本次未选择资料，将仅使用任务记录。";
        return;
      }
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
      if (action === "stop" || action === "evidence-stop") { reset(); notice("生成已停止，请重新预览。"); return; }
      if (action === "reload") {
        await refreshList(); const fresh = tasks.find((item) => item.id === task?.id);
        if (fresh) renderEditor(fresh); notice("已重新读取本地记录。"); return;
      }
      if (action === "choose-model-sources") { revealElement(editor.querySelector("#context-view-sources")); return; }
      if (action === "back") { clean(); reset(); editor.hidden = true; host.querySelector(".context-browser").open = true; drawList(); notice(""); return; }
      if (action === "close") { reset(); editor.hidden = true; dirty = false; host.querySelector(".context-browser").open = true; notice(""); return; }
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
      if (action === "sources") { revealElement(editor.querySelector("#context-view-sources")); return await openPicker(); }
      if (action === "related-sources") { revealElement(editor.querySelector("#context-view-sources")); return await openPicker("related"); }
      if (action === "source-close") { editor.querySelector(".context-picker").hidden = true; picker = null; return; }
      if (action === "source-preview") {
        const current = version;
        const kind = editor.querySelector("[data-source-kind]").value;
        const result = await send("prepareContextSources", { kind, taskId: kind === "related" ? task.id : undefined,
          workspaceId: editor.querySelector("[data-source-workspace]").value });
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
        renderEditor(result.task); revealElement(editor.querySelector("#context-view-sources")); await refreshList(); notice("选定资料已加入任务，相同网址只保留一次。"); return;
      }
      if (action === "restore") return await restoreUI.open("context", task.id);
      if (action === "workspace") return await restoreUI.open("workspace", task.workspaceId);
      if (action === "preview") return await preview();
      if (action === "generate") return await generate();
      if (action === "evidence-preview") return await previewEvidence();
      if (action === "evidence-generate") return await generateEvidence();
      if (action === "evidence-save") {
        if (!evidenceDraft || !evidencePrepared) return;
        const evidence = { ...evidenceDraft, answer: editor.querySelector("[data-evidence-answer]").value };
        const result = await send("saveEvidenceAnswer", { snapshotId: evidencePrepared.snapshot.id, evidence,
          confirm: editor.querySelector("[data-evidence-confirm]").checked });
        renderEditor(result.task); revealElement(editor.querySelector("#context-view-evidence")); await refreshList();
        notice("证据回答已保存到本地任务。"); return;
      }
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
        reset(); task = null; dirty = false; editor.hidden = true; host.querySelector(".context-browser").open = true; await refreshList(); notice("任务记忆已删除。");
      }
    } catch (error) { notice(error.message, true); }
    finally { if (unlock) { writing = false; unlock(); } }
  });
  window.addEventListener("pagehide", reset);
  return { update: () => refreshList().catch((error) => notice(error.message, true)) };
}
