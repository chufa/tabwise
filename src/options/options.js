import { escapeHtml } from "../shared/html.js";
import { OLLAMA_PROBE_SCHEMA, validateOllamaProbe } from "../shared/ollama.js";
import { BACKUP_LIMITS } from "../shared/backup.js";
import { SITE_RISK_TEMPLATES, applySiteRiskTemplate } from "../shared/policy.js";
import { parseIdleRules } from "../shared/site-idle.js";

const $ = (selector) => document.querySelector(selector);

function lines(value) {
  return [...new Set(value.split("\n").map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

async function load() {
  $("#settings-form").inert = true;
  $("#settings-form").setAttribute("aria-busy", "true");
  const settings = await chrome.runtime.sendMessage({ type: "getDashboard" }).then((data) => data.settings);
  $("#idle-minutes").value = settings.idleMinutes;
  $("#auto-suspend").checked = settings.autoSuspend;
  $("#budget-enabled").checked = settings.resourceBudgetEnabled;
  $("#resource-sampling-mode").value = settings.resourceSampling ? settings.resourceSamplingMode || "normal" : "off";
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
  $("#ollama-endpoint").value = settings.ollamaEndpoint || "";
  $("#ollama-model").value = settings.ollamaModel || "";
  $("#compatible-endpoint").value = settings.compatibleEndpoint || "";
  $("#compatible-model").value = settings.compatibleModel || "";
  $("#compatible-json").checked = settings.compatibleJson !== false;
  await credentialStatus();
  syncOllamaConfig();
  $("#trusted-domains").value = settings.trustedDomains.join("\n");
  $("#blocked-domains").value = settings.blockedDomains.join("\n");
  $("#manual-domains").value = (settings.manualDomains || []).join("\n");
  $("#native-discard-domains").value = (settings.nativeDiscardDomains || []).join("\n");
  $("#site-idle-rules").value = (settings.siteIdleRules || []).map((rule) => `${rule.domain} ${rule.minutes}`).join("\n");
  await renderSyncHistory();
  await renderBackupStatus();
  $("#settings-form").inert = false;
  $("#settings-form").setAttribute("aria-busy", "false");
}

async function renderBackupStatus() {
  const status = await chrome.runtime.sendMessage({ type: "getBackupStatus" });
  $("#backup-reminder-days").value = String(status.reminderDays || 0);
  $("#backup-status").textContent = `${status.lastDownloadRequestedAt ? `最近发起下载：${new Date(status.lastDownloadRequestedAt).toLocaleString()}` : "尚未记录备份下载"}${status.due ? " · 已到提醒时间，请导出备份。" : ""}（请自行确认文件已保存）`;
  $("#backup-history").innerHTML = (status.history || []).slice(0, 5).map((item) => `<p>${new Date(item.at).toLocaleString()} · ${item.kind === "download-requested" ? "发起下载" : item.ok ? item.verified ? "演练通过" : "旧备份演练通过（无校验码）" : "演练失败"} · ${item.counts.workspaces} 个工作区 · ${item.counts.pages} 页</p>`).join("");
}
$("#backup-reminder-days").addEventListener("change", async () => {
  const result = await chrome.runtime.sendMessage({ type: "updateSettings", settings: { backupReminderDays: Number($("#backup-reminder-days").value) } });
  if (result.ok === false) { $("#backup-feedback").textContent = result.reason; return; }
  await renderBackupStatus();
});
$("#drill-backup").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    if (file.size > BACKUP_LIMITS.bytes) throw new Error("备份大小超过 8 MiB 上限。");
    const result = await chrome.runtime.sendMessage({ type: "drillBackup", backup: JSON.parse(await file.text()), password: $("#backup-password").value });
    if (!result.ok) throw new Error(result.reason);
    $("#backup-feedback").textContent = `恢复演练通过：${result.counts.workspaces} 个工作区，${result.counts.pages} 页。未导入数据或打开网页。`;
  } catch (error) { $("#backup-feedback").textContent = `演练失败：${error.message}`; }
  finally { event.target.value = ""; await renderBackupStatus(); }
});

