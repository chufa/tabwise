export function normalizePageTags(value = []) {
  if (!Array.isArray(value)) throw new Error("页面标签格式无效。");
  const tags = [...new Set(value.map((tag) => String(tag).trim()).filter(Boolean))];
  if (tags.length > 12 || tags.some((tag) => tag.length > 30)) throw new Error("页面最多 12 个标签，每个最多 30 字。");
  return tags;
}
export function normalizeRestorePreset(value = {}, hasLayout = false) {
  if (value.loadMode !== undefined && !["eager", "on-demand"].includes(value.loadMode)) throw new Error("恢复加载方式无效。");
  if (value.concurrency !== undefined && (!Number.isInteger(value.concurrency) || value.concurrency < 1 || value.concurrency > 5)) throw new Error("恢复并发数需为 1–5。");
  return { loadMode: value.loadMode || "eager", concurrency: value.concurrency ?? 5,
    restoreLayout: value.restoreLayout === undefined ? hasLayout : value.restoreLayout === true,
    skipExisting: value.skipExisting !== false, tag: String(value.tag || "").slice(0, 30) };
}
export const restoreTagIndices = (pages, tag) => pages.flatMap((page, index) => !tag || (page.tags || []).includes(tag) ? [index] : []);

export function inheritPageTags(pages, saved) {
  const byUrl = new Map();
  for (const page of saved) {
    if (!byUrl.has(page.url)) byUrl.set(page.url, []);
    byUrl.get(page.url).push(page);
  }
  const cursors = new Map();
  return pages.map((page) => {
    const index = cursors.get(page.url) || 0;
    cursors.set(page.url, index + 1);
    const prior = byUrl.get(page.url)?.[index];
    return page.tags || !prior?.tags ? page : { ...page, tags: normalizePageTags(prior.tags) };
  });
}
