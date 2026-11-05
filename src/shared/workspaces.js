export function editWorkspace(workspace, name, indices) {
  const trimmed = String(name || "").trim();
  if (!trimmed || trimmed.length > 80) throw new Error("工作区名称需为 1–80 个字符。");
  if (!Array.isArray(indices) || !indices.length) throw new Error("请至少保留一个页面。");
  if (indices.some((index) => !Number.isInteger(index) || !workspace.tabs[index])) throw new Error("工作区成员已变化，请重新编辑。");
  return { name: trimmed, tabs: [...new Set(indices)].map((index) => workspace.tabs[index]) };
}

export function mergeWorkspaces(workspaces, name) {
  if (workspaces.length < 2 || workspaces.some((item) => item.deletedAt)) throw new Error("请选择至少两个有效工作区。");
  const tabs = [...new Map(workspaces.flatMap((item) => item.tabs).map((tab) => [tab.url, tab])).values()];
  return { ...editWorkspace({ tabs }, name, tabs.map((_, index) => index)), id: crypto.randomUUID(), createdAt: Date.now(), archived: false };
}