async function renderSyncHistory() {
  const history = await chrome.runtime.sendMessage({ type: "getSyncHistory" });
  $("#sync-history").innerHTML = Array.isArray(history) && history.length
    ? history.slice(0, 5).map((entry) => `<article class="sync-history-item"><span><strong>版本 ${entry.revision}</strong><small>${new Date(entry.at).toLocaleString()} · ${entry.action === "restored" ? "已回滚" : entry.action === "uploaded" ? "首次同步" : "已合并"} · ${entry.summary.workspaces} 个工作区</small></span><button type="button" data-history-id="${escapeHtml(entry.id)}">恢复此版本</button></article>`).join("")
    : "<p>尚无同步历史。</p>";
}

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  let siteIdleRules;
  try { siteIdleRules = parseIdleRules($("#site-idle-rules").value); }
  catch (error) { $("#saved").textContent = error.message; return; }
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
  if (aiProvider === "compatible") {
    try { await saveCompatible(); }
    catch (error) { $("#saved").textContent = error.message; return; }
  }
  const savedResult = await chrome.runtime.sendMessage({
    type: "updateSettings",
    settings: {
      idleMinutes: Number($("#idle-minutes").value),
      siteIdleRules,
      autoSuspend: $("#auto-suspend").checked,
      resourceBudgetEnabled: $("#budget-enabled").checked,
      resourceSamplingMode: $("#resource-sampling-mode").value,
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
      blockedDomains: lines($("#blocked-domains").value),
      manualDomains: lines($("#manual-domains").value),
      nativeDiscardDomains: lines($("#native-discard-domains").value)
    }
  });
  if (savedResult.ok === false) { $("#saved").textContent = savedResult.reason; return; }
  $("#saved").textContent = "已保存";
  setTimeout(() => { $("#saved").textContent = ""; }, 1600);
});

