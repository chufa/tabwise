import { pinyin } from "../vendor/pinyin-pro.mjs";
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh", { granularity: "word" }) : null;

export function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, " ")
    .trim();
}

function queryTerms(query) {
  const normalized = normalize(query);
  return (segmenter ? [...segmenter.segment(normalized)].filter((part) => part.isWordLike).map((part) => part.segment) : normalized.split(/\s+/))
    .filter((term) => term.length > 1 || /[\u3400-\u9fff]/.test(term));
}

const ASSOCIATIONS = [
  ["前端", "frontend", "react", "javascript", "typescript", "css"],
  ["性能", "performance", "perf", "profiling", "optimize", "optimization"],
  ["浏览器", "browser", "chrome", "chromium", "extension", "扩展"],
  ["数据库", "database", "sql", "postgres", "mysql", "redis"],
  ["设计", "design", "ux", "ui", "figma"]
];

function queryGroups(query, semantic) {
  return queryTerms(query).map((term) => semantic ? ASSOCIATIONS.find((association) => association.includes(term)) || [term] : [term]);
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
  const normalized = value;
  if (!normalized) return 0;
  return terms.reduce((score, term) => {
    if (normalized.includes(term)) return score + weight + term.length;
    return score + subsequenceScore(term, normalized);
  }, 0);
}

function editDistance(left, right) {
  const rows = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1));
  for (let i = 0; i <= left.length; i++) rows[i][0] = i;
  for (let j = 0; j <= right.length; j++) rows[0][j] = j;
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + Number(left[i - 1] !== right[j - 1]));
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[left.length][right.length];
}

function compilePage(page) {
  const title = normalize(page.title);
  const chinese = /[\u3400-\u9fff]/.test(title);
  const phonetic = chinese ? normalize(pinyin(page.title, { toneType: "none" })) : "";
  const initials = chinese ? normalize(pinyin(page.title, { pattern: "first", toneType: "none", type: "array" }).join("")) : "";
  return { ...page, _search: {
    title, domain: normalize(page.domain), url: normalize(page.url), haystack: normalize(`${page.title} ${page.domain} ${page.url}`),
    words: queryTerms(`${page.title} ${page.domain}`), phonetic: phonetic.replaceAll(" ", ""), initials
  } };
}

function matchesTerm(term, data) {
  if (data.haystack.includes(term)) return true;
  if (/^[a-z]+$/.test(term) && term.length >= 2 && (data.phonetic.includes(term) || data.initials.includes(term))) return true;
  if (/^[a-z]+$/.test(term) && term.length >= 4 && data.words.some((word) => Math.abs(word.length - term.length) <= 2 && editDistance(term, word) <= (term.length >= 7 ? 2 : 1))) return true;
  return data.words.some((word) => subsequenceScore(term, word) >= term.length * 3);
}

export function createPageIndex() {
  const entries = new Map();
  let compiled = 0;
  return {
    stats: () => ({ size: entries.size, compiled }),
    replace(pages) {
      const ids = new Set();
      for (const page of pages) {
        ids.add(page.id);
        const prior = entries.get(page.id);
        const signature = JSON.stringify([page.title, page.domain, page.url]);
        if (prior?.signature !== signature) { entries.set(page.id, { signature, page: compilePage(page) }); compiled++; }
        else prior.page = { ...page, _search: prior.page._search };
      }
      for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id);
    },
    search(query, limit, options) { return searchPageMemory([...entries.values()].map((entry) => entry.page), query, limit, options); }
  };
}

function tabActivityTime(tab) {
  return Number(tab.lastActivity || tab.lastAccessed || tab.observedAt || 0);
}

function tabMemoryUsage(tab) {
  const usage = Number(tab.memory?.usedJSHeapSize);
  return Number.isFinite(usage) && usage > 0 ? usage : null;
}

export function sortTabs(tabs, sort = "recent") {
  return [...tabs].sort((left, right) => {
    if (sort === "duration") {
      const duration = Number(left.observedAt || 0) - Number(right.observedAt || 0);
      if (duration) return duration;
    }

    if (sort === "memory") {
      const leftMemory = tabMemoryUsage(left);
      const rightMemory = tabMemoryUsage(right);
      if (leftMemory === null && rightMemory !== null) return 1;
      if (leftMemory !== null && rightMemory === null) return -1;
      if (leftMemory !== null && rightMemory !== null && leftMemory !== rightMemory) return rightMemory - leftMemory;
    }

    return tabActivityTime(right) - tabActivityTime(left)
      || String(left.title || "").localeCompare(String(right.title || ""));
  });
}

export function searchPageMemory(pages, query, limit = 30, options = {}) {
  const groups = queryGroups(query, Boolean(options.semantic));
  if (!groups.length) return [];
  const newestAccess = Math.max(...pages.map((page) => Number(page.lastAccessed || page.createdAt || 0)), 0);

  const filtered = pages.filter((page) => (!options.source || options.source === "all" || page.source === options.source)
    && (!options.workspaceId || page.workspaceId === options.workspaceId)
    && (!options.windowId || page.windowId === Number(options.windowId))
    && (!options.status || options.status === "all" || (options.status === "suspended" ? page.status === "suspended" : page.status === options.status)));
  const ranked = filtered
    .map((original) => {
      const compiled = original._search ? original : compilePage(original);
      const { _search: data, ...page } = compiled;
      const matchedTerms = groups.map((group) => group.find((term) => matchesTerm(term, data)));
      if (matchedTerms.some((term) => !term)) return null;
      const titleScore = matchedTerms.reduce((total, term) => total + fieldScore(data.title, [term], 40), 0);
      const domainScore = matchedTerms.reduce((total, term) => total + fieldScore(data.domain, [term], 24), 0);
      const urlScore = matchedTerms.reduce((total, term) => total + fieldScore(data.url, [term], 16), 0);

      const age = Math.max(0, newestAccess - Number(page.lastAccessed || page.createdAt || 0));
      const recency = Math.max(0, 12 - age / 86_400_000);
      const sourceBoost = page.source === "open" ? 36 : page.source === "suspended" ? 12 : 2;
      const statusBoost = page.status === "live" ? 4 : page.status === "suspended" ? 3 : 0;
      const phoneticScore = matchedTerms.some((term) => data.phonetic.includes(term) || data.initials.includes(term)) ? 30 : 0;
      const score = titleScore + domainScore + urlScore + recency + sourceBoost + statusBoost + phoneticScore;
      return {
        ...page,
        score,
        matchKind: titleScore >= 40 ? "fuzzy" : "path",
        related: Boolean(options.semantic && matchedTerms.some((term, index) => !groups[index].slice(0, 1).includes(term)))
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0));
  const results = options.deduplicate ? [...ranked.reduce((map, page) => {
    const existing = map.get(page.url);
    if (existing) existing.sources.push({ id: page.id, source: page.source, workspaceId: page.workspaceId, workspaceName: page.workspaceName, checkpointId: page.checkpointId });
    else map.set(page.url, { ...page, sources: [{ id: page.id, source: page.source, workspaceId: page.workspaceId, workspaceName: page.workspaceName, checkpointId: page.checkpointId }] });
    return map;
  }, new Map()).values()] : ranked;
  return results.slice(0, Math.min(100, Math.max(1, Number(limit) || 30)));
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
