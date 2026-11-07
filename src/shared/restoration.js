import { workspaceMetadata } from "./workspace-metadata.js";

export const restoreLoadOptions = (options = {}) => ({
  loadMode: options.loadMode === "on-demand" ? "on-demand" : "eager",
  concurrency: Number.isInteger(options.concurrency) ? Math.max(1, Math.min(5, options.concurrency)) : 5
});

export function sourceState(source) {
  // Opening a workspace changes access/archive state, not its reviewed content.
  const { restorePreset, ...metadata } = workspaceMetadata(source);
  const value = { id: source.id, name: source.name || "", ...metadata,
    deletedAt: source.deletedAt || 0,
    schemaVersion: source.schemaVersion || 1, windowCount: source.windowCount || 1, tabs: source.tabs, groups: source.groups || [] };
  const canonical = (item) => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])])) : item;
  return JSON.stringify(canonical(value));
}

export function resolveSavedResult(result, source) {
  const prefix = `${result.source}:${source.id}:`;
  const suffix = String(result.id || "").slice(prefix.length);
  const index = Number(suffix);
  const page = source.tabs[index];
  if (!["workspace", "checkpoint"].includes(result.source) || !String(result.id).startsWith(prefix)
    || !/^(0|[1-9]\d*)$/.test(suffix) || !Number.isInteger(index) || !page
    || source.deletedAt || result.url !== page.url) throw new Error("保存的页面已变化，请重新搜索。");
  return { ...page, index };
}

export function selectedRestorePages(pages, indices, existingUrls, skipExisting = true) {
  if (!Array.isArray(indices) || !indices.length) throw new Error("请至少选择一个页面。");
  if (indices.some((index) => !Number.isInteger(index) || !pages[index])) throw new Error("页面选择已失效，请重新预览。");
  const seen = new Set(existingUrls);
  return [...new Set(indices)].map((index) => {
    const page = pages[index];
    const skip = skipExisting && seen.has(page.url);
    seen.add(page.url);
    return { ...page, index, action: skip ? "skip" : "open" };
  });
}
