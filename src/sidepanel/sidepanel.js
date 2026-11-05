import { escapeHtml } from "../shared/html.js";
import { createRestoreUI, createWorkspaceUI } from "../shared/workspace-ui.js";
import { createRefresh, connectLiveUI, updateHTML } from "../shared/live-ui.js";
import { createSessionUI } from "../shared/session-ui.js";
import { createTaskUI } from "../shared/task-ui.js";
import { createBudgetUI } from "../shared/budget-ui.js";

const $ = (selector) => document.querySelector(selector);
let searchTimer;
let searchVersion = 0;
let dashboard;
let aiPrepared;
let aiVersion = 0;
let aiBusy = false;
let aiWorkspaces = [];
let aiController;
let aiSession;
let aiPort;
const loadDashboard = createRefresh(refreshDashboard);
const restoreUI = createRestoreUI($("#restore-preview"), setFeedback, loadDashboard);
const workspaceUI = createWorkspaceUI($("#workspace-manager"), restoreUI, setFeedback, loadDashboard);
const sessionUI = createSessionUI($("#session-tools"), restoreUI, setFeedback, loadDashboard);
const taskUI = createTaskUI($("#restore-tasks"), setFeedback, loadDashboard);
const budgetUI = createBudgetUI($("#resource-budget"), setFeedback, loadDashboard);

function resetAi() {
  if (aiPrepared) chrome.runtime.sendMessage({ type: "cancelAiGeneration", snapshotId: aiPrepared.snapshot.id }).catch(() => {});
  aiController?.abort();
  aiSession?.destroy?.();
  aiPort?.disconnect();
  aiBusy = false;
  $("#stop-ai").hidden = true;
  $("#preview-ai-input").disabled = false;
  $("#ai-status").textContent = "请重新预览";
  aiVersion += 1;
  aiPrepared = null;
  $("#ai-input-preview").hidden = true;
  $("#generate-ai-brief").disabled = true;
  $("#ai-brief").className = "ai-brief empty-state";
  $("#ai-brief").textContent = "分析范围已更新，请预览输入后生成建议。";
}

