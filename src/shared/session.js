import { sameOperationState } from "./operations.js";

export function sanitizeSavedSnapshot(source) {
  const pages = (Array.isArray(source?.tabs) ? source.tabs : []).filter((page) => page && !page.incognito && /^https?:\/\//.test(page.url || "")).slice(0, 200);
  const title = (value) => String(value || "").slice(0, 300);
  if (source?.schemaVersion !== 2) return { tabs: pages.map((page) => ({ title: title(page.title), url: page.url })) };
  const ordinal = (value) => Number.isInteger(value) && value >= 0 && value < 10_000 ? value : 0;
  const colors = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
  const groups = (Array.isArray(source.groups) ? source.groups : []).filter((group) => group && typeof group.key === "string" && group.key.length <= 80).slice(0, 200)
    .map((group, id) => ({ id, key: group.key, windowId: ordinal(group.windowKey), title: title(group.title), color: colors.has(group.color) ? group.color : "grey", collapsed: Boolean(group.collapsed) }));
  return buildSessionSnapshot(pages.map((page, id) => ({
    id, url: page.url, title: title(page.title), windowId: ordinal(page.windowKey), index: ordinal(page.index),
    pinned: Boolean(page.pinned), active: Boolean(page.active), discarded: page.status === "suspended",
    groupId: groups.find((group) => group.key === page.groupKey && group.windowId === ordinal(page.windowKey))?.id ?? -1
  })), [], groups);
}

export function buildSessionSnapshot(tabs, records = [], groups = [], extensionOrigin = "") {
  const byTab = new Map((Array.isArray(records) ? records : Object.values(records)).map((record) => [record.tabId, record]));
  const windows = new Map();
  const windowCounts = new Map();
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const groupKeys = new Map();
  const pages = [];
  for (const tab of [...tabs].sort((a, b) => a.windowId - b.windowId || a.index - b.index)) {
    if (tab.incognito) continue;
    const record = byTab.get(tab.id);
    const placeholder = record && tab.url === `${extensionOrigin}/src/suspended/suspended.html#${record.recordId}`;
    const url = placeholder ? record.originalUrl : tab.pendingUrl || tab.url;
    if (!/^https?:\/\//.test(url || "")) continue;
    if (!windows.has(tab.windowId)) windows.set(tab.windowId, windows.size);
    const windowKey = windows.get(tab.windowId);
    const candidate = groupsById.get(tab.groupId);
    const group = candidate?.windowId === tab.windowId ? candidate : null;
    if (group && !groupKeys.has(group.id)) groupKeys.set(group.id, `group-${groupKeys.size}`);
    pages.push({
      title: String(placeholder ? record.title : tab.title || url), url,
      windowKey, index: windowCounts.get(windowKey) || 0,
      pinned: Boolean(tab.pinned), active: Boolean(tab.active),
      groupKey: group ? groupKeys.get(group.id) : "",
      status: placeholder || tab.discarded ? "suspended" : "open"
    });
    windowCounts.set(windowKey, (windowCounts.get(windowKey) || 0) + 1);
  }
  return {
    schemaVersion: 2, windowCount: windows.size, tabs: pages,
    groups: groups.filter((group) => groupKeys.has(group.id)).map((group) => ({
      key: groupKeys.get(group.id), windowKey: windows.get(group.windowId),
      title: group.title || "", color: group.color || "grey", collapsed: Boolean(group.collapsed)
    }))
  };
}

export function snapshotSignature(snapshot) {
  return JSON.stringify({
    tabs: (snapshot.tabs || []).map((page) => ({
      url: page.url, title: page.title || "", windowKey: page.windowKey ?? 0,
      index: page.index ?? 0, pinned: Boolean(page.pinned), active: Boolean(page.active),
      groupKey: page.groupKey || "", status: page.status || "open"
    })),
    groups: (snapshot.groups || []).map(({ key, windowKey, title, color, collapsed }) => [key, windowKey, title, color, collapsed])
  });
}

export function compareSnapshots(before, after) {
  const available = new Map();
  const beforeGroups = new Map((before.groups || []).map((group) => [group.key, group]));
  const afterGroups = new Map((after.groups || []).map((group) => [group.key, group]));
  after.tabs.forEach((page, index) => {
    if (!available.has(page.url)) available.set(page.url, { cursor: 0, pages: [] });
    available.get(page.url).pages.push({ page, index });
  });
  const removed = [];
  const changed = [];
  const layout = (page, groups) => ({
    title: page.title || "",
    active: Boolean(page.active),
    pinned: Boolean(page.pinned), windowKey: page.windowKey ?? 0, index: page.index ?? 0,
    group: groups.get(page.groupKey) || null,
    status: page.status || "open"
  });
  before.tabs.forEach((page, index) => {
    const entry = available.get(page.url);
    const match = entry?.pages[entry.cursor++];
    if (!match) removed.push({ ...page, index });
    else if (!sameOperationState(layout(page, beforeGroups), layout(match.page, afterGroups))) changed.push({ url: page.url, title: page.title || page.url, before: page, after: match.page });
  });
  return { added: [...available.values()].flatMap(({ pages, cursor }) => pages.slice(cursor).map(({ page, index }) => ({ ...page, index }))), removed, changed };
}
