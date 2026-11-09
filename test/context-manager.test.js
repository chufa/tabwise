import test from "node:test";
import assert from "node:assert/strict";
import { createContextManager } from "../src/background/context-manager.js";

const sender = { id: "extension", url: "chrome-extension://extension/src/sidepanel/sidepanel.html", documentId: "owner" };
function fixture() {
  const local = {};
  let failure = false, reads = 0, access;
  globalThis.chrome = { runtime: { id: "extension", getURL: (path) => `chrome-extension://extension/${path}` },
    storage: { local: {
      setAccessLevel: async ({ accessLevel }) => { access = accessLevel; },
      get: async (key) => { assert.equal(access, "TRUSTED_CONTEXTS"); reads++; return structuredClone(key ? { [key]: local[key] } : local); },
      set: async (patch) => { if (failure) throw new Error("quota exceeded"); Object.assign(local, structuredClone(patch)); }
    } } };
  let tabs = [{ id: 7, windowId: 2, title: "资料", url: "https://docs.test/path?token=private", logicalUrl: "https://docs.test/path?token=private" }];
  let resolveModel;
  let calls = 0;
  const settings = { aiProvider: "ollama", ollamaEndpoint: "http://127.0.0.1:11434", ollamaModel: "fixture" };
  let searchSource = { title: "搜索资料", url: "https://search.test/article" };
  const deps = { getTabs: async () => tabs, getWindowId: async () => 2, getWorkspaces: async () => [],
    getSettings: async () => settings, fetchOllama: async () => { calls++; return new Promise((resolve) => { resolveModel = resolve; }); },
    resolveSearchSource: async () => searchSource };
  const manager = createContextManager(deps);
  return { manager, local, deps, settings, setTabs: (value) => { tabs = value; }, fail: () => { failure = true; },
    get reads() { return reads; }, get calls() { return calls; }, setSearchSource: (value) => { searchSource = value; },
    reply: (brief) => resolveModel({ response: JSON.stringify(brief) }) };
}
const call = (manager, type, payload = {}, owner = sender) => manager.handle({ type, ...payload }, owner);
const fields = { name: "调研", goal: "核对恢复限制" };
const answer = (snapshot) => ({ schemaVersion: 1, snapshotId: snapshot.id, summary: "继续调研", hypotheses: [], questions: [],
  nextSteps: [{ text: "核对资料", sourceIds: snapshot.input.sources.map((s) => s.sourceId) }] });