function renderAiSources() {
  const workspaceId = $("#ai-workspace").value;
  updateHTML($("#ai-workspace"), aiWorkspaces.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${item.archived ? " · 已归档" : ""}</option>`).join("")
    || '<option value="">暂无工作区</option>');
  if (aiWorkspaces.some((item) => item.id === workspaceId)) $("#ai-workspace").value = workspaceId;
  const selected = new Set([...$("#ai-tab-options").querySelectorAll("input:checked")].map((input) => input.value));
  updateHTML($("#ai-tab-options"), dashboard.tabs.filter((tab) => !tab.incognito && /^https?:\/\//.test(tab.url))
    .map((tab) => `<label class="ai-page"><input type="checkbox" value="${tab.id}" ${selected.has(String(tab.id)) ? "checked" : ""}>
      <span><strong>${escapeHtml(tab.title)}</strong><small>${escapeHtml(tab.domain)} · 窗口 ${tab.windowId}</small></span></label>`).join("") || "暂无可选择的网页。");
  $("#ai-workspace-field").hidden = $("#ai-scope").value !== "workspace";
  $("#ai-selection").hidden = $("#ai-scope").value !== "selected";
}

const aiStateLabel = (state) => ({ open: "已打开", protected: "已保护", suspended: "休眠中", saved: "已保存" }[state] || state);

function relativeTime(timestamp) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1_440)} 天前`;
}

function setFeedback(message = "", isError = false) {
  const feedback = $("#feedback");
  feedback.textContent = message;
  feedback.classList.toggle("is-error", isError);
}

function pageRow(page) {
  const sourceLabels = { open: "打开页面", suspended: "休眠记录", workspace: "工作区", checkpoint: "恢复点", closed: "最近关闭" };
  const sources = [...new Set((page.sources || [page]).map((item) => item.workspaceName ? `工作区：${item.workspaceName}` : sourceLabels[item.source] || item.source))];
  const state = {
    open: "已打开",
    suspended: "休眠中",
    saved: "已保存",
    protected: "已保护"
  }[page.status] || page.source;
  return `<article class="result">
    <div class="result-copy">
      <strong title="${escapeHtml(page.title)}">${escapeHtml(page.title)}</strong>
      <span title="${escapeHtml(page.url)}">${escapeHtml(page.domain || page.url)}</span>
      <span>${escapeHtml(sources.join(" · "))}</span>
    </div>
    <span class="badge">${escapeHtml(state)}</span>
    <button class="action-button" data-action="open-result" data-result="${escapeHtml(JSON.stringify(page))}" type="button">打开</button>
  </article>`;
}

function candidateRow(candidate) {
  const tab = dashboard.tabs.find((item) => item.id === candidate.tabId);
  if (!tab) return "";
  return `<article class="result">
    <div class="result-copy">
      <strong title="${escapeHtml(tab.title)}">${escapeHtml(tab.title)}</strong>
      <span>${escapeHtml([candidate.explanation, candidate.estimatedJSHeap ? `预计释放 ${formatMemory(candidate.estimatedJSHeap)}` : ""].filter(Boolean).join(" · "))}</span>
    </div>
    <button class="action-button" data-action="suspend" data-tab-id="${tab.id}" type="button">休眠</button>
  </article>`;
}

function formatMemory(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "未知";
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function rendererRow(renderer) {
  const pages = renderer.tabs.map((tab) => tab.title).join("、");
  const isHeap = renderer.kind === "heap";
  const label = isHeap ? "网页 JS 堆（估算）" : `Renderer ${renderer.processId}`;
  const detail = isHeap
    ? `已分配 ${formatMemory(renderer.jsMemoryAllocated)}`
    : `${renderer.tabCount > 1 ? `${renderer.tabCount} 个网页共享` : "1 个网页"} · JS ${formatMemory(renderer.jsMemoryUsed)}`;
  const value = isHeap ? formatMemory(renderer.jsMemoryUsed) : formatMemory(renderer.privateMemory);
  return `<article class="result">
    <div class="result-copy">
      <strong title="${escapeHtml(pages)}">${escapeHtml(pages)}</strong>
      <span>${label} · ${detail}</span>
    </div>
    <span class="resource-value">${value}</span>
  </article>`;
}

function reviewRow(review) {
  const memory = review.reclaimableMeasuredTabs ? `预计 ${formatMemory(review.reclaimableJSHeap)}` : "暂无内存估算";
  const organization = [`${review.candidateCount || 0} 项建议`, review.duplicateCount ? `${review.duplicateCount} 个重复页` : "", review.archivedWorkspaceCount ? `归档 ${review.archivedWorkspaceCount} 个工作区` : ""].filter(Boolean).join(" · ");
  const status = review.status || "completed";
  const labels = { completed: "已完成", running: "运行中", failed: "失败", interrupted: "后台中断" };
  return `<article class="timeline-item review-entry">
    <span class="timeline-kind">${review.trigger === "scheduled" ? "定时" : review.trigger === "retry" ? "重试" : "手动"}</span>
    <div><strong>${relativeTime(review.createdAt)}巡检 · ${labels[status] || status}</strong>
    <span>${review.checkpointTabCount || 0} 页恢复点 · ${organization} · ${memory}${review.durationMs != null ? ` · ${(review.durationMs / 1000).toFixed(1)} 秒` : ""}${review.caughtUp ? " · 离线后补跑" : ""}</span>
    ${review.stage && status !== "completed" ? `<span>阶段：${escapeHtml(review.stage)}</span>` : ""}
    ${review.error ? `<span class="review-error">${escapeHtml(review.error)}</span>` : ""}</div>
    ${["failed", "interrupted"].includes(status) ? `<button class="quiet-button" data-action="retry-review" data-id="${escapeHtml(review.id)}" type="button">重试</button>` : ""}
  </article>`;
}

function renderDiagnostics(result) {
  const container = $("#renderer-diagnostics");
  if (!result?.ok) {
    container.className = "results empty-state";
    container.textContent = result?.reason || "浏览器未提供 Renderer 内存数据。";
    return;
  }
  container.className = result.renderers.length ? "results" : "results empty-state";
  container.innerHTML = result.renderers.map(rendererRow).join("") || "没有可测量的网页 Renderer。";
}

async function refreshDashboard() {
  const [data, workspaces, trash, recent, checkpoints, reviews, operations, closed] = await Promise.all([
    chrome.runtime.sendMessage({ type: "getDashboard" }), chrome.runtime.sendMessage({ type: "getWorkspaces" }),
    chrome.runtime.sendMessage({ type: "getWorkspaceTrash" }), chrome.runtime.sendMessage({ type: "getRecentSuspensions" }),
    chrome.runtime.sendMessage({ type: "getRecoveryCheckpoints" }), chrome.runtime.sendMessage({ type: "getResourceReviews" }),
    chrome.runtime.sendMessage({ type: "getOperations" }), chrome.runtime.sendMessage({ type: "getClosedPages" })
  ]);
  dashboard = data;
  budgetUI.update(data.budget);
  aiWorkspaces = workspaces;
  workspaceUI.setData(aiWorkspaces, trash, await chrome.runtime.sendMessage({ type: "getWorkspaceBindings" }));
  sessionUI.setData(checkpoints, closed, data.settings);
  await Promise.all([taskUI.update(), restoreUI.update()]);
  for (const [selector, html] of [
    ["#search-window", [...new Set(data.tabs.map((tab) => tab.windowId))].map((id) => `<option value="${id}">窗口 ${id}</option>`).join("")],
    ["#search-workspace", workspaces.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")]
  ]) {
    const select = $(selector), value = select.value;
    updateHTML(select, `<option value="">全部${selector.endsWith("window") ? "窗口" : "工作区"}</option>` + html);
    if ([...select.options].some((item) => item.value === value)) select.value = value;
  }
  renderAiSources();
  const { summary, settings } = dashboard;
  $("#state").textContent = settings.autoSuspend
    ? `自动休眠开启 · ${settings.idleMinutes} 分钟阈值`
    : `${summary.unloaded} 个页面处于休眠`;
  $("#overview-eligible").textContent = summary.eligible;
  $("#overview-suspended").textContent = summary.unloaded;
  $("#overview-heap").textContent = formatMemory(summary.jsHeapUsage);
  $("#sampling-coverage").textContent = `已采样 ${summary.jsHeapMeasuredTabs} / ${summary.jsHeapEligibleTabs} 个网页。每分钟轮转最多 25 页，同时测量不超过 4 页；立即更新可采样全部。JS 堆为估算值。`;
  if (!aiPrepared && !aiBusy) $("#ai-status").textContent = settings.aiProvider === "ollama" ? "Ollama" : "浏览器内置";
  $("#measure-resources").textContent = "立即更新";
  $("#candidate-count").textContent = dashboard.candidates.length ? `${dashboard.candidates.length} 项` : "无";
  $("#reclaim-summary").textContent = dashboard.summary.reclaimableMeasuredTabs
    ? `${dashboard.candidates.length} 个候选中，有 ${dashboard.summary.reclaimableMeasuredTabs} 个已采样；预计可释放 ${formatMemory(dashboard.summary.reclaimableJSHeap)} JS 堆。`
    : "仅显示已经通过当前保护策略和闲置阈值检查的页面。";
  $("#candidates").className = dashboard.candidates.length ? "results" : "results empty-state";
  updateHTML($("#candidates"), dashboard.candidates.map(candidateRow).join("") || "目前没有可自动休眠的页面。");
  const labels = { ready: "可撤销", pending: "操作未完成", undoing: "撤销未完成", undone: "已撤销", partial: "部分已撤销", conflict: "状态冲突" };
  $("#operations").className = operations.length ? "timeline" : "timeline empty-state";
  updateHTML($("#operations"), operations.map((entry) => `<article class="operation-item">
    <div><strong>${escapeHtml(entry.label)}</strong><small>${relativeTime(entry.createdAt)} · ${labels[entry.status] || entry.status}</small>
    ${(entry.results || []).map((result) => `<p class="${result.ok ? "" : "is-error"}">${escapeHtml(result.reason)}</p>`).join("")}</div>
    ${entry.status === "ready" ? `<button class="quiet-button" data-undo="${entry.id}" type="button">撤销</button>` : ""}</article>`).join("") || "操作后可在这里撤销。");
  $("#review-schedule").textContent = settings.scheduledReviewEnabled
    ? `每天 ${String(settings.scheduledReviewHour).padStart(2, "0")}:${String(settings.scheduledReviewMinute || 0).padStart(2, "0")} 保存恢复点并巡检资源${settings.scheduledArchiveEnabled ? `；${settings.scheduledArchiveDays} 天未打开的工作区将归档` : ""}；错过运行后补跑一次。`
    : "定时巡检已关闭；可随时手动运行，巡检不会自动休眠页面。";
  $("#resource-reviews").className = reviews.length ? "timeline" : "timeline empty-state";
  updateHTML($("#resource-reviews"), reviews.map(reviewRow).join("") || "暂无资源巡检记录。");
  const timeline = [
    ...recent.slice(0, 3).map((record) => ({
      kind: "休眠",
      title: record.title || record.originalUrl,
      description: `${new URL(record.originalUrl).hostname} · ${relativeTime(record.suspendedAt)}`,
      at: record.suspendedAt,
      action: "restore-recent",
      id: record.recordId
    })),
    ...checkpoints.slice(0, 3).map((checkpoint) => ({
      kind: "恢复点",
      title: `${checkpoint.tabs.length} 个页面`,
      description: relativeTime(checkpoint.createdAt),
      at: checkpoint.createdAt,
      action: "restore-checkpoint",
      id: checkpoint.id
    }))
  ].sort((left, right) => right.at - left.at);
  $("#timeline").className = timeline.length ? "timeline" : "timeline empty-state";
  updateHTML($("#timeline"), timeline.map((entry) => `<article class="timeline-item">
    <span class="timeline-kind">${escapeHtml(entry.kind)}</span>
    <div><strong>${escapeHtml(entry.title)}</strong><span>${escapeHtml(entry.description)}</span></div>
    <button class="quiet-button" data-action="${entry.action}" data-id="${escapeHtml(entry.id)}" type="button">打开</button>
  </article>`).join("") || "恢复点和最近休眠记录会显示在这里。");
  await search();
}

async function search() {
  const version = ++searchVersion;
  const query = $("#page-search").value.trim();
  if (!query) {
    $("#search-results").className = "results empty-state";
    $("#search-results").textContent = "输入关键词开始查找。";
    return;
  }
  const results = await chrome.runtime.sendMessage({ type: "searchPages", query, limit: 30, deduplicate: true,
    source: $("#search-source").value, status: $("#search-status").value, windowId: $("#search-window").value, workspaceId: $("#search-workspace").value });
  if (version !== searchVersion) return;
  $("#search-results").className = results.length ? "results" : "results empty-state";
  updateHTML($("#search-results"), results.map(pageRow).join("") || "未找到匹配的本地页面记录。");
}

$("#page-search").addEventListener("input", () => {
  searchVersion++;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => search().catch((error) => setFeedback(error.message, true)), 120);
});
document.querySelectorAll(".search-filters select").forEach((select) => select.addEventListener("change", () => {
  searchVersion++; search().catch((error) => setFeedback(error.message, true));
}));

document.body.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  button.disabled = true;
  try {
    let result;
    if (button.dataset.action === "open-result") result = await chrome.runtime.sendMessage({ type: "openSearchResult", result: JSON.parse(button.dataset.result) });
    if (button.dataset.action === "suspend") result = await chrome.runtime.sendMessage({ type: "directSuspendTab", tabId: Number(button.dataset.tabId) });
    if (button.dataset.action === "restore-recent") result = await chrome.runtime.sendMessage({ type: "restoreRecentSuspension", recordId: button.dataset.id });
    if (button.dataset.action === "restore-checkpoint") {
      await restoreUI.open("checkpoint", button.dataset.id);
      return;
    }
    if (button.dataset.action === "retry-review") result = await chrome.runtime.sendMessage({ type: "retryResourceReview", reviewId: button.dataset.id });
    setFeedback(result?.ok ? "操作已完成" : result?.reason || "操作未完成", !result?.ok);
    await loadDashboard();
  } catch (error) {
    setFeedback(error.message || "操作未完成", true);
  } finally {
    button.disabled = false;
  }
});

