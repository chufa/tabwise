import { getContextTasks, changeContextTasks } from "../shared/context-storage.js";
import { createContextTask, updateContextTask, normalizeContextSource, normalizeContextTask, exportContextMarkdown } from "../shared/task-context.js";
import { buildContextInput, buildContextPrompt, CONTEXT_BRIEF_SCHEMA, validateContextBrief, adoptContextBrief } from "../shared/task-context-ai.js";
import { buildOllamaRequest } from "../shared/ollama.js";
import { modelRecipient, sameModel } from "../shared/ai-provider.js";

export const CONTEXT_COMMANDS = new Set(["listContextTasks", "createContextTask", "updateContextTask", "deleteContextTask",
  "resumeContextTask", "prepareContextSources", "attachContextSources", "prepareContextBrief", "beginContextBrief",
  "generateContextBrief", "acceptContextBrief", "cancelContextBrief", "adoptContextBrief", "exportContextTask"]);
const find = (tasks, id) => {
  const task = tasks.find((item) => item.id === id);
  if (!task) throw new Error("任务已删除，请刷新列表。");
  return task;
};
const selected = (ids, items) => {
  if (!Array.isArray(ids) || ids.length > 20 || new Set(ids).size !== ids.length) throw new Error("最多选择 20 个资料。");
  return ids.map((id) => {
    const item = items.find((entry) => entry.id === id);
    if (!item) throw new Error("资料选择无效，请重新预览。");
    return item;
  });
};
const requireConfirm = (confirm) => { if (confirm !== true) throw new Error("请明确确认此次操作。"); };

