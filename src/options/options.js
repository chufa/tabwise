import { escapeHtml } from "../shared/html.js";
import { OLLAMA_PROBE_SCHEMA, validateOllamaProbe } from "../shared/ollama.js";
import { BACKUP_LIMITS } from "../shared/backup.js";

const $ = (selector) => document.querySelector(selector);

function lines(value) {
  return [...new Set(value.split("\n").map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

async function load() {
  const settings = await chrome.runtime.sendMessage({ type: "getDashboard" }).then((data) => data.settings);
  $("#idle-minutes").value = settings.idleMinutes;
  $("#auto-suspend").checked = settings.autoSuspend;
  $("#budget-enabled").checked = settings.resourceBudgetEnabled;
  $("#budget-tabs").value = settings.resourceBudgetTabs;
  $("#budget-heap").value = settings.resourceBudgetHeapMB;
  $("#scheduled-review-enabled").checked = settings.scheduledReviewEnabled;
  $("#scheduled-review-time").value = `${String(settings.scheduledReviewHour ?? 18).padStart(2, "0")}:${String(settings.scheduledReviewMinute || 0).padStart(2, "0")}`;
  $("#scheduled-archive-enabled").checked = settings.scheduledArchiveEnabled;
  $("#scheduled-archive-days").value = settings.scheduledArchiveDays ?? 30;
  $(`input[name="suspension-mode"][value="${settings.suspensionMode || "conservative"}"]`).checked = true;
  $(`input[name="suspension-strategy"][value="${settings.suspensionStrategy || "placeholder"}"]`).checked = true;
  $("#semantic-search").checked = settings.semanticSearch;
  $("#closed-history-enabled").checked = settings.closedHistoryEnabled;
  $("#closed-history-days").value = settings.closedHistoryDays;
  $(`input[name="ai-provider"][value="${settings.aiProvider || "browser"}"]`).checked = true;
  $("#ollama-endpoint").value = settings.ollamaEndpoint || "http://127.0.0.1:11434";
  $("#ollama-model").value = settings.ollamaModel || "";
  syncOllamaConfig();
  $("#trusted-domains").value = settings.trustedDomains.join("\n");
  $("#blocked-domains").value = settings.blockedDomains.join("\n");
}

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = document.querySelector('input[name="suspension-mode"]:checked').value;
  const strategy = document.querySelector('input[name="suspension-strategy"]:checked').value;
  const aiProvider = document.querySelector('input[name="ai-provider"]:checked').value;
  if (mode === "smart") {
    const granted = await chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] });
    if (!granted) {
      $("#saved").textContent = "未授予网页保护权限，未启用智能保护模式";
      return;
    }
  }
  const modeResult = await chrome.runtime.sendMessage({ type: "setSuspensionMode", mode });
  if (!modeResult.ok) {
    $("#saved").textContent = modeResult.reason;
    return;
  }
  await chrome.runtime.sendMessage({
    type: "updateSettings",
    settings: {
      idleMinutes: Number($("#idle-minutes").value),
      autoSuspend: $("#auto-suspend").checked,
      resourceBudgetEnabled: $("#budget-enabled").checked,
      resourceBudgetTabs: Number($("#budget-tabs").value),
      resourceBudgetHeapMB: Number($("#budget-heap").value),
      scheduledReviewEnabled: $("#scheduled-review-enabled").checked,
      scheduledReviewHour: Number($("#scheduled-review-time").value.split(":")[0]),
      scheduledReviewMinute: Number($("#scheduled-review-time").value.split(":")[1]),
      scheduledArchiveEnabled: $("#scheduled-archive-enabled").checked,
      scheduledArchiveDays: Number($("#scheduled-archive-days").value),
      suspensionMode: mode,
      suspensionStrategy: strategy,
      semanticSearch: $("#semantic-search").checked,
      closedHistoryEnabled: $("#closed-history-enabled").checked,
      closedHistoryDays: Number($("#closed-history-days").value),
      aiProvider,
      ollamaEndpoint: $("#ollama-endpoint").value,
      ollamaModel: $("#ollama-model").value,
      trustedDomains: lines($("#trusted-domains").value),
      blockedDomains: lines($("#blocked-domains").value)
    }
  });
  $("#saved").textContent = "已保存";
  setTimeout(() => { $("#saved").textContent = ""; }, 1600);
});

