import { getWorkspaces, queueStorage } from "../shared/storage.js";
import { sourceState } from "../shared/restoration.js";
import { compareSnapshots, snapshotSignature } from "../shared/session.js";

const content = (source) => ({ schemaVersion: source.schemaVersion || 1, windowCount: source.windowCount || 1, tabs: source.tabs, groups: source.groups || [] });
export function createWorkspaceUpdates(snapshot, apply) {
  const source = async (id) => {
    const workspace = (await getWorkspaces()).find((item) => item.id === id);
    if (!workspace) throw new Error("工作区不存在，请刷新。");
    return workspace;
  };
  const windowFor = async (sender) => sender.tab?.windowId ?? (await chrome.windows.getLastFocused()).id;
  async function bindings() {
    const { workspaceBindings = {} } = await chrome.storage.session.get("workspaceBindings");
    const windows = new Set((await chrome.tabs.query({})).map((tab) => tab.windowId));
    const ids = new Set((await getWorkspaces()).map((item) => item.id));
    return Object.fromEntries(Object.entries(workspaceBindings).filter(([id, workspaceId]) => windows.has(Number(id)) && ids.has(workspaceId)));
  }
  return {
    bindings,
    async bind(id, sender) {
      await source(id);
      const windowId = await windowFor(sender);
      await queueStorage("session", async () => {
        await chrome.storage.session.set({ workspaceBindings: { ...await bindings(), [windowId]: id } });
      });
      return { ok: true, windowId };
    },
    async versions(id) { return (await source(id)).versions?.map(({ id, createdAt, tabs }) => ({ id, createdAt, count: tabs.length })) || []; },
    async prepare(message, sender) {
      if (!sender.documentId) throw new Error("请从 TabWise 界面预览工作区更新。");
      const workspace = await source(message.workspaceId);
      const windowId = await windowFor(sender);
      const rollback = Boolean(message.versionId);
      if (!rollback && (await bindings())[windowId] !== workspace.id) throw new Error("请先将当前窗口关联到此工作区。");
      const version = workspace.versions?.find((item) => item.id === message.versionId);
      if (rollback && !version) throw new Error("历史版本已移除，请重新选择。");
      const live = rollback ? null : await snapshot({ windowId });
      const target = content(rollback ? version : live);
      if (!target.tabs.length) throw new Error("当前窗口没有可保存的网页。");
      const preview = { id: crypto.randomUUID(), owner: sender.documentId, workspaceId: workspace.id, windowId,
        signature: sourceState(workspace), liveSignature: live && snapshotSignature(live), target, versionId: message.versionId,
        expiresAt: Date.now() + 5 * 60_000 };
      await queueStorage("session", async () => {
        const { workspaceUpdatePreviews = [] } = await chrome.storage.session.get("workspaceUpdatePreviews");
        await chrome.storage.session.set({ workspaceUpdatePreviews: [preview, ...workspaceUpdatePreviews.filter((item) => item.owner !== preview.owner && item.expiresAt > Date.now())].slice(0, 10) });
      });
      return { ok: true, previewId: preview.id, name: workspace.name, rollback, ...compareSnapshots(workspace, target) };
    },
    async confirm(id, sender) {
      const { workspaceUpdatePreviews = [] } = await chrome.storage.session.get("workspaceUpdatePreviews");
      const preview = workspaceUpdatePreviews.find((item) => item.id === id && item.owner === sender.documentId && item.expiresAt > Date.now());
      if (!preview) throw new Error("更新预览已过期，请重新预览。");
      const workspace = await source(preview.workspaceId);
      if (sourceState(workspace) !== preview.signature) throw new Error("工作区已变化，请重新预览。");
      if (preview.versionId) {
        const version = workspace.versions?.find((item) => item.id === preview.versionId);
        if (!version || snapshotSignature(version) !== snapshotSignature(preview.target)) throw new Error("历史版本已变化，请重新预览。");
      } else if ((await bindings())[preview.windowId] !== workspace.id || snapshotSignature(await snapshot({ windowId: preview.windowId })) !== preview.liveSignature) {
        throw new Error("当前窗口或关联已变化，请重新预览。");
      }
      const prior = { ...content(workspace), id: crypto.randomUUID(), createdAt: Date.now() };
      await queueStorage("session", () => chrome.storage.session.set({ workspaceUpdatePreviews: workspaceUpdatePreviews.filter((item) => item.id !== id) }));
      await apply(workspace, { ...preview.target, updatedAt: Date.now(), versions: [prior, ...(workspace.versions || [])].slice(0, 5) });
      return { ok: true };
    }
  };
}
