// Coalesce browser events while keeping refreshes ordered, including manual refresh.
export function createRefresh(work) {
  let pending;
  let dirty = false;
  return function refresh() {
    dirty = true;
    if (!pending) pending = (async () => {
      try {
        while (dirty) { dirty = false; await work(); }
      } finally { pending = null; }
    })();
    return pending;
  };
}

export function updateHTML(host, html) {
  if (host.innerHTML === html) return;
  const focused = host.contains(document.activeElement) ? document.activeElement : null;
  const controls = [...host.querySelectorAll("input, select, button")];
  const identity = (element) => JSON.stringify([element.tagName, element.id, element.name, element.getAttribute("value"), { ...element.dataset }]);
  const key = focused && identity(focused);
  const scroll = [...host.querySelectorAll("*")].filter((element) => element.scrollTop).map((element) => [element.className, element.scrollTop]);
  const top = host.scrollTop;
  host.innerHTML = html;
  host.scrollTop = top;
  for (const [name, value] of scroll) {
    const element = [...host.querySelectorAll("*")].find((item) => item.className === name);
    if (element) element.scrollTop = value;
  }
  if (key && controls.length) [...host.querySelectorAll("input, select, button")].find((element) => identity(element) === key)?.focus({ preventScroll: true });
}

export function connectLiveUI(refresh, onError) {
  let port;
  let timer;
  let stopped = false;
  const request = () => refresh().catch(onError);
  const connect = () => {
    clearTimeout(timer);
    if (stopped || document.hidden || port) return;
    try {
      port = chrome.runtime.connect({ name: "tabwise-live" });
      port.onMessage.addListener((message) => { if (message.type === "stateChanged") request(); });
      port.onDisconnect.addListener(() => {
        // Read lastError so a worker restart doesn't emit an unchecked API error.
        void chrome.runtime.lastError;
        port = null;
        if (!stopped && !document.hidden) timer = setTimeout(() => { connect(); request(); }, 500);
      });
    } catch (error) { onError(error); }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(timer); port?.disconnect(); port = null; }
    else { connect(); request(); }
  });
  window.addEventListener("pagehide", () => { stopped = true; clearTimeout(timer); port?.disconnect(); });
  connect();
}