function syncOllamaConfig() {
  $("#ollama-config").hidden = document.querySelector('input[name="ai-provider"]:checked').value !== "ollama";
  $("#browser-model-check").hidden = !$("#ollama-config").hidden;
}

document.querySelectorAll('input[name="ai-provider"]').forEach((input) => input.addEventListener("change", syncOllamaConfig));

$("#test-ollama").addEventListener("click", async () => {
  const button = $("#test-ollama");
  button.disabled = true;
  $("#ollama-feedback").textContent = "正在检查连接、模型能力与 JSON 推理…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "testOllamaConnection", deep: true, endpoint: $("#ollama-endpoint").value, model: $("#ollama-model").value });
    $("#ollama-model-choice").innerHTML = '<option value="">请选择已安装模型</option>' + (result.details || []).map(({ name, completion }) =>
      `<option value="${escapeHtml(name)}" ${completion === false ? "disabled" : ""}>${escapeHtml(name)} · ${completion === false ? "不支持生成" : completion === true ? "支持生成" : "能力待验证"}</option>`).join("");
    if (result.ok) {
      $("#ollama-model-choice").value = result.model;
      $("#ollama-feedback").textContent = `自检通过 · JSON 有效 · ${(result.latencyMs / 1000).toFixed(1)} 秒 · 来源 ${result.origin}`;
    } else $("#ollama-feedback").textContent = `${result.stage || "配置"}：${result.reason}`;
  } catch (error) { $("#ollama-feedback").textContent = error.message; }
  finally { button.disabled = false; }
});

$("#ollama-model-choice").addEventListener("change", () => {
  if ($("#ollama-model-choice").value) $("#ollama-model").value = $("#ollama-model-choice").value;
  $("#ollama-feedback").textContent = "模型已选择，请重新自检并保存设置。";
});
$("#test-browser-model").addEventListener("click", async () => {
  const button = $("#test-browser-model");
  button.disabled = true;
  const started = performance.now();
  let session;
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); session?.destroy?.(); }, 30_000);
  try {
    const Model = globalThis.LanguageModel || globalThis.ai?.languageModel;
    if (!Model) throw new Error("当前浏览器未提供内置模型，可选择 Ollama。");
    const state = typeof Model.availability === "function" ? await Model.availability() : (await Model.capabilities()).available;
    if (!["available", "readily"].includes(state)) throw new Error(["downloadable", "downloading", "after-download"].includes(state) ? "模型尚未准备完成，请在浏览器中完成准备后重试。" : "内置模型不可用，请检查浏览器版本或管理员策略。");
    session = await Model.create();
    if (controller.signal.aborted) throw new Error("自检超时，请重试。");
    validateOllamaProbe(await session.prompt('仅输出 JSON {"ok":true}', { responseConstraint: OLLAMA_PROBE_SCHEMA, signal: controller.signal }));
    $("#browser-model-feedback").textContent = `自检通过 · JSON 有效 · ${((performance.now() - started) / 1000).toFixed(1)} 秒`;
  } catch (error) { $("#browser-model-feedback").textContent = error.message; }
  finally { clearTimeout(timeout); session?.destroy?.(); button.disabled = false; }
});

