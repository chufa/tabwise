import { escapeHtml } from "../shared/html.js";
import { buildLocalAiPrompt } from "../shared/insights.js";

const $ = (selector) => document.querySelector(selector);
let searchTimer;
let dashboard;

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
  const organization = [`${review.candidateCount} 项建议`, review.duplicateCount ? `${review.duplicateCount} 个重复页` : "", review.archivedWorkspaceCount ? `归档 ${review.archivedWorkspaceCount} 个工作区` : ""].filter(Boolean).join(" · ");
  return `<article class="timeline-item">
    <span class="timeline-kind">${review.trigger === "scheduled" ? "定时" : "手动"}</span>
    <div><strong>${relativeTime(review.createdAt)}巡检</strong><span>${review.checkpointTabCount} 页恢复点 · ${organization} · ${memory}</span></div>
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

async function loadDashboard() {
  dashboard = await chrome.runtime.sendMessage({ type: "getDashboard" });
  const { summary, settings } = dashboard;
  $("#state").textContent = settings.autoSuspend
    ? `自动休眠开启 · ${settings.idleMinutes} 分钟阈值`
    : `${summary.unloaded} 个页面处于休眠`;
  $("#overview-eligible").textContent = summary.eligible;
  $("#overview-suspended").textContent = summary.unloaded;
  $("#overview-heap").textContent = formatMemory(summary.jsHeapUsage);
  $("#ai-status").textContent = settings.aiProvider === "ollama" ? "Ollama" : "浏览器内置";
  $("#measure-resources").textContent = "立即更新";
  $("#candidate-count").textContent = dashboard.candidates.length ? `${dashboard.candidates.length} 项` : "无";
  $("#reclaim-summary").textContent = dashboard.summary.reclaimableMeasuredTabs
    ? `${dashboard.candidates.length} 个候选中，有 ${dashboard.summary.reclaimableMeasuredTabs} 个已采样；预计可释放 ${formatMemory(dashboard.summary.reclaimableJSHeap)} JS 堆。`
    : "仅显示已经通过当前保护策略和闲置阈值检查的页面。";
  $("#candidates").className = dashboard.candidates.length ? "results" : "results empty-state";
  $("#candidates").innerHTML = dashboard.candidates.map(candidateRow).join("") || "目前没有可自动休眠的页面。";

  const [recent, checkpoints, reviews] = await Promise.all([
    chrome.runtime.sendMessage({ type: "getRecentSuspensions" }),
    chrome.runtime.sendMessage({ type: "getRecoveryCheckpoints" }),
    chrome.runtime.sendMessage({ type: "getResourceReviews" })
  ]);
  $("#review-schedule").textContent = settings.scheduledReviewEnabled
    ? `每天 ${String(settings.scheduledReviewHour).padStart(2, "0")}:00 保存恢复点并巡检资源${settings.scheduledArchiveEnabled ? `；${settings.scheduledArchiveDays} 天未打开的工作区将归档` : ""}；不会自动休眠页面。`
    : "定时巡检已关闭；可随时手动运行，巡检不会自动休眠页面。";
  $("#resource-reviews").className = reviews.length ? "timeline" : "timeline empty-state";
  $("#resource-reviews").innerHTML = reviews.slice(0, 3).map(reviewRow).join("") || "暂无资源巡检记录。";
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
  $("#timeline").innerHTML = timeline.map((entry) => `<article class="timeline-item">
    <span class="timeline-kind">${escapeHtml(entry.kind)}</span>
    <div><strong>${escapeHtml(entry.title)}</strong><span>${escapeHtml(entry.description)}</span></div>
    <button class="quiet-button" data-action="${entry.action}" data-id="${escapeHtml(entry.id)}" type="button">打开</button>
  </article>`).join("") || "恢复点和最近休眠记录会显示在这里。";
}

async function search() {
  const query = $("#page-search").value.trim();
  if (!query) {
    $("#search-results").className = "results empty-state";
    $("#search-results").textContent = "输入关键词开始查找。";
    return;
  }
  const results = await chrome.runtime.sendMessage({ type: "searchPages", query, limit: 20 });
  $("#search-results").className = results.length ? "results" : "results empty-state";
  $("#search-results").innerHTML = results.map(pageRow).join("") || "未找到匹配的本地页面记录。";
}

$("#page-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => search().catch((error) => setFeedback(error.message, true)), 120);
});

document.body.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  button.disabled = true;
  try {
    let result;
    if (button.dataset.action === "open-result") result = await chrome.runtime.sendMessage({ type: "openSearchResult", result: JSON.parse(button.dataset.result) });
    if (button.dataset.action === "suspend") result = await chrome.runtime.sendMessage({ type: "directSuspendTab", tabId: Number(button.dataset.tabId) });
    if (button.dataset.action === "restore-recent") result = await chrome.runtime.sendMessage({ type: "restoreRecentSuspension", recordId: button.dataset.id });
    if (button.dataset.action === "restore-checkpoint") result = await chrome.runtime.sendMessage({ type: "restoreCheckpoint", checkpointId: button.dataset.id });
    setFeedback(result?.ok ? "操作已完成" : result?.reason || "操作未完成", !result?.ok);
    await loadDashboard();
  } catch (error) {
    setFeedback(error.message || "操作未完成", true);
  } finally {
    button.disabled = false;
  }
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

$("#generate-ai-brief").addEventListener("click", async () => {
  const button = $("#generate-ai-brief");
  const output = $("#ai-brief");
  button.disabled = true;
  $("#ai-status").textContent = "生成中";
  output.className = "ai-brief";
  output.textContent = "正在通过本地模型整理网页元数据…";
  let session;
  try {
    let answer;
    if (dashboard.settings.aiProvider === "ollama") {
      const result = await chrome.runtime.sendMessage({ type: "generateOllamaBrief", request: $("#ai-request").value });
      if (!result?.ok) throw new Error(result?.reason || "Ollama 未能生成建议。");
      answer = result.answer;
    } else {
      session = await createLocalModel();
      answer = await session.prompt(buildLocalAiPrompt(dashboard.tabs, $("#ai-request").value));
    }
    output.textContent = answer.trim() || "本地模型没有返回可用建议。";
    $("#ai-status").textContent = "已生成";
  } catch (error) {
    output.className = "ai-brief empty-state";
    output.textContent = error.message || "无法生成本地 AI 建议。";
    $("#ai-status").textContent = "不可用";
  } finally {
    session?.destroy?.();
    button.disabled = false;
  }
});
$("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

loadDashboard().catch((error) => setFeedback(error.message || "无法读取页面记忆", true));
