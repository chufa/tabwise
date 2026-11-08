import { getWorkspaces, getRecoveryCheckpoints, getRecords, putRecord, queueStorage, updateWorkspace } from "../shared/storage.js";
import { normalizeRestorePreset } from "../shared/workspace-presets.js";
import { sourceState, selectedRestorePages, restoreLoadOptions } from "../shared/restoration.js";
import { mapConcurrent } from "../shared/scanning.js";
import { appendRestoreAudit, resumeRestoreIndices } from "../shared/restore-audit.js";
import { isTaskActive } from "../shared/task-state.js";
import { archiveTaskRecord, retainTasks } from "../shared/task-ledger.js";
import { createTaskLedger } from "./task-ledger.js";
import { getContextTasks } from "../shared/context-storage.js";
import { contextRestoreSource } from "../shared/task-context.js";

const KEY = "restorePreviews";

export async function logicalTabs() {
  const [tabs, records] = await Promise.all([chrome.tabs.query({}), getRecords()]);
  const byTab = new Map(Object.values(records).map((record) => [record.tabId, record]));
  return tabs.map((tab) => {
    const candidate = byTab.get(tab.id);
    const record = candidate && (tab.url === chrome.runtime.getURL("src/suspended/suspended.html") + `#${candidate.recordId}` || tab.url === candidate.originalUrl && tab.discarded) ? candidate : null;
    return { ...tab, title: record?.title || tab.title, logicalUrl: record?.originalUrl || tab.pendingUrl || tab.url, recordId: record?.recordId };
  });
}

async function savedSource(kind, id) {
  if (!["workspace", "checkpoint", "context"].includes(kind)) throw new Error("恢复来源无效。");
  const sources = await (kind === "context" ? getContextTasks() : kind === "workspace" ? getWorkspaces() : getRecoveryCheckpoints());
  const source = sources.find((item) => item.id === id);
  if (!source) throw new Error("保存的内容不存在，请刷新列表。");
  return kind === "context" ? contextRestoreSource(source) : source;
}

async function waitForLoad(tabId) {
  return new Promise((resolve) => {
    let timer;
    const done = (status) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      resolve(status);
    };
    const updated = (id, changes) => { if (id === tabId && changes.status === "complete") done("opened"); };
    const removed = (id) => { if (id === tabId) done("closed"); };
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    timer = setTimeout(() => done("loading"), 8_000);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === "complete") done("opened"); }).catch(() => done("closed"));
  });
}

