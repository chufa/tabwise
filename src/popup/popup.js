import { escapeHtml } from "../shared/html.js";
import { sortTabs } from "../shared/search.js";

const $ = (selector) => document.querySelector(selector);
const state = { data: null, filter: "all", sort: "recent", search: "", workspaceSearch: "", workspaces: [], recent: [], checkpoints: [], expandedSuggestions: new Set(), tabMessages: new Map() };

function formatRelativeTime(timestamp) {
  if (!timestamp) return "刚开始追踪";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "刚刚活跃";
  if (minutes < 60) return `${minutes} 分钟前活跃`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时前活跃`;
}

function formatDuration(startedAt) {
  if (!startedAt) return "刚开始观察";
  const minutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
  if (minutes < 1) return "不足 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`;
}

function formatMemory(bytes) {
  return Number.isFinite(bytes) && bytes > 0 ? `${Math.round(bytes / 1024 / 1024)} MB` : "";
}

function memoryLabel(memory) {
  if (!memory) return "";
  const value = formatMemory(memory.usedJSHeapSize);
  if (!value) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - memory.updatedAt) / 60_000));
  return `JS 堆 ${value} · ${minutes < 1 ? "刚刚" : `${minutes} 分钟前`}测量`;
}

function heapSummaryLabel(summary) {
  const usage = formatMemory(summary.jsHeapUsage);
  if (!usage) return "--";
  return usage;
}

function protectionReason(reason) {
  const labels = {
    "Active tab": "当前正在使用",
    "Pinned tab": "已固定",
    "Playing audio": "正在播放音频",
    "Still loading": "页面仍在加载",
    "Already discarded by browser": "已由浏览器卸载",
    "Not a web page": "浏览器内部页面",
    "Never suspend domain": "在永不休眠列表中",
    "Untrusted domain": "未信任的网站",
    "Protection status unknown": "页面保护状态未就绪"
  };
  return labels[reason] || reason;
}

function actionMessage(reason) {
  const labels = {
    "Active tab": "请先切换到其他标签页",
    "Still loading": "页面仍在加载，请稍后再试",
    "Already discarded by browser": "该页面已被浏览器卸载",
    "Tab changed before suspension": "标签状态已变化，请刷新后重试",
    "浏览器拒绝卸载该标签页": "浏览器拒绝卸载此页面"
  };
  return labels[reason] || reason || "操作未完成";
}

function row({ title, subtitle, action = "", secondaryAction = "", id = "", badge = "", tabIds = [] }) {
  const tabData = tabIds.length ? ` data-tab-ids="${escapeHtml(JSON.stringify(tabIds))}"` : "";
  const actionId = action?.id || id;
  const secondaryActionId = secondaryAction?.id || id;
  return `<div class="row">
    <div class="row-main"><strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><span title="${escapeHtml(subtitle)}">${escapeHtml(subtitle)}</span></div>
    ${badge ? `<span class="status-badge ${badge === "休眠中" ? "resting" : ""}">${escapeHtml(badge)}</span>` : ""}
    ${action || secondaryAction ? `<div class="row-actions">${secondaryAction ? `<button class="action-button" data-action="${secondaryAction.type}" data-id="${escapeHtml(secondaryActionId)}" type="button">${escapeHtml(secondaryAction.label)}</button>` : ""}${action ? `<button class="action-button" data-action="${action.type}" data-id="${escapeHtml(actionId)}"${tabData} type="button">${escapeHtml(action.label)}</button>` : ""}</div>` : ""}
  </div>`;
}

async function send(message) {
  return chrome.runtime.sendMessage(message);
}

function setFeedback(message = "", isError = false) {
  const feedback = $("#action-feedback");
  feedback.textContent = message;
  feedback.classList.toggle("is-error", isError);
}