$("#save-workspace").addEventListener("click", () => {
  $("#save-workspace-form").hidden = !$("#save-workspace-form").hidden;
  if (!$("#save-workspace-form").hidden) $("#save-workspace-form input").focus();
});
$("#save-workspace-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "saveWorkspace", name: form.elements.name.value });
    if (!result?.id) throw new Error(result?.reason || "无法保存工作区。");
    form.reset(); form.hidden = true;
    setFeedback("已保存当前窗口");
    await loadDashboard();
  } catch (error) { setFeedback(error.message, true); }
  finally { button.disabled = false; }
});

$("#save-checkpoint").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "createRecoveryCheckpoint" });
  setFeedback(result?.ok ? `已保存 ${result.count} 个页面` : result?.reason, !result?.ok);
  await loadDashboard();
});
$("#measure-resources").addEventListener("click", async () => {
  const button = $("#measure-resources");
  button.disabled = true;
  try {
    let result = await chrome.runtime.sendMessage({ type: "getResourceDiagnostics" });
    renderDiagnostics(result);
    setFeedback(result.ok ? "已采集一次网页内存快照" : result.reason, !result.ok);
  } catch {
    const result = { ok: false, reason: "当前浏览器无法读取网页内存。" };
    renderDiagnostics(result);
    setFeedback(result.reason, true);
  } finally {
    button.disabled = false;
  }
});

