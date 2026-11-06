import { domainForUrl } from "./policy.js";

export function buildLifecycle({ tabs = [], activity = {}, idleThresholdMs = 0, now = Date.now(), candidates = [], records = {}, workspaces = [] }) {
  const suggested = new Set(candidates.map((item) => item.tabId));
  const items = tabs.filter((tab) => /^https?:\/\//.test(tab.url || "")).map((tab) => ({
    id: `tab:${tab.id}`, title: tab.title || domainForUrl(tab.url), domain: domainForUrl(tab.url),
    state: tab.active ? "active" : suggested.has(tab.id) ? "suggested" : now - (activity[tab.id] || now) >= idleThresholdMs ? "idle" : "open"
  }));
  for (const record of Object.values(records)) items.push({ id: `record:${record.recordId}`, title: record.title || domainForUrl(record.originalUrl), domain: domainForUrl(record.originalUrl), state: "suspended" });
  for (const workspace of workspaces.filter((item) => item.archived)) {
    for (const tab of workspace.tabs || []) items.push({ id: `archive:${workspace.id}:${tab.url}`, title: tab.title || domainForUrl(tab.url), domain: domainForUrl(tab.url), state: "archived" });
  }
  return items;
}