function renderAutomationState(settings) {
  const paused = settings.pauseUntil > Date.now();
  const stateLabel = !settings.autoSuspend ? "自动休眠已关闭" : paused ? `自动休眠暂停至 ${new Date(settings.pauseUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : `自动休眠：${settings.idleMinutes} 分钟后`;
  $("#automation-state").textContent = stateLabel;
  $("#pause-automation").textContent = paused ? "恢复自动休眠" : "暂停 1 小时";
}

function visibleTabs() {
  const normalizedSearch = state.search.trim().toLowerCase();
  const tabs = state.data.tabs.filter((tab) => {
    const matchesFilter = state.filter === "all" || (state.filter === "suspended" ? tab.suspended : tab.status === state.filter);
    const matchesSearch = !normalizedSearch || `${tab.title} ${tab.domain}`.toLowerCase().includes(normalizedSearch);
    return matchesFilter && matchesSearch;
  });
  return sortTabs(tabs, state.sort);
}

function renderSuggestions(organization) {
  const tabById = new Map(state.data.tabs.map((tab) => [tab.id, tab]));
  const details = (key, tabIds) => {
    if (!state.expandedSuggestions.has(key)) return "";
    const items = tabIds.map((tabId) => tabById.get(tabId)).filter(Boolean);
    return `<div class="suggestion-details">${items.map((tab) => `<button class="suggestion-tab" data-action="focus-tab" data-id="${tab.id}" type="button"><strong>${escapeHtml(tab.title)}</strong><span>${escapeHtml(tab.domain || tab.url)}</span></button>`).join("")}</div>`;
  };
  const entries = [
    ...organization.domainGroups.map((group) => {
      const key = `domain:${group.domain}`;
      return `${row({
        title: group.domain,
        subtitle: `${group.tabIds.length} 个标签页来自同一网站`,
        action: { type: "group", label: "分组", id: group.domain },
        secondaryAction: { type: "toggle-suggestion", label: state.expandedSuggestions.has(key) ? "收起" : "详情", id: key },
        id: key,
        tabIds: group.tabIds
      })}${details(key, group.tabIds)}`;
    }),
    ...organization.duplicates.map((group) => {
      const key = `duplicate:${group.url}`;
      return `${row({
        title: "检测到相同页面",
        subtitle: `${new URL(group.url).hostname} · ${group.tabIds.length} 个完全相同的 URL`,
        secondaryAction: { type: "toggle-suggestion", label: state.expandedSuggestions.has(key) ? "收起" : "详情", id: key },
        id: key,
        badge: `${group.tabIds.length} 个重复`
      })}${details(key, group.tabIds)}`;
    })
  ];
  $("#suggestion-count").textContent = entries.length ? `${entries.length} 项建议` : "已整理";
  $("#suggestions").className = entries.length ? "list" : "list empty-state";
  $("#suggestions").innerHTML = entries.join("") || "当前没有可分组或重复的标签页。";
}

function renderTabs() {
  const tabs = visibleTabs();
  $("#tabs").className = tabs.length ? "list" : "list empty-state";
  $("#tabs").innerHTML = tabs.map((tab) => {
    const isProtected = !tab.suspended && tab.status === "protected";
    const canTrust = isProtected && /^https?:/.test(tab.url) && tab.reason === "Untrusted domain";
    const canDirectSuspend = isProtected && /^https?:/.test(tab.url) && !["Active tab", "Still loading", "Already discarded by browser"].includes(tab.reason);
    const action = tab.suspended
      ? { type: "restore", label: "恢复" }
      : tab.status === "live" ? { type: "suspend", label: "休眠" }
        : canDirectSuspend ? { type: "direct-suspend", label: "直接休眠" } : null;
    const secondaryAction = canTrust ? { type: "trust", label: "信任网站" } : null;
    const memory = memoryLabel(tab.memory);
    const subtitle = tab.suspended
      ? `已休眠 ${formatDuration(tab.suspendedAt)} · 已观察 ${formatDuration(tab.observedAt)}`
      : isProtected ? [memory, protectionReason(tab.reason), `已观察 ${formatDuration(tab.observedAt)}`].filter(Boolean).join(" · ")
        : [memory, tab.domain, formatRelativeTime(tab.lastActivity), `已观察 ${formatDuration(tab.observedAt)}`].filter(Boolean).join(" · ");
    const rowMessage = state.tabMessages.get(tab.id);
    return row({
      title: tab.title,
      subtitle: rowMessage ? `${subtitle} · ${rowMessage}` : subtitle,
      action,
      secondaryAction,
      id: tab.suspended ? (tab.recordId || tab.id) : tab.id,
      badge: tab.suspended ? "休眠中" : isProtected ? "已保护" : ""
    });
  }).join("") || "没有符合当前筛选条件的标签页。";
}

function renderRecovery() {
  $("#recent-count").textContent = state.recent.length ? `${state.recent.length} 项` : "";
  $("#recent-suspensions").className = state.recent.length ? "list" : "list empty-state";
  $("#recent-suspensions").innerHTML = state.recent.slice(0, 3).map((record) => row({
    title: record.title || record.originalUrl,
    subtitle: `${domainForRecord(record.originalUrl)} · 休眠于 ${new Date(record.suspendedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    action: { type: "restore-recent", label: "撤销" },
    id: record.recordId
  })).join("") || "暂无可撤销的休眠操作。";

  $("#checkpoints").className = state.checkpoints.length ? "list" : "list empty-state";
  $("#checkpoints").innerHTML = state.checkpoints.slice(0, 3).map((checkpoint) => row({
    title: `${checkpoint.tabs.length} 个标签页`,
    subtitle: new Date(checkpoint.createdAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    action: { type: "restore-checkpoint", label: "打开" },
    id: checkpoint.id
  })).join("") || "恢复点会每 30 分钟自动保存。";
}