$("#export-backup").addEventListener("click", async () => {
  try {
  const backup = await chrome.runtime.sendMessage({ type: "exportBackup" });
  if (backup.ok === false) throw new Error(backup.reason);
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `tabwise-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("#backup-feedback").textContent = `已导出 ${backup.integrity.counts.workspaces} 个工作区 · SHA-256 校验码已附带`;
  } catch (error) { $("#backup-feedback").textContent = error.message; }
});

$("#export-diagnostics").addEventListener("click", async () => {
  try {
    const { bundle } = await chrome.runtime.sendMessage({ type: "getDiagnostics" });
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `tabwise-diagnostics-${new Date().toISOString().slice(0, 10)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $("#diagnostics-feedback").textContent = `已导出 ${bundle.records.length} 条本地诊断记录。`;
  } catch (error) { $("#diagnostics-feedback").textContent = error.message; }
});

$("#clear-diagnostics").addEventListener("click", async () => {
  try {
    const result = await chrome.runtime.sendMessage({ type: "clearDiagnostics" });
    if (!result.ok) throw new Error(result.reason);
    $("#diagnostics-feedback").textContent = "已清空本地诊断记录。";
  } catch (error) { $("#diagnostics-feedback").textContent = error.message; }
});

$("#clear-local-history").addEventListener("click", async () => {
  try {
    const result = await chrome.runtime.sendMessage({ type: "clearLocalHistory" });
    if (!result.ok) throw new Error(result.reason);
    $("#history-feedback").textContent = "已清除本地历史、资源采样和 AI 缓存；设置、工作区与当前休眠恢复记录仍保留。";
  } catch (error) { $("#history-feedback").textContent = error.message; }
});

let backupPreviewId;
let backupVersion = 0;
$("#import-backup").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  const version = ++backupVersion;
  backupPreviewId = null;
  $("#backup-preview").hidden = true;
  try {
    if (file.size > BACKUP_LIMITS.bytes) throw new Error("备份大小超过 8 MiB 上限。");
    const backup = JSON.parse(await file.text());
    const result = await chrome.runtime.sendMessage({ type: "prepareBackupImport", backup });
    if (version !== backupVersion) return;
    if (!result.ok) throw new Error(result.reason);
    backupPreviewId = result.previewId;
    $("#backup-feedback").textContent = result.verified ? "完整性校验通过，等待确认导入。" : "旧版备份，请核对内容后导入。";
    $("#backup-preview").innerHTML = `<h3>导入预览</h3>
      <p>${result.counts.pages} 页 · ${result.counts.windows} 个窗口 · ${result.counts.versions} 个历史版本</p>
      ${result.warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join("")}
      <fieldset><legend>选择工作区</legend>${result.workspaces.map((workspace) => `<label class="check"><input type="checkbox" data-backup-index="${workspace.index}" ${workspace.empty ? "disabled" : workspace.duplicate ? "" : "checked"}>
      <span>${escapeHtml(workspace.name)} · ${workspace.pages} 页 · ${workspace.versions} 个版本${workspace.duplicate ? " · 内容相同，默认跳过" : workspace.conflict ? " · 名称或 ID 冲突，将保留副本" : ""}</span></label>`).join("")}</fieldset>
      <label class="check"><input id="backup-copies" type="checkbox"><span>所选相同内容也保留副本</span></label>
      <label class="check"><input id="backup-settings" type="checkbox"><span>同时恢复设置</span></label>
      <div class="backup-actions"><button type="button" data-backup="confirm">确认导入</button><button type="button" data-backup="cancel">取消</button></div>`;
    $("#backup-preview").hidden = false;
  } catch (error) {
    if (version === backupVersion) $("#backup-feedback").textContent = error instanceof SyntaxError ? "无法读取 JSON 备份文件。" : error.message;
  } finally {
    event.target.value = "";
  }
});
$("#backup-preview").addEventListener("click", async (event) => {
  const action = event.target.closest("[data-backup]")?.dataset.backup;
  if (!action) return;
  if (action === "cancel") {
    backupVersion++; backupPreviewId = null; $("#backup-preview").hidden = true;
    $("#backup-feedback").textContent = "已取消导入"; return;
  }
  const current = backupVersion, previewId = backupPreviewId;
  if (!previewId) return;
  const indices = [...document.querySelectorAll("[data-backup-index]:checked")].map((input) => Number(input.dataset.backupIndex));
  $("#backup-preview").querySelectorAll("input,button").forEach((input) => { input.disabled = true; });
  try {
    const result = await chrome.runtime.sendMessage({ type: "confirmBackupImport", previewId, indices,
      keepCopies: $("#backup-copies").checked, includeSettings: $("#backup-settings").checked });
    if (current !== backupVersion) return;
    if (!result.ok) throw new Error(result.reason);
    backupPreviewId = null; $("#backup-preview").hidden = true;
    $("#backup-feedback").textContent = `已导入 ${result.count} 个工作区，跳过 ${result.skipped} 个。`;
    await load();
  } catch (error) {
    if (current === backupVersion) {
      $("#backup-feedback").textContent = error.message;
      $("#backup-preview").querySelectorAll("input,button").forEach((input) => { input.disabled = false; });
    }
  }
});
load().catch((error) => {
  $("#saved").textContent = error?.message?.includes("Extension context invalidated")
    ? "扩展刚刚更新，请刷新设置页。"
    : "无法读取设置，请刷新后重试。";
});