$("#sync-metadata").addEventListener("click", async () => {
  const button = $("#sync-metadata");
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "previewSyncMetadata" });
    if (!result.ok) throw new Error(result.reason);
      const conflicts = result.conflicts || [];
      $("#sync-preview").dataset.previewId = result.previewId;
      $("#sync-preview").innerHTML = `<h3>同步预览</h3>
        <p>选择本次云端副本中的工作区，未选内容保留在本机。同步仅包含当前快照、标签与站点策略；历史版本、合并来源和备注保留在本机。</p>
        <p>${escapeHtml(result.capacity.reason || `当前本机快照约 ${result.capacity.bytes} 字节；上限 45 KB。`)}${result.pending ? " 上次同步未完成，请核对版本后再次确认。" : ""}</p>
        <fieldset><legend>同步工作区</legend>${result.choices.map((item) => `<label class="check"><input type="checkbox" data-sync-workspace="${escapeHtml(item.id)}" checked><span>${escapeHtml(item.name)} · ${item.pages} 页</span></label>`).join("")}</fieldset>
        ${conflicts.length ? conflicts.map((item) => `<label class="sync-conflict">
        <span><strong>${escapeHtml(item.kind === "workspace" ? item.name : item.key)}</strong><small>${item.kind === "workspace" ? "两台设备的工作区内容不同" : "两台设备的站点策略不同"}</small></span>
        <select data-sync-conflict="${escapeHtml(item.id)}"><option value="local">保留本机版本</option><option value="remote">采用同步版本</option>${item.kind === "workspace" ? '<option value="copy" selected>保留两个副本</option>' : ""}</select></label>`).join("") : "<p>没有冲突；确认后会合并新增元数据。</p>"}
        <div class="backup-actions"><button type="button" data-sync="apply">确认同步</button><button type="button" data-sync="cancel">取消</button></div>`;
      $("#sync-preview").hidden = false;
      $("#sync-feedback").textContent = "已生成同步预览，确认后才会写入。";
  } catch (error) { $("#sync-feedback").textContent = error.message; }
  finally { button.disabled = false; }
});
$("#sync-preview").addEventListener("click", async (event) => {
  const action = event.target.closest("[data-sync]")?.dataset.sync;
  if (!action) return;
  if (action === "cancel") { $("#sync-preview").hidden = true; return; }
  const resolutions = Object.fromEntries([...document.querySelectorAll("[data-sync-conflict]")].map((input) => [input.dataset.syncConflict, input.value]));
  const button = event.target.closest("[data-sync]");
  button.disabled = true;
  let result;
  try { result = await chrome.runtime.sendMessage({ type: "applySyncMetadata", resolutions,
    previewId: $("#sync-preview").dataset.previewId,
    workspaceIds: [...document.querySelectorAll("[data-sync-workspace]:checked")].map((input) => input.dataset.syncWorkspace) }); }
  catch (error) { $("#sync-feedback").textContent = error.message; return; }
  finally { button.disabled = false; }
  if (!result.ok) { $("#sync-feedback").textContent = result.reason; return; }
  $("#sync-preview").hidden = true;
  $("#sync-feedback").textContent = `已同步${result.conflicts ? `；已处理 ${result.conflicts} 个冲突` : ""}。`;
  await load();
});
$("#sync-history").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-history-id]");
  if (!button) return;
  if (!button.dataset.confirm) {
    button.dataset.confirm = "true";
    button.textContent = "确认恢复";
    $("#sync-feedback").textContent = "将用所选版本覆盖当前工作区与站点策略；再次点击确认。";
    return;
  }
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "restoreSyncHistory", historyId: button.dataset.historyId });
    if (!result.ok) throw new Error(result.reason);
    $("#sync-feedback").textContent = `已恢复版本，并创建版本 ${result.revision}。`;
    await load();
  } catch (error) { $("#sync-feedback").textContent = error.message; }
  finally { button.disabled = false; }
});

$("#site-template").innerHTML = '<option value="">选择风险模板</option>' + SITE_RISK_TEMPLATES.map((template) => `<option value="${template.id}">${escapeHtml(template.label)}</option>`).join("");
$("#apply-site-template").addEventListener("click", () => {
  const id = $("#site-template").value;
  if (!id) return;
  const template = SITE_RISK_TEMPLATES.find((item) => item.id === id);
  const domains = lines($("#template-domains").value);
  const current = {
    trustedDomains: lines($("#trusted-domains").value), blockedDomains: lines($("#blocked-domains").value),
    manualDomains: lines($("#manual-domains").value), nativeDiscardDomains: lines($("#native-discard-domains").value)
  };
  const next = applySiteRiskTemplate(current, template.id, domains.length ? domains : template.domains);
  $("#blocked-domains").value = next.blockedDomains.join("\n");
  $("#manual-domains").value = next.manualDomains.join("\n");
  $("#native-discard-domains").value = next.nativeDiscardDomains.join("\n");
  $("#template-feedback").textContent = `已填入${template.label}模板；请保存设置后生效。`;
});

function syncOllamaConfig() {
  const provider = document.querySelector('input[name="ai-provider"]:checked').value;
  $("#ollama-config").hidden = provider !== "ollama";
  $("#compatible-config").hidden = provider !== "compatible";
  $("#browser-model-check").hidden = provider !== "browser";
}

document.querySelectorAll('input[name="ai-provider"]').forEach((input) => input.addEventListener("change", syncOllamaConfig));

