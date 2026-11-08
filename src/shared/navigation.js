// Views stay mounted so switching destinations preserves edits, selections and AI drafts.
const navigations = new WeakMap();

export function revealElement(element, { focus = false } = {}) {
  if (!element) return;
  const views = [];
  for (let node = element; node; node = node.parentElement) {
    if (node.hasAttribute("data-view")) views.unshift(node);
  }
  for (const view of views) {
    navigations.get(view.closest("[data-navigation]"))?.select(view.dataset.view);
  }
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (node.tagName === "DETAILS") node.open = true;
  }
  if (focus) element.focus({ preventScroll: true });
}

export function createNavigation(root, { hash = false, initial, onChange } = {}) {
  const owned = (selector) => [...root.querySelectorAll(selector)].filter((node) => node.closest("[data-navigation]") === root);
  const buttons = owned("[data-view-button]");
  const panels = owned("[data-view]");
  const storageKey = `tabwise-view-${root.dataset.navigation}`;
  let remembered;
  try { remembered = sessionStorage.getItem(storageKey); } catch {}
  let current;
  const positions = new Map();
  function select(id, { focus = false } = {}) {
    if (!panels.some((panel) => panel.dataset.view === id)) return false;
    if (current === id) { if (focus) buttons.find((button) => button.dataset.viewButton === id)?.focus(); return true; }
    if (current) positions.set(current, window.scrollY);
    const wasInside = panels.some((panel) => panel.dataset.view === current && panel.contains(document.activeElement));
    current = id;
    for (const button of buttons) {
      const active = button.dataset.viewButton === id;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.dataset.view !== id;
    if (hash) history.replaceState(null, "", `#${id}`);
    try { sessionStorage.setItem(storageKey, id); } catch {}
    if (focus || wasInside) buttons.find((button) => button.dataset.viewButton === id)?.focus({ preventScroll: true });
    window.scrollTo({ top: positions.get(id) || 0, behavior: "instant" });
    onChange?.(id);
    return true;
  }
  for (const button of buttons) {
    button.addEventListener("click", () => select(button.dataset.viewButton));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = buttons.indexOf(button);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
      select(buttons[next].dataset.viewButton, { focus: true });
    });
  }
  const navigation = { select, get current() { return current; } };
  navigations.set(root, navigation);
  select(hash && location.hash ? location.hash.slice(1) : initial || remembered || buttons[0]?.dataset.viewButton);
  if (!current) select(buttons[0]?.dataset.viewButton);
  if (hash) window.addEventListener("hashchange", () => select(location.hash.slice(1)));
  return navigation;
}