export function createContextManager({ getTabs, getWindowId, getWorkspaces, getSettings, fetchOllama,
  getModelConfig = async () => modelRecipient(await getSettings()), generateModel }) {
  // Drafts belong to the currently open document. Restart always invalidates them.
  const snapshots = new Map();
  const authorize = (sender) => {
    if (sender?.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("src/sidepanel/sidepanel.html") || !sender.documentId) {
      throw new Error("任务记忆仅可从 TabWise 侧栏操作。");
    }
  };
  const invalidate = (snapshot) => { snapshot.controller?.abort(); snapshots.delete(snapshot.id); };
  const remember = (value, sender) => {
    for (const entry of snapshots.values()) if (entry.owner === sender.documentId && entry.kind === value.kind || entry.expiresAt <= Date.now()) invalidate(entry);
    while (snapshots.size >= 10) invalidate(snapshots.values().next().value);
    const snapshot = { ...value, id: crypto.randomUUID(), owner: sender.documentId, expiresAt: Date.now() + 10 * 60_000 };
    snapshots.set(snapshot.id, snapshot);
    return snapshot;
  };
  const owned = (id, sender, kind) => {
    const snapshot = snapshots.get(id);
    if (!snapshot || snapshot.owner !== sender.documentId || snapshot.kind !== kind || snapshot.expiresAt <= Date.now()) throw new Error("预览已过期或已停止，请重新预览。");
    return snapshot;
  };
  const currentTask = async (snapshot) => {
    const task = find(await getContextTasks(), snapshot.taskId);
    if (task.revision !== snapshot.revision) throw new Error("任务已变化，请重新预览。");
    return task;
  };
  const begin = async (snapshot) => {
    if (snapshot.state !== "preview") throw new Error("该预览已开始生成，请重新预览。");
    await currentTask(snapshot);
    const configured = await getModelConfig();
    if (!sameModel(configured, snapshot)) throw new Error("模型设置已变化，请重新预览接收方。");
    if (!snapshots.has(snapshot.id)) throw new Error("生成已停止。");
    snapshot.state = "generating";
    snapshot.controller = new AbortController();
  };
  const accept = async (snapshot, answer) => {
    if (!snapshots.has(snapshot.id)) throw new Error("生成已停止，请重新预览。");
    if (snapshot.state !== "generating") throw new Error("请先开始生成续接草稿。");
    await currentTask(snapshot);
    const brief = validateContextBrief(answer, snapshot.input);
    if (!sameModel(await getModelConfig(), snapshot)) throw new Error("模型设置已变化，请重新预览。");
    if (!snapshots.has(snapshot.id) || snapshot.controller.signal.aborted) throw new Error("生成已停止。");
    snapshot.state = "ready";
    return { ok: true, brief };
  };
  const candidates = async (kind, workspaceId, windowId) => {
    if (kind === "current") return (await getTabs()).filter((tab) => tab.windowId === windowId && !tab.incognito).flatMap((tab) => {
      try { return [{ binding: tab.id, ...normalizeContextSource({ id: crypto.randomUUID(), title: tab.title, url: tab.logicalUrl || tab.url }) }]; } catch { return []; }
    });
    if (kind !== "workspace") throw new Error("资料范围无效。");
    const workspace = (await getWorkspaces()).find((item) => item.id === workspaceId);
    if (!workspace) throw new Error("工作区已变化，请重新选择。");
    return workspace.tabs.flatMap((tab, index) => {
      try { return [{ binding: index, ...normalizeContextSource({ ...tab, id: crypto.randomUUID() }) }]; } catch { return []; }
    });
  };
  return {
    disconnect(snapshotId, sender) {
      authorize(sender);
      const snapshot = snapshots.get(snapshotId);
      if (snapshot?.owner === sender.documentId && snapshot.state === "generating") invalidate(snapshot);
    },
    async handle(message, sender) {
      authorize(sender);
      const m = message;
      switch (m.type) {
        case "listContextTasks": return { ok: true, tasks: await getContextTasks(), workspaces: (await getWorkspaces()).map(({ id, name }) => ({ id, name })) };
        case "createContextTask": return changeContextTasks((tasks) => {
          const task = createContextTask(m.fields, []); tasks.unshift(task); return { ok: true, task };
        });
        case "updateContextTask": return changeContextTasks((tasks) => {
          const task = find(tasks, m.taskId), updated = updateContextTask(task, m.patch, m.revision);
          tasks[tasks.indexOf(task)] = updated; return { ok: true, task: updated };
        });
        case "deleteContextTask": return changeContextTasks((tasks) => {
          requireConfirm(m.confirm);
          const task = find(tasks, m.taskId);
          if (task.revision !== m.revision) throw new Error("任务已变化，请重新读取。");
          tasks.splice(tasks.indexOf(task), 1); return { ok: true };
        });
        case "resumeContextTask": return changeContextTasks((tasks) => {
          const task = find(tasks, m.taskId); task.lastResumedAt = Date.now(); return { ok: true, task };
        });
        case "exportContextTask": {
          const task = find(await getContextTasks(), m.taskId);
          return { ok: true, name: task.name, markdown: exportContextMarkdown(task), json: JSON.stringify({ schemaVersion: 1, task }, null, 2) };
        }
        case "prepareContextSources": {
          const windowId = sender.tab?.windowId ?? await getWindowId();
          const sources = await candidates(m.kind, m.workspaceId, windowId);
          const snapshot = remember({ kind: "sources", sourceKind: m.kind, workspaceId: m.workspaceId, windowId, sources }, sender);
          return { ok: true, id: snapshot.id, sources: sources.map(({ binding, ...source }) => source) };
        }
        case "attachContextSources": {
          requireConfirm(m.confirm);
          const snapshot = owned(m.previewId, sender, "sources"), chosen = selected(m.sourceIds, snapshot.sources);
          if (!chosen.length) throw new Error("请选择要加入的资料。");
          const live = await candidates(snapshot.sourceKind, snapshot.workspaceId, snapshot.windowId);
          if (chosen.some((source) => !live.some((item) => item.binding === source.binding && item.url === source.url && item.title === source.title))) throw new Error("资料页面已变化，请重新预览。");
          const result = await changeContextTasks((tasks) => {
            owned(snapshot.id, sender, "sources");
            const task = find(tasks, m.taskId);
            if (task.revision !== m.revision) throw new Error("任务已变化，请重新读取。");
            const urls = new Set(task.sources.map((source) => source.url));
            const sources = [...task.sources, ...chosen.filter((source) => !urls.has(source.url) && urls.add(source.url)).map(({ binding, ...source }) => source)];
            const updated = normalizeContextTask({ ...task, sources, revision: task.revision + 1, updatedAt: Date.now(),
              ...(task.acceptedBrief ? { acceptedBrief: { ...task.acceptedBrief, stale: true } } : {}) });
            tasks[tasks.indexOf(task)] = updated; return { ok: true, task: updated };
          });
          invalidate(snapshot); return result;
        }
        case "prepareContextBrief": {
          const task = find(await getContextTasks(), m.taskId);
          const snapshot = remember({ kind: "brief", taskId: task.id, revision: task.revision, ...await getModelConfig(), state: "preview" }, sender);
          snapshot.input = buildContextInput(task, m.sourceIds, snapshot.id);
          return { ok: true, snapshot: { id: snapshot.id, input: snapshot.input, expiresAt: snapshot.expiresAt }, provider: snapshot.provider,
            model: snapshot.model, endpoint: snapshot.endpoint, prompt: buildContextPrompt(snapshot.input), schema: CONTEXT_BRIEF_SCHEMA };
        }
        case "beginContextBrief": {
          const snapshot = owned(m.snapshotId, sender, "brief");
          if (snapshot.provider !== "browser") throw new Error("模型接收方不匹配。");
          await begin(snapshot); return { ok: true };
        }
        case "generateContextBrief": {
          const snapshot = owned(m.snapshotId, sender, "brief");
          if (snapshot.provider === "browser") throw new Error("模型接收方不匹配。");
          await begin(snapshot);
          try {
            if (generateModel) {
              const result = await generateModel(snapshot, buildContextPrompt(snapshot.input), CONTEXT_BRIEF_SCHEMA,
                { signal: snapshot.controller.signal, maxTokens: 2400 });
              return { ...await accept(snapshot, result.answer), latencyMs: result.latencyMs, usage: result.usage };
            }
            const request = buildOllamaRequest(buildContextPrompt(snapshot.input), snapshot.model, CONTEXT_BRIEF_SCHEMA);
            request.options.num_predict = 2400;
            const body = await fetchOllama(snapshot.endpoint, "/api/generate", {
              method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request)
            }, 60_000, snapshot.controller.signal);
            return await accept(snapshot, body?.response);
          } catch (error) { invalidate(snapshot); throw error; }
        }
        case "acceptContextBrief": {
          const snapshot = owned(m.snapshotId, sender, "brief");
          if (snapshot.provider !== "browser") throw new Error("模型接收方不匹配。");
          return accept(snapshot, m.answer);
        }
        case "cancelContextBrief": {
          const snapshot = snapshots.get(m.snapshotId);
          if (snapshot?.owner === sender.documentId) invalidate(snapshot);
          return { ok: true };
        }
        case "adoptContextBrief": {
          const snapshot = owned(m.snapshotId, sender, "brief");
          if (snapshot.state !== "ready") throw new Error("请先生成并审阅续接草稿。");
          const result = await changeContextTasks((tasks) => {
            owned(snapshot.id, sender, "brief");
            const task = find(tasks, snapshot.taskId), updated = adoptContextBrief(task, m.brief, snapshot, m.confirm);
            tasks[tasks.indexOf(task)] = updated; return { ok: true, task: updated };
          });
          invalidate(snapshot); return result;
        }
        default: throw new Error("任务记忆指令无效。");
      }
    }
  };
}
