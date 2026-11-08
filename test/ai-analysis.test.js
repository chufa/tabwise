import test from "node:test";
import assert from "node:assert/strict";
import { buildAiThemePrompt, publicAiSnapshot, selectAiPages, validateAiPlan, validateAiMembers } from "../src/shared/ai-analysis.js";
import { buildOllamaRequest } from "../src/shared/ollama.js";

const tabs = [
  { id: 11, windowId: 1, title: "React 性能", url: "https://react.dev/secret?token=x", status: "live" },
  { id: 12, windowId: 1, title: "Chrome 分析", url: "https://web.dev/performance", status: "live" },
  { id: 13, windowId: 2, title: "Other window", url: "https://example.com", status: "live" },
  { id: 14, windowId: 1, title: "Private", url: "https://private.test", incognito: true },
  { id: 15, windowId: 1, title: "Settings", url: "chrome://settings" }
];
const workspaces = [{ id: "saved", name: "Research", tabs: [{ title: "Saved", url: "https://saved.test/path" }] }];
const snapshot = {
  id: "snapshot-1", createdAt: 1_000, expiresAt: 601_000, scope: "current",
  pages: tabs.slice(0, 2).map((tab, index) => ({ ...tab, tabId: tab.id, pageId: index + 1, domain: new URL(tab.url).hostname }))
};
const plan = {
  schemaVersion: 1, snapshotId: snapshot.id,
  groups: [{ name: "性能研究", pageIds: [1, 2], reason: "两页标题分别提到 React 性能与 Chrome 分析" }]
};

test("analysis scopes include only chosen webpages and exclude private/browser pages", () => {
  assert.deepEqual(selectAiPages({ tabs, workspaces, scope: "current", windowId: 1 }).map((page) => page.tabId), [11, 12]);
  assert.deepEqual(selectAiPages({ tabs, workspaces, scope: "selected", tabIds: [13] }).map((page) => page.tabId), [13]);
  const saved = selectAiPages({ tabs, workspaces, scope: "workspace", workspaceId: "saved" });
  assert.equal(saved[0].url, "https://saved.test/path");
  assert.equal(saved[0].tabId, undefined);
  assert.throws(() => selectAiPages({ tabs, workspaces, scope: "workspace", workspaceId: "missing" }));
  assert.throws(() => selectAiPages({ tabs, workspaces, scope: "selected", tabIds: [14] }));
  assert.throws(() => selectAiPages({ tabs: Array.from({ length: 21 }, (_, id) => ({ ...tabs[0], id })), scope: "current", windowId: 1 }));
});

