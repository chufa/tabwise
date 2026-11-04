function measuredHeap(tab) {
  const usage = Number(tab.memory?.usedJSHeapSize);
  return Number.isFinite(usage) && usage > 0 ? usage : 0;
}

function safeText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function buildResourceReclaimPlan(tabs, candidates) {
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
  const seen = new Set();
  const enriched = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.tabId) || !tabById.has(candidate.tabId)) continue;
    seen.add(candidate.tabId);
    enriched.push({ ...candidate, estimatedJSHeap: measuredHeap(tabById.get(candidate.tabId)) });
  }
  return {
    reclaimableJSHeap: enriched.reduce((total, candidate) => total + candidate.estimatedJSHeap, 0),
    reclaimableMeasuredTabs: enriched.filter((candidate) => candidate.estimatedJSHeap > 0).length,
    candidates: enriched
  };
}

export function buildLocalAiPrompt(tabs, request) {
  const pages = tabs
    .filter((tab) => /^https?:/.test(tab.url || "") || tab.domain)
    .slice(0, 20)
    .map((tab) => `- #${tab.id} | 标题：${safeText(tab.title, 160) || "未命名"} | 域名：${safeText(tab.domain, 120) || "未知"} | 状态：${safeText(tab.status, 32) || "未知"}`)
    .join("\n");
  return `你是本地浏览上下文助手。只能依据下面的网页标题、域名和状态提出建议，不能假设或补充页面内容。

用户请求：${safeText(request, 240) || "识别可合并的研究主题，并说明每组依据。"}

网页元数据：
${pages || "没有可分析的网页。"}

请用中文输出：
1. 最多 3 个主题或工作区建议；
2. 每项列出相关页面编号和一句理由；
3. 可安全休眠的候选仅作建议，不能要求关闭、导航或自动执行；
4. 若信息不足，明确说明。

仅提供建议，不执行任何浏览器操作。`;
}
