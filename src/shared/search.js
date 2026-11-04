function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, " ")
    .trim();
}

function queryTerms(query) {
  return normalize(query).split(/\s+/).filter((term) => term.length > 1 || /[\u3400-\u9fff]/.test(term));
}

const ASSOCIATIONS = [
  ["前端", "frontend", "react", "javascript", "typescript", "css"],
  ["性能", "performance", "perf", "profiling", "optimize", "optimization"],
  ["浏览器", "browser", "chrome", "chromium", "extension", "扩展"],
  ["数据库", "database", "sql", "postgres", "mysql", "redis"],
  ["设计", "design", "ux", "ui", "figma"]
];

function queryGroups(query, semantic) {
  const normalized = normalize(query);
  if (!semantic) return queryTerms(normalized).map((term) => [term]);
  let remaining = normalized;
  const groups = [];
  for (const association of ASSOCIATIONS) {
    const matched = association.find((term) => remaining.includes(term));
    if (!matched) continue;
    groups.push(association);
    remaining = remaining.replaceAll(matched, " ");
  }
  return [...groups, ...queryTerms(remaining).map((term) => [term])];
}

function subsequenceScore(term, value) {
  let cursor = 0;
  let gaps = 0;
  for (const character of term) {
    const index = value.indexOf(character, cursor);
    if (index === -1) return 0;
    gaps += index - cursor;
    cursor = index + 1;
  }
  return Math.max(1, term.length * 4 - gaps);
}

function fieldScore(value, terms, weight) {
  const normalized = normalize(value);
  if (!normalized) return 0;
  return terms.reduce((score, term) => {
    if (normalized.includes(term)) return score + weight + term.length;
    return score + subsequenceScore(term, normalized);
  }, 0);
}

export function searchPageMemory(pages, query, limit = 30, options = {}) {
  const groups = queryGroups(query, Boolean(options.semantic));
  if (!groups.length) return [];
  const newestAccess = Math.max(...pages.map((page) => Number(page.lastAccessed || page.createdAt || 0)), 0);

  return pages
    .map((page) => {
      const haystack = normalize(`${page.title} ${page.domain} ${page.url}`);
      const matchedTerms = groups.map((group) => group.find((term) => haystack.includes(term) || subsequenceScore(term, haystack) > 0));
      if (matchedTerms.some((term) => !term)) return null;
      const titleScore = matchedTerms.reduce((total, term) => total + fieldScore(page.title, [term], 40), 0);
      const domainScore = matchedTerms.reduce((total, term) => total + fieldScore(page.domain, [term], 24), 0);
      const urlScore = matchedTerms.reduce((total, term) => total + fieldScore(page.url, [term], 16), 0);

      const age = Math.max(0, newestAccess - Number(page.lastAccessed || page.createdAt || 0));
      const recency = Math.max(0, 12 - age / 86_400_000);
      const sourceBoost = page.source === "open" ? 36 : page.source === "suspended" ? 12 : 2;
      const statusBoost = page.status === "live" ? 4 : page.status === "suspended" ? 3 : 0;
      const score = titleScore + domainScore + urlScore + recency + sourceBoost + statusBoost;
      return {
        ...page,
        score,
        matchKind: titleScore >= 40 ? "fuzzy" : "path",
        related: Boolean(options.semantic && matchedTerms.some((term, index) => !groups[index].slice(0, 1).includes(term)))
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))
    .slice(0, limit);
}

export function buildSuspendCandidate(tab, now = Date.now(), idleMinutes = 30) {
  const idleSince = Number(tab.lastActivity || tab.observedAt || now);
  const idleMinutesElapsed = Math.max(0, Math.floor((now - idleSince) / 60_000));
  const requiredMinutes = Math.max(1, Number(idleMinutes) || 30);
  if (tab.status === "protected") {
    const reason = {
      "Unsaved edits": "检测到未保存内容",
      "Playing audio": "页面仍在播放音频",
      "Pinned tab": "页面已固定",
      "Active tab": "页面正在使用"
    }[tab.reason] || tab.reason || "页面受到保护";
    return { tabId: tab.id, eligible: false, score: 0, explanation: `${reason}，不会自动休眠。` };
  }
  if (tab.suspended) return { tabId: tab.id, eligible: false, score: 0, explanation: "页面已经休眠。" };
  if (idleMinutesElapsed < requiredMinutes) {
    return { tabId: tab.id, eligible: false, score: 0, explanation: `已闲置 ${idleMinutesElapsed} 分钟，未达到 ${requiredMinutes} 分钟阈值。` };
  }
  const score = Math.min(100, 45 + Math.round((idleMinutesElapsed / requiredMinutes) * 20));
  return {
    tabId: tab.id,
    eligible: true,
    score,
    explanation: `已闲置 ${idleMinutesElapsed} 分钟，满足 ${requiredMinutes} 分钟休眠条件。`
  };
}