$("#run-resource-review").addEventListener("click", async () => {
  const button = $("#run-resource-review");
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "runResourceReview" });
    setFeedback(result?.ok ? `已完成巡检并保存 ${result.review.checkpointTabCount} 页恢复点` : result?.reason || "资源巡检未完成", !result?.ok);
    await loadDashboard();
  } finally {
    button.disabled = false;
  }
});

async function createLocalModel() {
  const Model = globalThis.LanguageModel;
  if (!Model?.availability || !Model?.create) throw new Error("当前 Chrome 未提供本地 AI 模型。");
  const availability = await Model.availability();
  if (!["available", "readily"].includes(availability)) {
    throw new Error(availability === "downloadable" || availability === "downloading"
      ? "浏览器正在准备本地模型，请稍后重试。"
      : "当前浏览器或管理员策略未启用本地 AI 模型。");
  }
  return Model.create({ temperature: 0.2, topK: 3 });
}

$("#ai-scope").addEventListener("change", () => { resetAi(); renderAiSources(); });
$("#ai-workspace").addEventListener("change", resetAi);
$("#ai-request").addEventListener("input", resetAi);
$("#ai-tab-options").addEventListener("change", resetAi);
$("#refresh-ai-sources").addEventListener("click", () => {
  resetAi();
  loadDashboard().catch((error) => setFeedback(error.message, true));
});