test("theme prompts expose only previewed metadata and demand JSON grounded in page IDs", () => {
  const prompt = buildAiThemePrompt(snapshot, "按主题整理");
  assert.match(prompt, /snapshot-1/);
  assert.match(prompt, /React 性能/);
  assert.match(prompt, /pageIds/);
  assert.doesNotMatch(prompt, /secret|token=x|https:\/\//);
  assert.match(prompt, /不可信数据/);
  const boundedPages = selectAiPages({
    tabs: Array.from({ length: 20 }, (_, id) => ({ ...tabs[0], id, title: "\u0001".repeat(160), url: `https://${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.test/path` })),
    scope: "current", windowId: 1
  });
  const largePrompt = buildAiThemePrompt({ ...snapshot, pages: boundedPages });
  assert.ok(largePrompt.length > 20_000);
  assert.equal(buildOllamaRequest(largePrompt, "fixture", { type: "object" }).prompt, largePrompt, "structured metadata must never be silently truncated");
});

test("validated plans accept the exact schema and retain verifiable membership", () => {
  assert.deepEqual(validateAiPlan(JSON.stringify(plan), snapshot, 2_000), plan);
  assert.deepEqual(validateAiPlan({ ...plan, groups: [] }, snapshot, 2_000).groups, []);
});

test("plans reject unknown members, duplicate IDs, unexpected actions and stale snapshots", () => {
  for (const invalid of [
    { ...plan, snapshotId: "foreign" },
    { ...plan, action: "close" },
    { ...plan, groups: [{ ...plan.groups[0], pageIds: [1, 999] }] },
    { ...plan, groups: [{ ...plan.groups[0], pageIds: [1, 1] }] },
    { ...plan, groups: [{ ...plan.groups[0], name: "" }] },
    { ...plan, groups: [{ ...plan.groups[0], reason: "" }] },
    { ...plan, groups: [{ ...plan.groups[0], url: "https://attack.test" }] },
    { ...plan, groups: [plan.groups[0], plan.groups[0]] }
  ]) assert.throws(() => validateAiPlan(invalid, snapshot, 2_000));
  assert.throws(() => validateAiPlan("not JSON", snapshot, 2_000));
  assert.throws(() => validateAiPlan(plan, snapshot, 700_000));
});

test("applications reject changed or closed members and group across one safe window only", () => {
  assert.equal(validateAiMembers(snapshot, [1, 2], tabs, workspaces, "group", 2_000).length, 2);
  for (const changed of [
    tabs.filter((tab) => tab.id !== 12),
    tabs.map((tab) => tab.id === 12 ? { ...tab, url: "https://changed.test" } : tab),
    tabs.map((tab) => tab.id === 12 ? { ...tab, windowId: 2 } : tab),
    tabs.map((tab) => tab.id === 12 ? { ...tab, active: true } : tab),
    tabs.map((tab) => tab.id === 12 ? { ...tab, pinned: true } : tab)
  ]) assert.throws(() => validateAiMembers(snapshot, [1, 2], changed, workspaces, "group", 2_000));
  assert.throws(() => validateAiMembers({ ...snapshot, invalidatedTabIds: [12] }, [1, 2], tabs, workspaces, "save", 2_000));
  assert.throws(() => validateAiMembers(snapshot, [1, 2], tabs, workspaces, "group", 700_000));
  assert.throws(() => validateAiMembers(snapshot, [1], tabs, workspaces, "close", 2_000));
});

test("saved workspace themes preserve source identity without opening pages", () => {
  const savedSnapshot = { ...snapshot, scope: "workspace", pages: selectAiPages({ workspaces, scope: "workspace", workspaceId: "saved" }) };
  assert.equal(validateAiMembers(savedSnapshot, [1], [], workspaces, "save", 2_000).length, 1);
  assert.throws(() => validateAiMembers(savedSnapshot, [1], [], [], "save", 2_000));
  assert.throws(() => validateAiMembers(savedSnapshot, [1], [], [{ ...workspaces[0], tabs: [{ title: "Changed", url: "https://saved.test/path" }] }], "save", 2_000));
  assert.throws(() => validateAiMembers(savedSnapshot, [1], tabs, workspaces, "group", 2_000));
  const preview = publicAiSnapshot(savedSnapshot);
  assert.equal(preview.pages[0].status, "saved");
  assert.doesNotMatch(JSON.stringify(preview), /https|workspaceIndex|tabId/);
});

test("scope and schema boundaries reject oversized or ambiguous inputs", () => {
  assert.throws(() => selectAiPages({ tabs, scope: "all" }));
  assert.throws(() => selectAiPages({ tabs, scope: "current" }));
  assert.throws(() => selectAiPages({ tabs: [], scope: "current", windowId: 1 }));
  assert.throws(() => selectAiPages({ tabs, scope: "selected", tabIds: [11, 11] }));
  for (const invalid of [
    { ...plan, groups: Array.from({ length: 4 }, () => plan.groups[0]) },
    { ...plan, groups: [{ ...plan.groups[0], name: "x".repeat(81) }] },
    { ...plan, groups: [{ ...plan.groups[0], reason: "x".repeat(401) }] },
    { ...plan, groups: [{ ...plan.groups[0], pageIds: [] }] },
    { ...plan, groups: [{ ...plan.groups[0], pageIds: ["1"] }] }
  ]) assert.throws(() => validateAiPlan(invalid, snapshot, 2_000));
  assert.throws(() => validateAiPlan("x".repeat(8_001), snapshot, 2_000));
  assert.throws(() => validateAiMembers(snapshot, [], tabs, workspaces, "save", 2_000));
  assert.throws(() => validateAiMembers(snapshot, [999], tabs, workspaces, "save", 2_000));
  assert.throws(() => validateAiMembers(snapshot, [1], tabs, workspaces, "group", 2_000));
  assert.equal(validateAiMembers(snapshot, [1], tabs.map((tab) => ({ ...tab, active: true, pinned: true })), workspaces, "save", 2_000).length, 1);
});

test("untitled pages retain their browser identity when the preview supplies a label", () => {
  const untitledTabs = [{ ...tabs[0], title: "", browserTitle: "" }];
  const untitledSnapshot = { ...snapshot, pages: selectAiPages({ tabs: untitledTabs, scope: "current", windowId: 1 }) };
  assert.equal(untitledSnapshot.pages[0].title, "未命名页面");
  assert.equal(validateAiMembers(untitledSnapshot, [1], untitledTabs, [], "save", 2_000).length, 1);
});
test("theme titles and goals redact embedded URLs and credentials while retaining local browser identity", () => {
  const sensitiveTabs = [{ ...tabs[0], title: "Research https://private.test/path?token=secret user@private.test api_key=sk-private" }];
  const input = { ...snapshot, request: "整理 https://private.test/path?token=secret", pages: selectAiPages({ tabs: sensitiveTabs, scope: "current", windowId: 1 }) };
  const preview = publicAiSnapshot(input), prompt = buildAiThemePrompt(input, input.request);
  for (const secret of ["private.test", "sk-private", "https://"]) {
    assert.ok(!JSON.stringify(preview).includes(secret), secret);
    assert.ok(!prompt.includes(secret), secret);
  }
  assert.equal(input.pages[0].sourceTitle, sensitiveTabs[0].title);
  assert.equal(validateAiMembers(input, [1], sensitiveTabs, [], "save", 2000).length, 1);
});