export function createRestorer(markWorkspace) {
  let queue = Promise.resolve();
  const ledger = createTaskLedger("restore");
  const ready = ledger.ready.then(() => queueStorage("session", async () => {
    const source = await ledger.read();
    const normalized = source.map((task) => isTaskActive(task.status) ? {
      ...task, status: "interrupted", updatedAt: Date.now(),
      audit: appendRestoreAudit(task.audit, "interrupted", { reason: "worker restart" }),
      results: task.results.map((item) => item.status === "opening" ? { ...item, status: "uncertain", reason: "恢复中断，页面是否已打开需要重新检查。" } : item)
    } : task);
    await ledger.write(normalized);
  }));
  ready.catch(console.error);
  async function readTasks() { await ready; return (await chrome.storage.session.get("restoreTasks")).restoreTasks || []; }
  function mutate(id, work) {
    return queueStorage("session", async () => {
      const { restoreTasks = [] } = await chrome.storage.session.get("restoreTasks");
      const task = restoreTasks.find((item) => item.id === id);
      if (!task) throw new Error("恢复任务不存在。");
      work(task);
      task.updatedAt = Date.now();
      await ledger.write(restoreTasks);
      return task;
    });
  }
  const summary = ({ signature, indices, results, ...task }) => ({
    ...task,
    count: results.filter((item) => ["opened", "loading"].includes(item.status)).length,
    skipped: results.filter((item) => item.status === "skipped").length,
    failed: results.filter((item) => ["failed", "closed", "uncertain"].includes(item.status)).length,
    settled: results.filter((item) => !["pending", "opening"].includes(item.status)).length,
    retryable: !task.resolvedBy && !task.archivedAt && !isTaskActive(task.status) && results.some((item) => ["failed", "closed", "uncertain", "pending"].includes(item.status)),
    resumable: !task.resolvedBy && !task.archivedAt && !isTaskActive(task.status) && resumeRestoreIndices(results).length > 0
  });
  async function detail(id, offset = 0) {
    const task = (await readTasks()).find((item) => item.id === id);
    if (!task) throw new Error("恢复任务不存在。");
    offset = Math.max(0, Math.floor(Number(offset) || 0));
    return { ok: true, ...summary(task), offset, itemTotal: task.results.length, results: task.results.slice(offset, offset + 50) };
  }
  const progress = (id, result) => mutate(id, (task) => {
    const index = task.results.findIndex((item) => item.index === result.index);
    task.results[index] = { ...task.results[index], ...result };
  });
  async function restore(kind, source, indices, skipExisting, windowId, restoreLayout = false, taskId, options = {}) {
    const { loadMode, concurrency } = restoreLoadOptions(options);
    restoreLayout = restoreLayout && source.schemaVersion === 2;
    const existing = new Set((await logicalTabs()).map((tab) => tab.logicalUrl));
    const pages = selectedRestorePages(source.tabs, indices, existing, skipExisting);
    const results = [];
    const windows = new Map();
    async function destination(page) {
      if (!restoreLayout) return { windowId };
      const key = page.windowKey ?? 0;
      if (!windows.has(key)) windows.set(key, chrome.windows.create({ url: "about:blank", focused: false }).then((window) => ({ windowId: window.id, anchor: window.tabs[0], claimed: false })));
      const window = await windows.get(key);
      if (!window.claimed) { window.claimed = true; return { windowId: window.windowId, anchor: window.anchor }; }
      return { windowId: window.windowId };
    }
    // Each batch settles before the next one starts; API failures are per page.
    for (let offset = 0; offset < pages.length; offset += concurrency) {
      if (taskId && (await readTasks()).find((task) => task.id === taskId)?.status === "stopping") break;
      const batch = pages.slice(offset, offset + concurrency);
      const current = await savedSource(kind, source.id).catch(() => null);
      if (!current || sourceState(current) !== sourceState(source)) {
        const failed = pages.slice(offset).map((page) => ({ index: page.index, title: page.title, status: "failed", reason: "保存内容在恢复期间发生变化，请重新预览。" }));
        results.push(...failed);
        if (taskId) for (const result of failed) await progress(taskId, result);
        break;
      }
      const restorePage = async (page) => {
        if (page.action === "skip") return { index: page.index, title: page.title, status: "skipped", reason: "已打开或与所选页面重复" };
        try {
          if (!/^https?:\/\//.test(page.url)) throw new Error("不支持恢复此地址。");
          // Recheck live pages immediately before creating.
          if (skipExisting && (await logicalTabs()).some((tab) => tab.logicalUrl === page.url)) return { index: page.index, status: "skipped", reason: "页面已打开" };
          // Durable intent precedes window/tab creation. Restart never replays it.
          if (taskId) await progress(taskId, { index: page.index, status: "opening" });
          const target = await destination(page);
          const sleeping = loadMode === "on-demand" || restoreLayout && page.status === "suspended";
          const tab = target.anchor || await chrome.tabs.create({ url: sleeping ? "about:blank" : page.url, active: false, ...(target.windowId ? { windowId: target.windowId } : {}) });
          if (taskId) await progress(taskId, { index: page.index, status: "opening", tabId: tab.id });
          let recordId;
          if (sleeping) {
            recordId = crypto.randomUUID();
            await putRecord({ recordId, tabId: tab.id, windowId: target.windowId, title: page.title || page.url, originalUrl: page.url, mode: "placeholder", state: "suspended", suspendedAt: Date.now(), reason: "snapshot" }, true);
            await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL("src/suspended/suspended.html") + `#${recordId}` });
          } else if (target.anchor) await chrome.tabs.update(tab.id, { url: page.url });
          return { index: page.index, title: page.title, tabId: tab.id, recordId, windowId: target.windowId, onDemand: sleeping, status: await waitForLoad(tab.id) };
        } catch (error) { return { index: page.index, title: page.title, status: "failed", reason: error.message }; }
      };
      const batchResults = await mapConcurrent(batch, concurrency, async (page) => {
        const result = await restorePage(page);
        if (taskId) await progress(taskId, result);
        return result;
      });
      results.push(...batchResults);
    }
    const layoutErrors = [];
    if (restoreLayout) {
      const created = results.filter((item) => ["opened", "loading"].includes(item.status));
      // Only newly created tabs are changed. Existing matches retain their layout.
      for (const item of created) {
        const page = source.tabs[item.index];
        const tab = await chrome.tabs.get(item.tabId).catch(() => null);
        const expected = item.recordId ? chrome.runtime.getURL("src/suspended/suspended.html") + `#${item.recordId}` : page.url;
        if (!tab || ![tab.url, tab.pendingUrl].includes(expected)) { item.layoutSkipped = true; continue; }
        try { if (page.pinned) await chrome.tabs.update(tab.id, { pinned: true }); }
        catch (error) { layoutErrors.push(error.message); }
      }
      for (const group of source.groups || []) {
        const members = created.filter((item) => !item.layoutSkipped && !source.tabs[item.index].pinned && source.tabs[item.index].groupKey === group.key);
        if (!members.length) continue;
        try {
          const id = await chrome.tabs.group({ tabIds: members.map((item) => item.tabId), createProperties: { windowId: members[0].windowId } });
          await chrome.tabGroups.update(id, { title: group.title, color: group.color, collapsed: group.collapsed });
        } catch (error) { layoutErrors.push(error.message); }
      }
      for (const item of created.filter((item) => !item.layoutSkipped)) {
        try { await chrome.tabs.move(item.tabId, { index: source.tabs[item.index].index ?? item.index }); }
        catch (error) { layoutErrors.push(error.message); }
      }
      for (const [key] of windows) {
        const active = created.find((item) => !item.layoutSkipped && source.tabs[item.index].windowKey === key && source.tabs[item.index].active);
        if (active) await chrome.tabs.update(active.tabId, { active: true }).catch((error) => layoutErrors.push(error.message));
      }
    }
    if (kind === "workspace" && results.some((item) => ["opened", "loading", "skipped"].includes(item.status))) await markWorkspace(source.id);
    return { ok: true, count: results.filter((item) => ["opened", "loading"].includes(item.status)).length,
      skipped: results.filter((item) => item.status === "skipped").length, failed: results.filter((item) => ["failed", "closed"].includes(item.status)).length, results, layoutErrors };
  }
  const run = (work) => {
    const next = queue.catch(() => {}).then(work);
    queue = next;
    return next;
  };
  async function enqueue(source, options) {
    await ready;
    const task = { ...options, id: crypto.randomUUID(), sourceId: source.id, name: source.name || "恢复点",
      signature: sourceState(source), status: "queued", createdAt: Date.now(), updatedAt: Date.now(),
      total: options.indices.length, results: options.indices.map((index) => ({ index, title: source.tabs[index].title, status: "pending" })) };
    await queueStorage("session", async () => {
      const tasks = await readTasks();
      const parentId = options.retryOf || options.resumeOf;
      const parent = parentId && tasks.find((item) => item.id === parentId);
      if (parentId && (!parent || !(options.retryOf ? summary(parent).retryable : summary(parent).resumable))) throw new Error("此任务已继续或重试，请查看后续任务。");
      if (tasks.filter((item) => isTaskActive(item.status)).length >= 5) throw new Error("请先完成或停止当前恢复任务。");
      if (parent) parent.resolvedBy = task.id;
      await ledger.write(retainTasks([task, ...tasks]));
    });
    run(async () => {
      try {
        await mutate(task.id, (item) => { if (item.status === "queued") { item.status = "running"; item.audit = appendRestoreAudit(item.audit, "started", { total: item.total }); } });
        const result = await restore(task.kind, source, task.indices, task.skipExisting, task.windowId, task.restoreLayout, task.id, task);
        await mutate(task.id, (item) => { item.status = item.status === "stopping" ? "stopped" : "completed"; item.layoutErrors = result.layoutErrors; item.audit = appendRestoreAudit(item.audit, item.status, { count: result.count, skipped: result.skipped, failed: result.failed }); });
      } catch (error) {
        await mutate(task.id, (item) => {
          item.status = "interrupted"; item.reason = error.message; item.audit = appendRestoreAudit(item.audit, "interrupted", { reason: error.message });
          item.results = item.results.map((page) => page.status === "opening" ? { ...page, status: "uncertain" } : page);
        });
      }
    }).catch(console.error);
    return { ok: true, taskId: task.id };
  }
  return {
    ready,
    detail,
    async list() { return (await readTasks()).map(summary); },
    async stop(id) {
      await ready;
      await mutate(id, (task) => { if (isTaskActive(task.status)) task.status = "stopping"; });
      return { ok: true };
    },
    async archive(id) {
      await ready;
      await mutate(id, archiveTaskRecord);
      return { ok: true };
    },
    async retry(id) {
      const task = (await readTasks()).find((item) => item.id === id);
      if (!task || task.resolvedBy || task.archivedAt || isTaskActive(task.status)) throw new Error("请查看后续任务，或重新预览已归档任务。");
      const source = await savedSource(task.kind, task.sourceId);
      if (sourceState(source) !== task.signature) throw new Error("保存内容已变化，请重新预览。");
      const indices = task.results.filter((page) => ["failed", "closed", "uncertain", "pending"].includes(page.status)).map((page) => page.index);
      if (!indices.length) throw new Error("没有需要重试的页面。");
      return enqueue(source, { kind: task.kind, indices, skipExisting: true, windowId: task.windowId, restoreLayout: task.restoreLayout, retryOf: id, ...restoreLoadOptions(task) });
    },
    async resume(id) {
      const task = (await readTasks()).find((item) => item.id === id);
      if (!task || task.resolvedBy || task.archivedAt || isTaskActive(task.status)) throw new Error("请查看后续任务，或重新预览已归档任务。");
      const source = await savedSource(task.kind, task.sourceId);
      if (sourceState(source) !== task.signature) throw new Error("保存内容已变化，请重新预览。");
      const indices = resumeRestoreIndices(task.results);
      if (!indices.length) throw new Error("没有可以安全继续的页面。");
      return enqueue(source, { kind: task.kind, indices, skipExisting: true, windowId: task.windowId, restoreLayout: task.restoreLayout, resumeOf: id, ...restoreLoadOptions(task) });
    },
    start(message, sender) {
      return queueStorage("session", async () => {
        const { restorePreviews = [] } = await chrome.storage.session.get(KEY);
        const preview = restorePreviews.find((item) => item.id === message.previewId && item.owner === sender.documentId && item.expiresAt > Date.now());
        if (!preview) throw new Error("恢复预览已过期或已执行，请重新预览。");
        const source = await savedSource(preview.kind, preview.sourceId);
        if (sourceState(source) !== preview.signature) throw new Error("保存内容已变化，请重新预览。");
        selectedRestorePages(source.tabs, message.indices, new Set(), true);
        await chrome.storage.session.set({ [KEY]: restorePreviews.filter((item) => item.id !== preview.id) });
        return { source, options: { kind: preview.kind, indices: [...new Set(message.indices)], windowId: preview.windowId, skipExisting: message.skipExisting !== false, restoreLayout: message.restoreLayout === true, ...restoreLoadOptions(message) } };
      }).then(async ({ source, options }) => {
        if (options.kind === "workspace" && message.rememberPreset === true) await updateWorkspace(source.id,
          { restorePreset: normalizeRestorePreset({ ...options, tag: message.tag }) });
        return enqueue(source, options);
      });
    },
    prepare(kind, id, sender, signature) {
      return queueStorage("session", async () => {
      if (!sender.documentId) throw new Error("请从 TabWise 界面预览恢复。");
      const source = await savedSource(kind, id);
      if (signature && sourceState(source) !== signature) throw new Error("用于对比的恢复点已变化，请重新对比。");
      const urls = new Set((await logicalTabs()).map((tab) => tab.logicalUrl));
      const windowId = sender.tab?.windowId ?? (await chrome.windows.getLastFocused()).id;
      const preview = { id: crypto.randomUUID(), kind, sourceId: id, signature: sourceState(source), owner: sender.documentId, windowId, expiresAt: Date.now() + 5 * 60_000 };
      const stored = await chrome.storage.session.get(KEY);
      await chrome.storage.session.set({ [KEY]: [preview, ...(stored[KEY] || []).filter((item) => item.owner !== sender.documentId && item.expiresAt > Date.now())].slice(0, 10) });
      return { ok: true, previewId: preview.id, name: source.name || "恢复点", kind,
        preset: normalizeRestorePreset(source.restorePreset, source.schemaVersion === 2),
        hasLayout: source.schemaVersion === 2, windowCount: source.windowCount || 1, pages: source.tabs.map((page, index) => ({ ...page, index, existing: urls.has(page.url) })) };
      });
    },
    confirm(message, sender) {
      return run(async () => {
        const { preview, source } = await queueStorage("session", async () => {
        const stored = await chrome.storage.session.get(KEY);
        const previews = stored[KEY] || [];
        const preview = previews.find((item) => item.id === message.previewId && item.owner === sender.documentId && item.expiresAt > Date.now());
        if (!preview) throw new Error("恢复预览已过期或已执行，请重新预览。");
        const source = await savedSource(preview.kind, preview.sourceId);
        if (sourceState(source) !== preview.signature) throw new Error("工作区或恢复点内容已变化，请重新预览。");
        selectedRestorePages(source.tabs, message.indices, new Set(), message.skipExisting !== false);
        // Consume first: a worker restart must never replay a partially applied restore.
        await chrome.storage.session.set({ [KEY]: previews.filter((item) => item.id !== preview.id) });
        return { preview, source };
        });
        return restore(preview.kind, source, message.indices, message.skipExisting !== false, preview.windowId, message.restoreLayout === true, undefined, message);
      });
    },
    all(kind, id) {
      return run(async () => {
        const source = await savedSource(kind, id);
        return restore(kind, source, source.tabs.map((_, index) => index), true);
      });
    }
  };
}
