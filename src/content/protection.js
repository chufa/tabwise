let dirty = false;
let upload = false;
let media = false;

function report() {
  chrome.runtime.sendMessage({
    type: "pageProtection",
    state: {
      ready: true,
      dirty,
      upload,
      media,
      url: location.href
    }
  }).catch(() => {});
}

function markDirty(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.matches("input, textarea, select, [contenteditable='true']")) {
    dirty = true;
    if (target.matches("input[type='file']")) upload = true;
    report();
  }
}

document.addEventListener("input", markDirty, true);
document.addEventListener("change", markDirty, true);
document.addEventListener("play", () => { media = true; report(); }, true);
document.addEventListener("pause", () => { media = false; report(); }, true);
document.addEventListener("ended", () => { media = false; report(); }, true);
report();