function domainForRecord(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "已保存页面";
  }
}

async function render() {
  state.data = await send({ type: "getDashboard" });
  const { tabs, summary, organization } = state.data;
  $("#open-count").textContent = tabs.length;
  $("#eligible-count").textContent = summary.eligible;
  $("#suspended-count").textContent = tabs.filter((tab) => tab.suspended).length;
  $("#duplicate-count").textContent = organization.duplicates.reduce((total, group) => total + group.tabIds.length - 1, 0);
  $("#js-heap-usage").textContent = heapSummaryLabel(summary);
  const snapshotDetail = summary.jsHeapMeasuredTabs
    ? `JS 堆采样：${summary.jsHeapMeasuredTabs} 个网页`
    : "尚未采集网页 JS 堆数据";
  const suspensionDetail = summary.unloaded
    ? state.data.settings.suspensionStrategy === "native-discard"
      ? `已由 Chrome 原生卸载 ${summary.unloaded} 个页面；切回时会自动重新加载。`
      : `已卸载 ${summary.unloaded} 个页面的渲染内容；点击休眠页或刷新后才会恢复。`
    : "暂无已卸载页面；休眠不会改写标签页 URL 或浏览历史。";
  $("#resource-note").textContent = `${snapshotDetail} · ${suspensionDetail}`;
  renderAutomationState(state.data.settings);
  renderSuggestions(organization);
  renderTabs();
  [state.recent, state.checkpoints] = await Promise.all([
    send({ type: "getRecentSuspensions" }),
    send({ type: "getRecoveryCheckpoints" })
  ]);
  renderRecovery();

  state.workspaces = await send({ type: "getWorkspaces" });
  const normalizedSearch = state.workspaceSearch.trim().toLowerCase();
  const workspaces = state.workspaces.filter((workspace) => !normalizedSearch || `${workspace.name} ${workspace.tabs.map((tab) => `${tab.title} ${tab.url}`).join(" ")}`.toLowerCase().includes(normalizedSearch));
  $("#workspaces").className = workspaces.length ? "list" : "list empty-state";
  $("#workspaces").innerHTML = workspaces.slice(0, 5).map((workspace) => row({
    title: workspace.name,
    subtitle: `${workspace.tabs.length} 个标签页 · ${new Date(workspace.createdAt).toLocaleDateString()}`,
    action: { type: "open-workspace", label: "打开" },
    secondaryAction: { type: "toggle-workspace-pinned", label: workspace.pinned ? "取消固定" : "固定" },
    id: workspace.id,
    badge: workspace.pinned ? "已固定" : ""
  })).join("") || "保存窗口状态后，可在这里一键重新打开。";
}

