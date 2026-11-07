import { snapshotSignature } from "./session.js";
import { normalizeRestorePreset } from "./workspace-presets.js";

export function workspaceMetadata(value = {}) {
  if (value.tags !== undefined && !Array.isArray(value.tags)) throw new Error("标签格式无效。");
  const tags = [...new Set((value.tags || []).map((tag) => String(tag).trim()).filter(Boolean))];
  if (tags.length > 12 || tags.some((tag) => tag.length > 30)) throw new Error("最多 12 个标签，每个最多 30 字。");
  const notes = String(value.notes || "").trim();
  if (notes.length > 2000) throw new Error("备注最多 2000 字。");
  return { tags, notes, favorite: Boolean(value.favorite),
    ...(value.restorePreset ? { restorePreset: normalizeRestorePreset(value.restorePreset) } : {}) };
}

export function workspaceContentSignature(value) {
  const { tags, favorite } = workspaceMetadata(value);
  return JSON.stringify({ name: value.name || "", tags, favorite, pinned: Boolean(value.pinned),
    archived: Boolean(value.archived), restorePreset: value.restorePreset, snapshot: snapshotSignature(value) });
}

export function filterWorkspaces(workspaces, filter = {}) {
  const query = String(filter.query || "").trim().toLowerCase();
  return workspaces.filter((workspace) => (!filter.favorite || workspace.favorite)
    && (!filter.tag || (workspace.tags || []).includes(filter.tag))
    && (filter.status !== "active" || !workspace.archived)
    && (filter.status !== "archived" || workspace.archived)
    && (!query || `${workspace.name} ${(workspace.tags || []).join(" ")} ${workspace.notes || ""} ${workspace.tabs.map((tab) => `${tab.title} ${tab.url} ${(tab.tags || []).join(" ")}`).join(" ")}`.toLowerCase().includes(query)));
}

export function normalizeWorkspaceFilters(values) {
  if (!Array.isArray(values) || values.length > 10) throw new Error("最多保存 10 个筛选条件。");
  return values.map((value) => {
    const name = String(value.name || "").trim();
    if (!name || name.length > 40 || String(value.query || "").length > 200 || String(value.tag || "").length > 30) throw new Error("筛选名称或条件过长。");
    return { name, query: String(value.query || "").trim(), tag: String(value.tag || "").trim(),
      favorite: Boolean(value.favorite), status: ["active", "archived"].includes(value.status) ? value.status : "all" };
  });
}