$("#preview-ai-input").addEventListener("click", async () => {
  if (aiBusy) return;
  resetAi();
  const version = aiVersion;
  const button = $("#preview-ai-input");
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: "prepareAiAnalysis", scope: $("#ai-scope").value, workspaceId: $("#ai-workspace").value,
      tabIds: [...$("#ai-tab-options").querySelectorAll("input:checked")].map((input) => Number(input.value)),
      request: $("#ai-request").value
    });
    if (version !== aiVersion) return;
    if (!result?.ok) throw new Error(result?.reason || "无法准备分析输入。");
    aiPrepared = result;
    const { snapshot } = result;
    $("#ai-input-summary").textContent = `${snapshot.pages.length} 页 · 接收方：${snapshot.recipient}`;
    $("#ai-input-pages").innerHTML = snapshot.pages.map((page) => `<div class="ai-page"><span>
      <strong>${page.pageId}. ${escapeHtml(page.title)}</strong><small>${escapeHtml(page.domain)} · ${escapeHtml(aiStateLabel(page.status))}</small></span></div>`).join("");
    $("#ai-input-preview").hidden = false;
    $("#generate-ai-brief").disabled = false;
    $("#ai-brief").textContent = "请核对以上输入，然后生成主题建议。";
  } catch (error) {
    if (version === aiVersion) $("#ai-brief").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

function renderAiPlan(plan, snapshot) {
  const output = $("#ai-brief");
  output.className = "ai-brief ai-themes";
  output.innerHTML = plan.groups.map((group, index) => `<article class="ai-theme" data-group-index="${index}">
    <label class="ai-request-field"><span>主题名称</span><input class="ai-theme-name" maxlength="80" value="${escapeHtml(group.name)}"></label>
    <p class="ai-reason">归类依据：${escapeHtml(group.reason)}</p>
    <fieldset class="ai-members"><legend>主题成员（可取消勾选）</legend>${group.pageIds.map((id) => {
      const page = snapshot.pages.find((item) => item.pageId === id);
      return `<label class="ai-page"><input type="checkbox" value="${id}" checked><span><strong>${id}. ${escapeHtml(page.title)}</strong><small>${escapeHtml(page.domain)} · ${escapeHtml(aiStateLabel(page.status))}</small></span></label>`;
    }).join("")}</fieldset>
    <div class="ai-actions">
      <button class="action-button" data-ai-action="group" type="button" ${snapshot.scope === "workspace" || group.pageIds.length < 2 ? "disabled" : ""}>建立标签组</button>
      <button class="action-button" data-ai-action="save" type="button">保存为工作区</button>
    </div>
    <div class="ai-confirmation" hidden><p></p><div class="ai-actions"><button class="action-button" data-ai-action="confirm" type="button">确认应用</button><button class="quiet-button" data-ai-action="cancel" type="button">取消</button></div></div>
    <p class="ai-group-feedback" role="status"></p>
  </article>`).join("") || "未找到有可靠依据的主题。可以调整范围或整理目标后重新生成。";
}

$("#generate-ai-brief").addEventListener("click", async () => {
  if (!aiPrepared || aiBusy) return;
  const prepared = aiPrepared;
  const version = aiVersion;
  const button = $("#generate-ai-brief");
  const output = $("#ai-brief");
  button.disabled = true;
  aiBusy = true;
  const controller = new AbortController();
  aiController = controller;
  const port = chrome.runtime.connect({ name: "tabwise-ai" });
  port.postMessage({ snapshotId: prepared.snapshot.id });
  aiPort = port;
  $("#stop-ai").hidden = false;
  $("#preview-ai-input").disabled = true;
  $("#ai-status").textContent = "生成中";
  output.className = "ai-brief";
  output.textContent = "正在通过本地模型整理网页元数据…";
  let session;
  try {
    let result;
    if (prepared.provider === "ollama") {
      result = await chrome.runtime.sendMessage({ type: "generateAiThemes", snapshotId: prepared.snapshot.id });
    } else {
      result = await chrome.runtime.sendMessage({ type: "beginAiGeneration", snapshotId: prepared.snapshot.id });
      if (version !== aiVersion) return;
      if (!result?.ok) throw new Error(result?.reason);
      if (!result.cached) {
        session = await createLocalModel();
        if (version !== aiVersion) return;
        aiSession = session;
        const answer = await session.prompt(prepared.prompt, { responseConstraint: prepared.schema, signal: controller.signal });
        if (version !== aiVersion) return;
        result = await chrome.runtime.sendMessage({ type: "acceptAiPlan", snapshotId: prepared.snapshot.id, answer });
      }
    }
    if (version !== aiVersion) return;
    if (!result?.ok) throw new Error(result?.reason || "未能生成主题建议。");
    renderAiPlan(result.plan, prepared.snapshot);
    $("#ai-status").textContent = result.cached ? "缓存 · 已重新校验" : "结构已校验";
  } catch (error) {
    if (version !== aiVersion) return;
    output.className = "ai-brief empty-state";
    output.textContent = `${error.message || "无法生成本地 AI 建议。"} 可重新预览后重试；本地搜索和 Popup 的按域名整理仍可使用。`;
    $("#ai-status").textContent = "不可用";
  } finally {
    session?.destroy?.();
    port.disconnect();
    if (aiPort === port) aiPort = null;
    if (aiController === controller) { aiController = null; aiSession = null; }
    if (version === aiVersion) {
      aiBusy = false;
      $("#stop-ai").hidden = true;
      $("#preview-ai-input").disabled = false;
      button.disabled = true;
    }
  }
});

$("#stop-ai").addEventListener("click", () => {
  resetAi();
  $("#ai-brief").textContent = "生成已停止，请重新预览后再试。";
});
$("#clear-ai-cache").addEventListener("click", async () => {
  resetAi();
  const result = await chrome.runtime.sendMessage({ type: "clearAiCache" });
  $("#ai-brief").textContent = result?.ok ? "建议缓存已清空，下次生成将重新调用模型。" : result?.reason;
});
window.addEventListener("pagehide", () => {
  aiController?.abort();
  aiSession?.destroy?.();
  if (aiPrepared) chrome.runtime.sendMessage({ type: "cancelAiGeneration", snapshotId: aiPrepared.snapshot.id }).catch(() => {});
});
$("#operations").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-undo]");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "undoOperation", operationId: button.dataset.undo });
    setFeedback(result?.ok ? `已撤销 ${result.restored} 项；详情见操作记录。` : result?.reason, !result?.ok);
    await loadDashboard();
  } catch (error) { setFeedback(error.message, true); button.disabled = false; }
});
$("#ai-brief").addEventListener("input", (event) => {
  const theme = event.target.closest(".ai-theme");
  if (theme) theme.querySelector(".ai-confirmation").hidden = true;
});
$("#ai-brief").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-ai-action]");
  const theme = button?.closest(".ai-theme");
  if (!theme || !aiPrepared) return;
  const confirmation = theme.querySelector(".ai-confirmation");
  const feedback = theme.querySelector(".ai-group-feedback");
  const action = button.dataset.aiAction;
  if (action === "cancel") { confirmation.hidden = true; return; }
  const pageIds = [...theme.querySelectorAll(".ai-members input:checked")].map((input) => Number(input.value));
  const name = theme.querySelector(".ai-theme-name").value.trim();
  if (!name || !pageIds.length) { feedback.textContent = "请填写主题名并保留至少一个成员。"; feedback.classList.add("is-error"); return; }
  if (action !== "confirm") {
    confirmation.dataset.action = action;
    confirmation.querySelector("p").textContent = action === "save"
      ? `保存“${name}”为工作区，共 ${pageIds.length} 页；当前标签保持打开。`
      : `将 ${pageIds.length} 页加入标签组“${name}”；活动、固定和音频页面无法应用。`;
    confirmation.hidden = false;
    return;
  }
  const version = aiVersion;
  const applyAction = confirmation.dataset.action;
  const controls = [...theme.querySelectorAll("button, input")];
  const priorDisabled = controls.map((control) => control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  try {
    const result = await chrome.runtime.sendMessage({
      type: "applyAiGroup", snapshotId: aiPrepared.snapshot.id, groupIndex: Number(theme.dataset.groupIndex),
      action: applyAction, name, pageIds
    });
    if (version !== aiVersion) return;
    if (!result?.ok) throw new Error(result?.reason || "应用未完成。");
    theme.querySelector(`[data-ai-action="${applyAction}"]`).dataset.applied = "true";
    feedback.textContent = `${applyAction === "save" ? "已保存工作区" : "已建立标签组"} · ${result.count} 页`;
    feedback.classList.remove("is-error");
    await loadDashboard();
  } catch (error) {
    if (version === aiVersion) { feedback.textContent = error.message; feedback.classList.add("is-error"); }
  } finally {
    confirmation.hidden = true;
    controls.forEach((control, index) => { control.disabled = priorDisabled[index] || control.dataset.applied === "true"; });
  }
});
$("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

connectLiveUI(loadDashboard, (error) => setFeedback(error.message || "无法同步页面记忆", true));
loadDashboard().catch((error) => setFeedback(error.message || "无法读取页面记忆", true));
