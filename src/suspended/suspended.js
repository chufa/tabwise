const recordId = location.hash.slice(1);
const title = document.querySelector("#title");
const detail = document.querySelector("#detail");
const button = document.querySelector("#restore");
const error = document.querySelector("#error");

async function restore() {
  if (!recordId) {
    error.textContent = "找不到休眠记录，无法恢复此页面。";
    return;
  }
  button.disabled = true;
  const result = await chrome.runtime.sendMessage({ type: "restoreRecord", recordId });
  if (!result?.ok) {
    error.textContent = result?.reason || "暂时无法恢复此页面。";
    button.disabled = false;
  }
}

async function initialize() {
  const record = await chrome.runtime.sendMessage({ type: "getSuspendedRecord", recordId });
  if (record?.title) {
    title.textContent = record.title;
    const domain = new URL(record.originalUrl).hostname;
    detail.textContent = `${domain} 已休眠。原始页面已卸载，恢复前不会占用其渲染资源。`;
  }
  const wasReloaded = performance.getEntriesByType("navigation")[0]?.type === "reload";
  if (wasReloaded && recordId) await restore();
}

button.addEventListener("click", restore);
initialize().catch(() => {});
