export function createFeedback(host) {
  let timer;
  function clear() { clearTimeout(timer); host.replaceChildren(); }
  window.addEventListener("pagehide", clear);
  return (message = "", isError = false) => {
    clear();
    host.classList.toggle("is-error", isError);
    if (!message) return;
    const returnFocus = document.activeElement;
    const text = document.createElement("span");
    text.textContent = message;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.dataset.feedbackDismiss = "";
    dismiss.setAttribute("aria-label", "关闭提示");
    dismiss.textContent = "关闭";
    dismiss.addEventListener("click", () => {
      clear();
      if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
    });
    host.append(text, dismiss);
    if (!isError) timer = setTimeout(clear, 7000);
  };
}
