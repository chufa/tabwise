import { getContextTasks, changeContextTasks } from "../shared/context-storage.js";
import { createContextTask, updateContextTask, normalizeContextSource, normalizeContextTask, exportContextMarkdown } from "../shared/task-context.js";
import { buildContextInput, buildContextPrompt, CONTEXT_BRIEF_SCHEMA, validateContextBrief, adoptContextBrief,
  buildEvidenceInput, buildEvidencePrompt, EVIDENCE_ANSWER_SCHEMA, validateEvidenceAnswer } from "../shared/task-context-ai.js";
import { buildOllamaRequest } from "../shared/ollama.js";
import { modelRecipient, sameModel } from "../shared/ai-provider.js";
import { isExtensionPage } from "../shared/extension-page.js";

export const CONTEXT_COMMANDS = new Set(["listContextTasks", "createContextTask", "updateContextTask", "deleteContextTask",
  "resumeContextTask", "prepareContextSources", "attachContextSources", "prepareContextBrief", "beginContextBrief",
  "generateContextBrief", "acceptContextBrief", "cancelContextBrief", "adoptContextBrief", "exportContextTask",
  "attachSearchContextSource", "prepareEvidenceAnswer", "beginEvidenceAnswer", "generateEvidenceAnswer",
  "acceptEvidenceAnswer", "saveEvidenceAnswer", "cancelEvidenceAnswer"]);
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
  getModelConfig = async () => modelRecipient(await getSettings()), generateModel, resolveSearchSource }) {
  // Drafts belong to the currently open document. Restart always invalidates them.
  const snapshots = new Map();
  const authorize = (sender) => {
    if (!isExtensionPage(sender, "src/sidepanel/sidepanel.html") || !sender.documentId) {
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
  const acceptEvidence = async (snapshot, answer) => {
    if (!snapshots.has(snapshot.id) || snapshot.state !== "generating") throw new Error("请先开始生成证据回答。");
    await currentTask(snapshot);
    const evidence = validateEvidenceAnswer(answer, snapshot.input);
    if (!sameModel(await getModelConfig(), snapshot)) throw new Error("模型设置已变化，请重新预览接收方。");
    if (!snapshots.has(snapshot.id) || snapshot.controller.signal.aborted) throw new Error("生成已停止。");
    snapshot.state = "ready";
    return { ok: true, evidence };
  };
  const candidates = async (kind, workspaceId, windowId, relatedUrls = []) => {
    if (kind === "current") return (await getTabs()).filter((tab) => tab.windowId === windowId && !tab.incognito).flatMap((tab) => {
      try { return [{ binding: tab.id, ...normalizeContextSource({ id: crypto.randomUUID(), title: tab.title, url: tab.logicalUrl || tab.url }) }]; } catch { return []; }
    });
    if (kind === "related") {
      const urls = new Set(relatedUrls);
      const domains = new Set(relatedUrls.map((url) => { try { return new URL(url).hostname; } catch { return ""; } }).filter(Boolean));
      return (await getTabs()).filter((tab) => !tab.incognito).flatMap((tab) => {
        const url = tab.logicalUrl || tab.url;
        try {
          const source = normalizeContextSource({ id: crypto.randomUUID(), title: tab.title, url });
          if (!urls.has(source.url) && !domains.has(new URL(source.url).hostname)) return [];
          return [{ binding: tab.id, ...source }];
        } catch { return []; }
      });
    }
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
          const task = m.kind === "related" ? find(await getContextTasks(), m.taskId) : null;
          const relatedUrls = task?.sources.map((source) => source.url) || [];
          const sources = await candidates(m.kind, m.workspaceId, windowId, relatedUrls);
          const snapshot = remember({ kind: "sources", sourceKind: m.kind, workspaceId: m.workspaceId, windowId, relatedUrls, sources }, sender);
          return { ok: true, id: snapshot.id, sources: sources.map(({ binding, ...source }) => source) };
        }
        case "attachContextSources": {
          requireConfirm(m.confirm);
          const snapshot = owned(m.previewId, sender, "sources"), chosen = selected(m.sourceIds, snapshot.sources);
          if (!chosen.length) throw new Error("请选择要加入的资料。");
          const live = await candidates(snapshot.sourceKind, snapshot.workspaceId, snapshot.windowId, snapshot.relatedUrls);
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
        case "attachSearchContextSource": {
          requireConfirm(m.confirm);
          if (typeof resolveSearchSource !== "function") throw new Error("当前页面搜索不可用，请重新打开侧栏。");
          const live = normalizeContextSource({ id: crypto.randomUUID(), ...await resolveSearchSource(m.result) });
          return changeContextTasks((tasks) => {
            const task = find(tasks, m.taskId);
            if (task.revision !== m.revision) throw new Error("任务已变化，请重新读取。");
            if (task.sources.some((source) => source.url === live.url)) return { ok: true, task, duplicate: true };
            if (task.sources.length >= 20) throw new Error("每个任务最多 20 个资料。");
            const updated = normalizeContextTask({ ...task, sources: [...task.sources, live], revision: task.revision + 1, updatedAt: Date.now(),
              ...(task.acceptedBrief ? { acceptedBrief: { ...task.acceptedBrief, stale: true } } : {}) });
            tasks[tasks.indexOf(task)] = updated;
            return { ok: true, task: updated };
          });
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
        case "prepareEvidenceAnswer": {
          const task = find(await getContextTasks(), m.taskId);
          const snapshot = remember({ kind: "evidence", taskId: task.id, revision: task.revision, ...await getModelConfig(), state: "preview" }, sender);
          snapshot.input = buildEvidenceInput(task, m.question, m.sourceIds, snapshot.id);
          return { ok: true, snapshot: { id: snapshot.id, input: snapshot.input, expiresAt: snapshot.expiresAt }, provider: snapshot.provider,
            model: snapshot.model, endpoint: snapshot.endpoint, prompt: buildEvidencePrompt(snapshot.input), schema: EVIDENCE_ANSWER_SCHEMA };
        }
        case "beginEvidenceAnswer": {
          const snapshot = owned(m.snapshotId, sender, "evidence");
          if (snapshot.provider !== "browser") throw new Error("模型接收方不匹配。");
          await begin(snapshot); return { ok: true };
        }
        case "generateEvidenceAnswer": {
          const snapshot = owned(m.snapshotId, sender, "evidence");
          if (snapshot.provider === "browser") throw new Error("模型接收方不匹配。");
          await begin(snapshot);
          try {
            if (generateModel) {
              const result = await generateModel(snapshot, buildEvidencePrompt(snapshot.input), EVIDENCE_ANSWER_SCHEMA,
                { signal: snapshot.controller.signal, maxTokens: 1800 });
              return { ...await acceptEvidence(snapshot, result.answer), latencyMs: result.latencyMs, usage: result.usage };
            }
            const request = buildOllamaRequest(buildEvidencePrompt(snapshot.input), snapshot.model, EVIDENCE_ANSWER_SCHEMA);
            request.options.num_predict = 1800;
            const body = await fetchOllama(snapshot.endpoint, "/api/generate", {
              method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request)
            }, 60_000, snapshot.controller.signal);
            return await acceptEvidence(snapshot, body?.response);
          } catch (error) { invalidate(snapshot); throw error; }
        }
        case "acceptEvidenceAnswer": {
          const snapshot = owned(m.snapshotId, sender, "evidence");
          if (snapshot.provider !== "browser") throw new Error("模型接收方不匹配。");
          return acceptEvidence(snapshot, m.answer);
        }
        case "saveEvidenceAnswer": {
          const snapshot = owned(m.snapshotId, sender, "evidence");
          if (snapshot.state !== "ready") throw new Error("请先生成并审阅证据回答。");
          requireConfirm(m.confirm);
          const result = await changeContextTasks((tasks) => {
            owned(snapshot.id, sender, "evidence");
            const task = find(tasks, snapshot.taskId);
            if (task.revision !== snapshot.revision) throw new Error("任务已变化，请重新预览。");
            const evidence = validateEvidenceAnswer(m.evidence, snapshot.input);
            const item = { id: crypto.randomUUID(), question: snapshot.input.question, answer: evidence.answer,
              sourceIds: evidence.sourceIds, uncertainties: evidence.uncertainties, createdAt: Date.now(),
              provider: snapshot.provider, model: snapshot.model, stale: false };
            const updated = normalizeContextTask({ ...task, revision: task.revision + 1, updatedAt: Date.now(),
              evidenceAnswers: [item, ...(task.evidenceAnswers || [])].slice(0, 12) });
            tasks[tasks.indexOf(task)] = updated;
            return { ok: true, task: updated, evidence: item };
          });
          invalidate(snapshot); return result;
        }
        case "cancelEvidenceAnswer": {
          const snapshot = snapshots.get(m.snapshotId);
          if (snapshot?.owner === sender.documentId) invalidate(snapshot);
          return { ok: true };
        }
        default: throw new Error("任务记忆指令无效。");
      }
    }
  };
}