test("context commands reject other surfaces before reading private memory; CRUD is durable and optimistic", async () => {
  const f = fixture();
  await assert.rejects(call(f.manager, "listContextTasks", {}, { ...sender, url: "https://site.test/" }), /侧栏/);
  await assert.rejects(call(f.manager, "listContextTasks", {}, { ...sender, url: `${sender.url}?task=1#tasks` }), /侧栏/);
  await assert.rejects(call(f.manager, "listContextTasks", {}, { ...sender, id: "other-extension", url: `${sender.url}#tasks` }), /侧栏/);
  assert.equal(f.reads, 0);
  const { task } = await call(f.manager, "createContextTask", { fields }, { ...sender, url: `${sender.url}#tasks` });
  await call(f.manager, "updateContextTask", { taskId: task.id, revision: 1, patch: { progress: "第一步已完成" } });
  await assert.rejects(call(f.manager, "updateContextTask", { taskId: task.id, revision: 1, patch: { progress: "覆盖" } }), /变化/);
  const restarted = createContextManager(f.deps);
  assert.equal((await call(restarted, "listContextTasks")).tasks[0].progress, "第一步已完成");
  f.fail();
  await assert.rejects(call(restarted, "deleteContextTask", { taskId: task.id, revision: 2, confirm: true }), /quota/);
  assert.equal(f.local.contextTasks.length, 1);
});
test("source attachment requires explicit selection and rereads live identity, with no fetch at preview", async () => {
  const f = fixture();
  const { task } = await call(f.manager, "createContextTask", { fields });
  const preview = await call(f.manager, "prepareContextSources", { kind: "current" });
  assert.equal(f.calls, 0);
  f.setTabs([{ id: 7, windowId: 2, url: "https://changed.test/", logicalUrl: "https://changed.test/" }]);
  await assert.rejects(call(f.manager, "attachContextSources", { taskId: task.id, revision: 1, previewId: preview.id, sourceIds: [preview.sources[0].id], confirm: true }), /变化/);
  f.setTabs([{ id: 8, windowId: 2, title: "fresh", logicalUrl: "https://docs.test/fresh" }]);
  const fresh = await call(f.manager, "prepareContextSources", { kind: "current" });
  await assert.rejects(call(f.manager, "attachContextSources", { taskId: task.id, revision: 1, previewId: fresh.id, sourceIds: [fresh.sources[0].id] }), /确认/);
  const result = await call(f.manager, "attachContextSources", { taskId: task.id, revision: 1, previewId: fresh.id, sourceIds: [fresh.sources[0].id], confirm: true });
  assert.equal(result.task.sources[0].tabId, undefined);
  assert.equal(result.task.sources.length, 1);
  const exported = await call(f.manager, "exportContextTask", { taskId: task.id });
  assert.ok(exported.markdown.includes("https://docs.test/fresh"));
  assert.equal(JSON.parse(exported.json).task.id, task.id);
});
test("AI snapshots are owned and restart/cancellation rejects late output; edits reject old adoption", async () => {
  const f = fixture();
  const { task } = await call(f.manager, "createContextTask", { fields });
  const prepared = await call(f.manager, "prepareContextBrief", { taskId: task.id, sourceIds: [] });
  assert.equal(f.calls, 0);
  await assert.rejects(call(f.manager, "generateContextBrief", { snapshotId: prepared.snapshot.id }, { ...sender, documentId: "other" }), /预览/);
  await assert.rejects(call(createContextManager(f.deps), "generateContextBrief", { snapshotId: prepared.snapshot.id }), /预览/);
  const running = call(f.manager, "generateContextBrief", { snapshotId: prepared.snapshot.id });
  while (!f.calls) await Promise.resolve();
  await call(f.manager, "cancelContextBrief", { snapshotId: prepared.snapshot.id });
  f.reply(answer(prepared.snapshot));
  await assert.rejects(running, /停止|预览/);
  const fresh = await call(f.manager, "prepareContextBrief", { taskId: task.id, sourceIds: [] });
  f.settings.aiProvider = "browser";
  await assert.rejects(call(f.manager, "generateContextBrief", { snapshotId: fresh.snapshot.id }), /设置/);
  const browser = await call(f.manager, "prepareContextBrief", { taskId: task.id, sourceIds: [] });
  await assert.rejects(call(f.manager, "acceptContextBrief", { snapshotId: browser.snapshot.id, answer: answer(browser.snapshot) }), /生成/);
  await call(f.manager, "beginContextBrief", { snapshotId: browser.snapshot.id });
  await call(f.manager, "acceptContextBrief", { snapshotId: browser.snapshot.id, answer: answer(browser.snapshot) });
  await call(f.manager, "updateContextTask", { taskId: task.id, revision: 1, patch: { progress: "已改变" } });
  await assert.rejects(call(f.manager, "adoptContextBrief", { snapshotId: browser.snapshot.id, brief: answer(browser.snapshot), confirm: true }), /变化/);
});
test("adoption saves edited suggestions separately, consumes its snapshot, and survives storage reload", async () => {
  const f = fixture();
  const { task } = await call(f.manager, "createContextTask", { fields: { ...fields, confirmedNotes: "用户记录" } });
  await call(f.manager, "resumeContextTask", { taskId: task.id });
  assert.equal(f.local.contextTasks[0].revision, 1);
  assert.ok(f.local.contextTasks[0].lastResumedAt > 0);
  const preview = await call(f.manager, "prepareContextBrief", { taskId: task.id, sourceIds: [] });
  const pending = call(f.manager, "generateContextBrief", { snapshotId: preview.snapshot.id });
  while (!f.calls) await Promise.resolve();
  f.reply(answer(preview.snapshot));
  const result = await pending;
  f.manager.disconnect(preview.snapshot.id, sender); // Completed drafts stay reviewable after the generation port closes.
  await assert.rejects(call(f.manager, "adoptContextBrief", { snapshotId: preview.snapshot.id, brief: result.brief, confirm: false }), /确认/);
  result.brief.summary = "用户审阅后的草稿";
  const adopted = await call(f.manager, "adoptContextBrief", { snapshotId: preview.snapshot.id, brief: result.brief, confirm: true });
  assert.equal(adopted.task.confirmedNotes, "用户记录");
  assert.equal(adopted.task.acceptedBrief.summary, "用户审阅后的草稿");
  await assert.rejects(call(f.manager, "adoptContextBrief", { snapshotId: preview.snapshot.id, brief: result.brief, confirm: true }), /预览/);
  assert.ok((await call(f.manager, "exportContextTask", { taskId: task.id })).markdown.includes("用户审阅后的草稿"));
  await call(f.manager, "deleteContextTask", { taskId: task.id, revision: 2, confirm: true });
  assert.equal(f.local.contextTasks.length, 0);
  await assert.rejects(call(f.manager, "resumeContextTask", { taskId: task.id }), /删除/);
});
test("saved source previews never open pages; private entries are excluded and source limits are atomic", async () => {
  const f = fixture();
  const workspaces = [{ id: "saved", name: "saved", tabs: [{ title: "saved", url: "https://docs.test/saved" }, { title: "internal", url: "chrome://settings" }] }];
  f.deps.getWorkspaces = async () => workspaces;
  const manager = createContextManager(f.deps);
  const { task } = await call(manager, "createContextTask", { fields });
  const preview = await call(manager, "prepareContextSources", { kind: "workspace", workspaceId: "saved" });
  assert.equal(preview.sources.length, 1);
  assert.equal(f.calls, 0);
  await assert.rejects(call(manager, "attachContextSources", { taskId: task.id, revision: 1, previewId: preview.id, sourceIds: [], confirm: true }), /选择/);
  await assert.rejects(call(manager, "attachContextSources", { taskId: task.id, revision: 1, previewId: preview.id, sourceIds: ["foreign"], confirm: true }), /选择/);
  await call(manager, "attachContextSources", { taskId: task.id, revision: 1, previewId: preview.id, sourceIds: [preview.sources[0].id], confirm: true });
  const duplicate = await call(manager, "prepareContextSources", { kind: "workspace", workspaceId: "saved" });
  assert.equal((await call(manager, "attachContextSources", { taskId: task.id, revision: 2, previewId: duplicate.id, sourceIds: [duplicate.sources[0].id], confirm: true })).task.sources.length, 1);
  await assert.rejects(call(manager, "prepareContextSources", { kind: "other" }), /范围/);
  await assert.rejects(call(manager, "prepareContextSources", { kind: "workspace", workspaceId: "missing" }), /工作区/);
  f.setTabs([{ id: 7, windowId: 2, url: "chrome://settings" }, { id: 8, windowId: 2, incognito: true, url: "https://private.test/" }, { id: 9, windowId: 99, url: "https://unrelated.test/" }]);
  assert.equal((await call(manager, "prepareContextSources", { kind: "current" })).sources.length, 0);
  f.settings.ollamaEndpoint = "https://remote.test/";
  await assert.rejects(call(manager, "prepareContextBrief", { taskId: task.id, sourceIds: [] }), /本机/);
  f.local.contextTasks = Array.from({ length: 20 }, (_, index) => ({ ...task, id: `task-${index}` }));
  await assert.rejects(call(manager, "createContextTask", { fields }), /20/);
  assert.equal(f.local.contextTasks.length, 20);
});
test("disconnect cancels running snapshots and browser schema rejection cannot become a saved suggestion", async () => {
  const f = fixture(); f.settings.aiProvider = "browser";
  const { task } = await call(f.manager, "createContextTask", { fields });
  const preview = await call(f.manager, "prepareContextBrief", { taskId: task.id, sourceIds: [] });
  await call(f.manager, "beginContextBrief", { snapshotId: preview.snapshot.id });
  await assert.rejects(call(f.manager, "beginContextBrief", { snapshotId: preview.snapshot.id }), /开始/);
  await assert.rejects(call(f.manager, "acceptContextBrief", { snapshotId: preview.snapshot.id, answer: { ...answer(preview.snapshot), tool: "delete" } }), /格式/);
  await assert.rejects(call(f.manager, "adoptContextBrief", { snapshotId: preview.snapshot.id, brief: answer(preview.snapshot), confirm: true }), /审阅/);
  f.manager.disconnect(preview.snapshot.id, { ...sender, documentId: "other" });
  f.manager.disconnect(preview.snapshot.id, sender);
  await assert.rejects(call(f.manager, "acceptContextBrief", { snapshotId: preview.snapshot.id, answer: answer(preview.snapshot) }), /预览/);
  assert.equal(f.local.contextTasks[0].acceptedBrief, undefined);
});

