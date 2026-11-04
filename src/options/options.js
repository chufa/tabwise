const $ = (selector) => document.querySelector(selector);

function lines(value) {
  return [...new Set(value.split("\n").map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

async function load() {
  const settings = await chrome.runtime.sendMessage({ type: "getDashboard" }).then((data) => data.settings);
  $("#idle-minutes").value = settings.idleMinutes;
  $("#auto-suspend").checked = settings.autoSuspend;
  $(`input[name="suspension-mode"][value="${settings.suspensionMode || "conservative"}"]`).checked = true;
  $(`input[name="suspension-strategy"][value="${settings.suspensionStrategy || "placeholder"}"]`).checked = true;
  $("#semantic-search").checked = settings.semanticSearch;
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
      suspensionMode: mode,
      suspensionStrategy: strategy,
      semanticSearch: $("#semantic-search").checked,
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
}

document.querySelectorAll('input[name="ai-provider"]').forEach((input) => input.addEventListener("change", syncOllamaConfig));

$("#test-ollama").addEventListener("click", async () => {
  const button = $("#test-ollama");
  button.disabled = true;
  $("#ollama-feedback").textContent = "正在连接…";
  await chrome.runtime.sendMessage({
    type: "updateSettings",
    settings: {
      ollamaEndpoint: $("#ollama-endpoint").value,
      ollamaModel: $("#ollama-model").value
    }
  });
  const result = await chrome.runtime.sendMessage({ type: "testOllamaConnection" });
  if (result.ok) {
    if (!$("#ollama-model").value && result.models[0]) $("#ollama-model").value = result.models[0];
    $("#ollama-feedback").textContent = result.models.length ? `已连接，发现 ${result.models.length} 个模型` : "已连接";
  } else {
    $("#ollama-feedback").textContent = result.reason;
  }
  button.disabled = false;
});

$("#export-backup").addEventListener("click", async () => {
  const backup = await chrome.runtime.sendMessage({ type: "exportBackup" });
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `tabwise-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("#backup-feedback").textContent = "备份已导出";
});

$("#import-backup").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    const result = await chrome.runtime.sendMessage({ type: "importBackup", backup });
    $("#backup-feedback").textContent = result.ok ? `已导入 ${result.count} 个工作区` : result.reason;
  } catch {
    $("#backup-feedback").textContent = "无法读取备份文件";
  } finally {
    event.target.value = "";
  }
});
load();
