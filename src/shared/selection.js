export function createSelection({ key = (item) => item.id, selected = false, limit = Infinity } = {}) {
  let items = [], filtered = [], page = 0, query = "", initialized = false;
  const chosen = new Set();
  const applyFilter = () => {
    filtered = query ? items.filter((item) => `${item.title || ""} ${item.url || ""} ${item.domain || ""}`.toLowerCase().includes(query)) : items;
    page = Math.max(0, Math.min(page, Math.ceil(filtered.length / 50) - 1));
  };
  return {
    setData(next) {
      items = next;
      const keys = new Set(items.map(key));
      for (const value of chosen) if (!keys.has(value)) chosen.delete(value);
      if (!initialized && selected) items.slice(0, limit).forEach((item) => chosen.add(key(item)));
      initialized = true; applyFilter();
    },
    filter(value) { query = value.trim().toLowerCase(); page = 0; applyFilter(); },
    move(delta) { page += delta; applyFilter(); },
    toggle(value, checked) {
      if (checked && !chosen.has(value) && chosen.size >= limit) return false;
      if (checked) chosen.add(value); else chosen.delete(value);
      return true;
    },
    selectAll(checked) { chosen.clear(); if (checked) items.slice(0, limit).forEach((item) => chosen.add(key(item))); },
    setValues(values) { const allowed = new Set(items.map(key)); chosen.clear(); for (const value of values) if (allowed.has(value) && chosen.size < limit) chosen.add(value); },
    has: (value) => chosen.has(value),
    values: () => items.filter((item) => chosen.has(key(item))).map(key),
    view: () => ({ items: filtered.slice(page * 50, (page + 1) * 50), page, pages: Math.max(1, Math.ceil(filtered.length / 50)), total: items.length, matches: filtered.length, count: chosen.size })
  };
}
