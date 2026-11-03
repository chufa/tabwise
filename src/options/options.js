const $ = (selector) => document.querySelector(selector);

function lines(value) {
  return [...new Set(value.split("\n").map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

async function load() {
  const settings = await chrome.runtime.sendMessage({ type: "getDashboard" }).then((data) => data.settings);
  $("#idle-minutes").value = settings.idleMinutes;
  $("#auto-suspend").checked = settings.autoSuspend;
  $("#trusted-domains").value = settings.trustedDomains.join("\n");
  $("#blocked-domains").value = settings.blockedDomains.join("\n");
}

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.runtime.sendMessage({
    type: "updateSettings",
    settings: {
      idleMinutes: Number($("#idle-minutes").value),
      autoSuspend: $("#auto-suspend").checked,
      trustedDomains: lines($("#trusted-domains").value),
      blockedDomains: lines($("#blocked-domains").value)
    }
  });
  $("#saved").textContent = "已保存";
  setTimeout(() => { $("#saved").textContent = ""; }, 1600);
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
