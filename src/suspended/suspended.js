const recordId = location.hash.slice(1);
const title = document.querySelector("#title");
const detail = document.querySelector("#detail");
const button = document.querySelector("#restore");
const error = document.querySelector("#error");
const timing = document.querySelector("#timing");
const suspendedAt = document.querySelector("#suspended-at");
const suspendedFor = document.querySelector("#suspended-for");
let restoring = false;

function formatDuration(startedAt) {
  const minutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
  if (minutes < 1) return "不足 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`;
}

function renderTiming(startedAt) {
  suspendedAt.textContent = new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  suspendedFor.textContent = formatDuration(startedAt);
  timing.hidden = false;
}

async function restore() {
  if (restoring) return;
  if (!recordId) {
    error.textContent = "找不到休眠记录，无法恢复此页面。";
    return;
  }
  restoring = true;
  button.disabled = true;
  const result = await chrome.runtime.sendMessage({ type: "restoreRecord", recordId });
  if (!result?.ok) {
    error.textContent = result?.reason || "暂时无法恢复此页面。";
    button.disabled = false;
    restoring = false;
  }
}

async function initialize() {
  const record = await chrome.runtime.sendMessage({ type: "getSuspendedRecord", recordId });
  if (record?.title) {
    title.textContent = record.title;
    const domain = new URL(record.originalUrl).hostname;
    detail.textContent = `${domain} 已休眠。原始页面已卸载，恢复前不会占用其渲染资源。`;
    renderTiming(record.suspendedAt);
    setInterval(() => renderTiming(record.suspendedAt), 60_000);
  }
  const wasReloaded = performance.getEntriesByType("navigation")[0]?.type === "reload";
  if (wasReloaded && recordId) await restore();
}

button.addEventListener("click", restore);
document.addEventListener("click", (event) => {
  if (!button.contains(event.target)) restore();
});
initialize().catch(() => {});