test("explicit search attachment rereads a safe source and related candidates never include unrelated or private tabs", async () => {
  const f = fixture();
  const { task } = await call(f.manager, "createContextTask", { fields });
  const attached = await call(f.manager, "attachSearchContextSource", { taskId: task.id, revision: 1, result: { id: "current" }, confirm: true });
  assert.equal(attached.task.sources[0].url, "https://search.test/article");
  assert.equal((await call(f.manager, "attachSearchContextSource", { taskId: task.id, revision: 2, result: { id: "again" }, confirm: true })).duplicate, true);
  f.setTabs([
    { id: 1, windowId: 2, title: "同站资料", logicalUrl: "https://search.test/other" },
    { id: 2, windowId: 2, title: "其他页面", logicalUrl: "https://unrelated.test/" },
    { id: 3, windowId: 2, title: "隐私页面", incognito: true, logicalUrl: "https://search.test/private" }
  ]);
  const related = await call(f.manager, "prepareContextSources", { kind: "related", taskId: task.id });
  assert.deepEqual(related.sources.map((source) => source.url), ["https://search.test/other"]);
  f.setSearchSource({ title: "Bad", url: "chrome://settings" });
  await assert.rejects(call(f.manager, "attachSearchContextSource", { taskId: task.id, revision: 2, result: {}, confirm: true }), /网址/);
});
