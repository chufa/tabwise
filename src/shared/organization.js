export function duplicateConsolidation(tabs, blocked = {}) {
  const groups = new Map();
  for (const tab of tabs.filter((tab) => !tab.incognito && /^https?:\/\//.test(tab.url || "") && !tab.pendingUrl)) {
    const key = `${tab.windowId}:${tab.url}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tab);
  }
  return [...groups.values()].flatMap((pages) => {
    const sorted = [...pages].sort((a, b) => Number(Boolean(b.active || b.pinned || b.audible)) - Number(Boolean(a.active || a.pinned || a.audible)) || a.index - b.index || a.id - b.id);
    const keep = sorted[0];
    return sorted.slice(1).filter((tab) => !blocked[tab.id]).map((tab) => ({ tabId: tab.id, keepTabId: keep.id,
      title: tab.title || tab.url, url: tab.url, windowId: tab.windowId, index: tab.index, groupId: tab.groupId }));
  });
}
export function linkOutcome(status, url = "") {
  if ([404, 410].includes(status)) return { status: "dead", label: `失效（HTTP ${status}）` };
  if ([401, 403].includes(status) || /(?:\/|[?&])(?:login|signin|auth)(?:[/?=&]|$)/i.test(url)) return { status: "login", label: "需要登录或权限" };
  if (status >= 200 && status < 400) return { status: "reachable", label: `可访问（HTTP ${status}）` };
  if ([405, 501].includes(status)) return { status: "unknown", label: "站点不支持 HEAD 检测" };
  return { status: "unknown", label: `服务异常（HTTP ${status}），尚不能判定失效` };
}
export async function checkLink(url, fetcher = fetch, timeout = 5000) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("仅支持不含凭据的网页链接。");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetcher(parsed.href, { method: "HEAD", credentials: "omit", cache: "no-store",
      referrerPolicy: "no-referrer", redirect: "follow", signal: controller.signal });
    return { ...linkOutcome(response.status, response.url), httpStatus: response.status };
  } catch { return { status: "unknown", label: "网络不可达或超时，尚不能判定失效" }; }
  finally { clearTimeout(timer); }
}
