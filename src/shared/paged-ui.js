import { createSelection } from "./selection.js";
import { escapeHtml } from "./html.js";
import { updateHTML } from "./live-ui.js";

export function createPagedList(host, { key = (item) => item.index, selected = false, selectable = true, limit = Infinity, render, onChange = () => {} } = {}) {
  const model = createSelection({ key, selected, limit });
  host.innerHTML = `<label class="page-search-label">查找列表<input class="list-search" type="search" placeholder="标题或网址"></label>
    ${selectable ? `<div class="saved-actions">${limit === Infinity ? '<button type="button" data-list="all">选择全部页</button><button type="button" data-list="none">清空全部选择</button>' : ""}<span class="list-selection" role="status"></span></div>` : ""}
    <div class="paged-rows"></div><nav class="saved-actions list-pagination" aria-label="列表分页"></nav>`;
  function draw() {
    const view = model.view();
    updateHTML(host.querySelector(".paged-rows"), view.items.map((item) => {
      const value = key(item);
      const body = render ? render(item) : `<span><strong>${escapeHtml(item.title || item.url)}</strong><small>${escapeHtml(item.url || item.domain || "")}</small></span>`;
      return `<${selectable ? "label" : "div"} class="saved-member" data-key="${escapeHtml(value)}">${selectable ? `<input type="checkbox" value="${escapeHtml(value)}" ${model.has(value) ? "checked" : ""}>` : ""}${body}</${selectable ? "label" : "div"}>`;
    }).join("") || '<p class="saved-hint">暂无匹配项。</p>');
    const count = host.querySelector(".list-selection");
    if (count) count.textContent = `已选 ${view.count} / ${view.total} 页${limit < Infinity ? ` · 最多 ${limit} 页` : ""}`;
    updateHTML(host.querySelector(".list-pagination"), `<button type="button" data-list="prev" ${view.page ? "" : "disabled"}>上一页</button>
      <span>第 ${view.page + 1} / ${view.pages} 页 · 匹配 ${view.matches} 项</span><button type="button" data-list="next" ${view.page + 1 >= view.pages ? "disabled" : ""}>下一页</button>`);
  }
  const search = host.querySelector(".list-search");
  const onInput = (event) => { model.filter(event.target.value); draw(); };
  const onSelection = (event) => {
    if (!event.target.matches('.paged-rows input[type="checkbox"]')) return;
    const item = model.view().items.find((item) => String(key(item)) === event.target.value);
    if (item) {
      if (!model.toggle(key(item), event.target.checked)) event.target.checked = false;
      draw(); onChange(model.values());
    }
  };
  const onClick = (event) => {
    const button = event.target.closest("[data-list]");
    if (!button || button.disabled) return;
    const action = button.dataset.list;
    if (action === "all" || action === "none") { model.selectAll(action === "all"); onChange(model.values()); }
    else model.move(action === "next" ? 1 : -1);
    draw();
  };
  search.addEventListener("input", onInput);
  host.addEventListener("change", onSelection);
  host.addEventListener("click", onClick);
  return {
    setData(items) { model.setData(items); draw(); },
    setValues(values) { model.setValues(values); draw(); onChange(model.values()); },
    values: model.values,
    destroy() { search.removeEventListener("input", onInput); host.removeEventListener("change", onSelection); host.removeEventListener("click", onClick); },
    selectAll(checked) { model.selectAll(checked); draw(); onChange(model.values()); }
  };
}
