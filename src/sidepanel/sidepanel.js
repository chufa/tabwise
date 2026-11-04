import { escapeHtml } from "../shared/html.js";

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
      <span>${escapeHtml(candidate.explanation)}</span>
    </div>
    <button class="action-button" data-action="suspend" data-tab-id="${tab.id}" type="button">休眠</button>
  </article>`;
}

async function loadDashboard() {
  dashboard = await chrome.runtime.sendMessage({ type: "getDashboard" });
  const { summary, settings } = dashboard;
  $("#state").textContent = settings.autoSuspend
    ? `自动休眠开启 · ${settings.idleMinutes} 分钟阈值`
    : `${summary.unloaded} 个页面处于休眠`;
  $("#candidate-count").textContent = dashboard.candidates.length ? `${dashboard.candidates.length} 项` : "无";
  $("#candidates").className = dashboard.candidates.length ? "results" : "results empty-state";
  $("#candidates").innerHTML = dashboard.candidates.map(candidateRow).join("") || "目前没有可自动休眠的页面。";

  const [recent, checkpoints] = await Promise.all([
    chrome.runtime.sendMessage({ type: "getRecentSuspensions" }),
    chrome.runtime.sendMessage({ type: "getRecoveryCheckpoints" })
  ]);
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
$("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

loadDashboard().catch((error) => setFeedback(error.message || "无法读取页面记忆", true));
