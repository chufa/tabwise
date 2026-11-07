import { getActivity, getSettings, getWorkspaces, queueStorage } from "../shared/storage.js";
import { sourceState } from "../shared/restoration.js";
import { duplicateConsolidation, checkLink } from "../shared/organization.js";
import { mapConcurrent } from "../shared/scanning.js";

const KEY = "organizationPreviews";
export function createOrganization({ block, revision }) {
  async function store(preview, sender) {
    if (!sender.documentId) throw new Error("请从 TabWise 界面生成预览。");
    return queueStorage("session", async () => {
      const { organizationPreviews = [] } = await chrome.storage.session.get(KEY);
      const item = { ...preview, id: crypto.randomUUID(), owner: sender.documentId, expiresAt: Date.now() + 300000 };
      await chrome.storage.session.set({ [KEY]: [item, ...organizationPreviews.filter((entry) => entry.owner !== sender.documentId && entry.expiresAt > Date.now())].slice(0, 10) });
      return { ok: true, ...item };
    });
  }
  async function consume(id, sender, kind) {
    return queueStorage("session", async () => {
      const { organizationPreviews = [] } = await chrome.storage.session.get(KEY);
      const preview = organizationPreviews.find((item) => item.id === id && item.owner === sender.documentId && item.kind === kind && item.expiresAt > Date.now());
      if (!preview) throw new Error("预览已过期或已执行，请重新预览。");
      await chrome.storage.session.set({ [KEY]: organizationPreviews.filter((item) => item.id !== id) });
      return preview;
    });
  }
  return {
    async duplicates(message, sender) {
      const ids = message.tabIds;
      if (ids && (!Array.isArray(ids) || ids.length > 5000 || ids.some((id) => !Number.isInteger(id)))) throw new Error("页面范围无效。");
      const tabs = (await chrome.tabs.query(sender.tab?.windowId ? { windowId: sender.tab.windowId } : { currentWindow: true })).filter((tab) => !ids || ids.includes(tab.id));
      const settings = await getSettings(), activity = await getActivity(), blocked = {};
      for (const tab of tabs) blocked[tab.id] = await block(tab, settings, { url: tab.url, revision: revision(tab.id), lastActivity: activity[tab.id] });
      const pages = duplicateConsolidation(tabs, blocked).map((page, index) => ({ ...page, index,
        revision: revision(page.tabId), keepRevision: revision(page.keepTabId), lastActivity: activity[page.tabId] }));
      return store({ kind: "duplicates", pages }, sender);
    },
    async consolidate(message, sender) {
      if (message.confirm !== true || !Array.isArray(message.indices) || !message.indices.length) throw new Error("请确认要关闭的重复页面。");
      const preview = await consume(message.previewId, sender, "duplicates");
      if (message.indices.some((index) => !Number.isInteger(index) || !preview.pages[index])) throw new Error("页面选择无效。");
      const results = [];
      for (const index of new Set(message.indices)) {
        const page = preview.pages[index];
        const [tab, keep] = await Promise.all([chrome.tabs.get(page.tabId).catch(() => null), chrome.tabs.get(page.keepTabId).catch(() => null)]);
        const reason = !tab || !keep || keep.url !== page.url || keep.pendingUrl || keep.windowId !== page.windowId
          || revision(keep.id) !== page.keepRevision || tab.windowId !== page.windowId ? "保留页或重复页已变化。" : await block(tab, await getSettings(), page);
        if (reason) { results.push({ index, status: "skipped", reason }); continue; }
        try { await chrome.tabs.remove(tab.id); results.push({ index, status: "closed", title: page.title }); }
        catch (error) { results.push({ index, status: "failed", reason: error.message }); }
      }
      return { ok: true, results, count: results.filter((item) => item.status === "closed").length };
    },
    async prepareLinks(message, sender) {
      const workspace = (await getWorkspaces()).find((item) => item.id === message.workspaceId);
      if (!workspace) throw new Error("工作区不存在。");
      return store({ kind: "links", workspaceId: workspace.id, signature: sourceState(workspace),
        pages: workspace.tabs.map((page, index) => ({ ...page, index })) }, sender);
    },
    async links(message, sender) {
      if (message.confirm !== true || !Array.isArray(message.indices) || !message.indices.length || message.indices.length > 50) throw new Error("请明确选择 1–50 个要检测的链接。");
      const preview = await consume(message.previewId, sender, "links");
      const current = (await getWorkspaces()).find((item) => item.id === preview.workspaceId);
      if (!current || sourceState(current) !== preview.signature) throw new Error("工作区已变化，请重新预览。");
      const indices = [...new Set(message.indices)];
      if (indices.some((index) => !Number.isInteger(index) || !preview.pages[index])) throw new Error("链接选择无效。");
      const origins = [...new Set(indices.map((index) => { const url = new URL(preview.pages[index].url); return `${url.protocol}//${url.hostname}/*`; }))];
      if (!await chrome.permissions.contains({ origins })) throw new Error("尚未授予所选网站访问权限。");
      const results = await mapConcurrent(indices, 3, async (index) => ({ index, title: preview.pages[index].title,
        ...await checkLink(preview.pages[index].url) }));
      return { ok: true, results };
    }
  };
}