document.body.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  button.disabled = true;
  const { action, id } = button.dataset;
  let result;
  if (action === "suspend") result = await send({ type: "directSuspendTab", tabId: Number(id) });
  if (action === "direct-suspend") result = await send({ type: "directSuspendTab", tabId: Number(id) });
  if (action === "restore") {
    result = Number.isInteger(Number(id)) && String(Number(id)) === id
      ? await send({ type: "restoreTab", tabId: Number(id) })
      : await send({ type: "restoreRecord", recordId: id });
  }
  if (action === "trust") result = await send({ type: "trustDomain", url: state.data.tabs.find((tab) => tab.id === Number(id))?.url });
  if (action === "focus-tab") result = await send({ type: "focusTab", tabId: Number(id) });
  if (action === "restore-recent") result = await send({ type: "restoreRecentSuspension", recordId: id });
  if (action === "restore-checkpoint") {
    const checkpoint = state.checkpoints.find((item) => item.id === id);
    if (checkpoint?.tabs.length > 10 && !window.confirm(`该恢复点包含 ${checkpoint.tabs.length} 个标签页，打开后可能增加浏览器负载。是否继续？`)) {
      button.disabled = false;
      return;
    }
    result = await send({ type: "restoreCheckpoint", checkpointId: id });
  }
  if (action === "open-workspace") {
    const workspace = state.workspaces.find((item) => item.id === id);
    if (workspace?.tabs.length > 10 && !window.confirm(`该工作区包含 ${workspace.tabs.length} 个标签页，打开后可能增加浏览器负载。是否继续？`)) {
      button.disabled = false;
      return;
    }
    result = await send({ type: "openWorkspace", workspaceId: id });
  }
  if (action === "toggle-workspace-pinned") result = await send({ type: "toggleWorkspacePinned", workspaceId: id });
  if (action === "toggle-suggestion") {
    if (state.expandedSuggestions.has(id)) state.expandedSuggestions.delete(id);
    else state.expandedSuggestions.add(id);
    renderSuggestions(state.data.organization);
    return;
  }
  if (action === "group") result = await send({ type: "groupTabs", title: id, tabIds: JSON.parse(button.dataset.tabIds || "[]") });
  if (action === "suspend" || action === "direct-suspend") {
    state.tabMessages.set(Number(id), result?.ok ? "已进入休眠" : actionMessage(result?.reason));
  }
  setFeedback(result?.ok ? action === "group" ? `已分组 ${result.count} 个标签页` : "操作已完成" : actionMessage(result?.reason), !result?.ok);
  await render();
});

$("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#open-search").addEventListener("click", async () => {
  const currentWindow = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: currentWindow.id });
  globalThis.window.close();
});
$("#refresh").addEventListener("click", async () => { await render(); setFeedback("已刷新标签状态"); });
$("#pause-automation").addEventListener("click", async () => {
  const paused = state.data.settings.pauseUntil > Date.now();
  const result = await send({ type: "pauseAutomation", minutes: paused ? 0 : 60 });
  setFeedback(result.ok ? paused ? "已恢复自动休眠" : "自动休眠已暂停 1 小时" : result.reason, !result.ok);
  await render();
});
$("#create-checkpoint").addEventListener("click", async () => {
  const result = await send({ type: "createRecoveryCheckpoint" });
  setFeedback(result.ok ? result.count ? `已保存 ${result.count} 个标签页` : "当前没有可保存的网页标签" : result.reason, !result.ok);
  await render();
});
$("#suspend-eligible").addEventListener("click", async () => {
  const eligible = state.data.summary.eligible;
  if (!eligible || !window.confirm(`将休眠本窗口中 ${eligible} 个符合安全条件的标签页。是否继续？`)) return;
  const result = await send({ type: "suspendEligibleTabs" });
  setFeedback(result.ok ? `已休眠 ${result.count} 个标签页` : result.reason, !result.ok);
  await render();
});
$("#tab-search").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderTabs();
});
$("#tab-sort").addEventListener("change", (event) => {
  state.sort = event.target.value;
  renderTabs();
});
document.addEventListener("keydown", (event) => {
  const search = $("#tab-search");
  const target = event.target;
  const isTextInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
  if (event.key === "/" && !isTextInput) {
    event.preventDefault();
    search.focus();
  }
  if (event.key === "Escape" && document.activeElement === search && search.value) {
    search.value = "";
    state.search = "";
    renderTabs();
  }
});
document.querySelector(".filter-bar").addEventListener("click", (event) => {
  const filter = event.target.closest("[data-filter]");
  if (!filter) return;
  state.filter = filter.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("is-active", item === filter));
  renderTabs();
});
$("#toggle-workspace-form").addEventListener("click", () => {
  const form = $("#workspace-form");
  form.hidden = !form.hidden;
  if (!form.hidden) $("#workspace-name").focus();
});
$("#workspace-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await send({ type: "saveWorkspace", name: $("#workspace-name").value });
  if (result?.id) {
    $("#workspace-name").value = "";
    $("#workspace-form").hidden = true;
    setFeedback("已保存当前窗口");
  }
  await render();
});
$("#workspace-search").addEventListener("input", (event) => {
  state.workspaceSearch = event.target.value;
  render();
});

render().catch((error) => setFeedback(error.message || "无法读取标签页", true));