async function modelMessage(type, fields = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...fields });
  if (!result?.ok) throw new Error(result?.reason || "模型配置失败，请重试。");
  return result;
}
async function credentialStatus() {
  const status = await modelMessage("getModelCredentialStatus");
  $("#persist-model-key").checked = status.persistence === "local";
  $("#credential-status").textContent = status.hasKey
    ? `密钥已保存 · ${status.persistence === "local" ? "本机记住（未加密）" : "当前浏览器会话"} · 仅用于 ${status.endpoint}`
    : "尚未保存密钥；本机无认证服务可直接使用。";
}
async function saveCompatible() {
  await modelMessage("saveCompatibleConfig", {
    endpoint: $("#compatible-endpoint").value, model: $("#compatible-model").value,
    key: $("#compatible-key").value, persist: $("#persist-model-key").checked, jsonMode: $("#compatible-json").checked
  });
  $("#compatible-key").value = "";
  await credentialStatus();
}
$("#compatible-model-choice").addEventListener("change", () => {
  if ($("#compatible-model-choice").value) $("#compatible-model").value = $("#compatible-model-choice").value;
  $("#compatible-feedback").textContent = "模型已选择，请保存配置。";
});
for (const [id, action] of [["save-compatible", "save"], ["list-compatible", "listCompatibleModels"], ["test-compatible", "testCompatibleConnection"], ["clear-model-key", "clearModelCredential"]]) {
  $(`#${id}`).addEventListener("click", async () => {
    const buttons = [...$("#compatible-config").querySelectorAll("button")];
    buttons.forEach((button) => { button.disabled = true; });
    $("#compatible-feedback").textContent = action === "testCompatibleConnection" ? "正在检查 JSON 推理，最多等待 90 秒…" : "正在处理…";
    try {
      if (action === "clearModelCredential") {
        await modelMessage(action); $("#compatible-key").value = ""; await credentialStatus();
        $("#compatible-feedback").textContent = "密钥已清除。";
      } else {
        await saveCompatible();
        if (action === "save") $("#compatible-feedback").textContent = "模型配置已保存。";
        else {
          const result = await modelMessage(action);
          if (action === "listCompatibleModels") {
            $("#compatible-model-choice").innerHTML = '<option value="">请选择模型</option>' + result.models.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
            $("#compatible-feedback").textContent = result.models.length ? `已读取 ${result.models.length} 个模型。` : "服务未提供模型列表；可手动填写模型名。";
          } else $("#compatible-feedback").textContent = `自检通过 · JSON 有效 · ${(result.latencyMs / 1000).toFixed(1)} 秒${result.usage.totalTokens === null ? "" : ` · ${result.usage.totalTokens} tokens`}`;
        }
      }
    } catch (error) { $("#compatible-feedback").textContent = error.message; }
    finally { buttons.forEach((button) => { button.disabled = false; }); }
  });
}

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
  const password = $("#backup-password").value;
  const backup = await chrome.runtime.sendMessage({ type: "exportBackup", password });
  if (backup.ok === false) throw new Error(backup.reason);
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `tabwise-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const recorded = await chrome.runtime.sendMessage({ type: "backupDownloadRequested", exportRequestId: backup.exportRequestId });
  if (!recorded.ok) throw new Error(recorded.reason);
  $("#backup-feedback").textContent = `已发起 ${backup.integrity.counts.workspaces} 个工作区的备份下载 · ${password ? "AES-GCM 加密与" : ""}SHA-256 校验码已附带，请确认文件已保存`;
  await renderBackupStatus();
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
    const result = await chrome.runtime.sendMessage({ type: "prepareBackupImport", backup, password: $("#backup-password").value });
    if (version !== backupVersion) return;
    if (!result.ok) throw new Error(result.reason);
    backupPreviewId = result.previewId;
    $("#backup-feedback").textContent = result.verified
      ? result.encrypted ? `${result.needsReencryption ? "密码参数较旧；建议导入后重新加密导出。" : "密码与"}完整性校验通过；恢复演练未写入任何数据，等待确认导入。` : "完整性校验通过，等待确认导入。"
      : "旧版备份，请核对内容后导入。";
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
