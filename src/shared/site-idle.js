import { domainForUrl, normalizeDomain } from "./policy.js";

export function normalizeIdleRules(rules = []) {
  if (!Array.isArray(rules) || rules.length > 100) throw new Error("站点闲置规则最多 100 项。");
  const normalized = new Map();
  for (const rule of rules) {
    const domain = normalizeDomain(rule.domain);
    if (!domain) throw new Error("站点闲置规则需使用有效域名。");
    const minutes = Number(rule.minutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) throw new Error("站点闲置时间需为 5–1440 分钟。");
    normalized.set(domain, { domain, minutes });
  }
  return [...normalized.values()];
}

export const parseIdleRules = (value) => normalizeIdleRules(String(value).split("\n").filter((line) => line.trim()).map((line) => {
  const [domain, minutes, extra] = line.trim().split(/[\s,]+/);
  if (extra) throw new Error("每行填写“域名 分钟”。");
  return { domain, minutes: Number(minutes) };
}));

export function idleMinutesForUrl(url, settings = {}) {
  const host = domainForUrl(url);
  const matching = (settings.siteIdleRules || []).filter((rule) => host === rule.domain || host.endsWith(`.${rule.domain}`))
    .sort((a, b) => b.domain.length - a.domain.length);
  return matching[0]?.minutes || settings.idleMinutes || 30;
}

export function temporaryProtectionReason(tab, states = {}, now = Date.now()) {
  const protection = states[tab.id];
  if (!protection || protection.url !== tab.url || protection.until !== 0 && protection.until <= now) return "";
  return protection.until === 0 ? "本次会话已保护此页" : "此页暂时受保护";
}
