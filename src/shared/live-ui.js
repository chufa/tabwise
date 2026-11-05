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
  const template = document.createElement("template");
  template.innerHTML = html;
  const key = (node) => node.nodeType === 1 ? node.id || node.getAttribute("data-key") || node.getAttribute("data-task-id") : null;
  function morph(parent, incoming) {
    const old = [...parent.childNodes], keyed = new Map(old.filter(key).map((node) => [key(node), node]));
    let cursor = parent.firstChild;
    for (const next of [...incoming.childNodes]) {
      const id = key(next);
      let current = id ? keyed.get(id) : cursor && !key(cursor) ? cursor : null;
      if (!current || current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) current = next.cloneNode(true);
      if (current !== cursor) parent.insertBefore(current, cursor);
      if (current.nodeType === 1) {
        const value = current.value, valueAttr = current.getAttribute("value");
        const expanded = current.tagName === "DETAILS" && current.open;
        for (const attr of [...current.attributes]) if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
        for (const attr of [...next.attributes]) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
        morph(current, next);
        if (current.tagName === "DETAILS") current.open = expanded;
        if (current.tagName === "INPUT") {
          if (["checkbox", "radio"].includes(current.type)) current.checked = next.checked;
          else if (valueAttr === next.getAttribute("value") || document.activeElement === current) current.value = value;
          else current.value = next.value;
        }
        if (current.tagName === "SELECT" && [...current.options].some((option) => option.value === value)) current.value = value;
      } else if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      cursor = current.nextSibling;
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  }
  morph(host, template.content);
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
