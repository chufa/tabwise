import { SUSPENDED_PAGE } from "./constants.js";

export const SITE_RISK_TEMPLATES = Object.freeze([
  { id: "collaboration", label: "会议与协作", policy: "manual", domains: ["meet.google.com", "teams.microsoft.com", "zoom.us", "docs.google.com", "notion.so"] },
  { id: "mail-payment", label: "邮箱与支付", policy: "never", domains: ["mail.google.com", "outlook.office.com", "paypal.com", "stripe.com"] },
  { id: "development", label: "开发与 IDE", policy: "manual", domains: ["github.com", "gitlab.com", "codespaces.new", "stackblitz.com"] },
  { id: "reading", label: "阅读与新闻", policy: "native", domains: ["medium.com", "news.ycombinator.com", "wikipedia.org"] }
]);

export function normalizeDomain(value) {
  return value.trim().toLowerCase().replace(/^\*\./, "").replace(/^www\./, "");
}

export function domainForUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

export function matchesDomain(hostname, domains) {
  return domains.some((entry) => {
    const domain = normalizeDomain(entry);
    return domain && (hostname === domain || hostname.endsWith(`.${domain}`));
  });
}

export function isSuspendableUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function isSuspendedUrl(url, extensionOrigin) {
  return Boolean(url && extensionOrigin && url.startsWith(`${extensionOrigin}/${SUSPENDED_PAGE}`));
}

export function isExpectedSuspensionUrl(url, extensionOrigin, recordId) {
  return url === `${extensionOrigin}/${SUSPENDED_PAGE}#${recordId}`;
}

export function isIdleLongEnough(activity, tabId, thresholdMs, now = Date.now()) {
  const lastActive = activity?.[tabId];
  return Boolean(lastActive && now - lastActive >= thresholdMs);
}

export function sitePolicyForUrl(url, settings = {}) {
  const domain = domainForUrl(url);
  if (matchesDomain(domain, settings.blockedDomains || [])) return "never";
  if (matchesDomain(domain, settings.manualDomains || [])) return "manual";
  if (matchesDomain(domain, settings.nativeDiscardDomains || [])) return "native";
  return matchesDomain(domain, settings.trustedDomains || []) ? "auto" : "manual";
}

export function applySiteRiskTemplate(settings = {}, templateId, domains) {
  const template = SITE_RISK_TEMPLATES.find((item) => item.id === templateId);
  if (!template) throw new Error("站点模板不存在。");
  const selected = [...new Set((domains || template.domains).map(normalizeDomain).filter(Boolean))];
  const keys = { never: "blockedDomains", manual: "manualDomains", native: "nativeDiscardDomains" };
  const key = keys[template.policy];
  return { ...settings, [key]: [...new Set([...(settings[key] || []), ...selected])] };
}

export function suspensionBlockReason(tab, settings, extensionOrigin) {
  if (!tab?.id) return "Tab is unavailable";
  if (tab.active) return "Active tab";
  if (tab.pinned) return "Pinned tab";
  if (tab.audible) return "Playing audio";
  if (tab.status === "loading") return "Still loading";
  if (tab.discarded) return "Already discarded by browser";
  if (!isSuspendableUrl(tab.url)) return "Not a web page";
  if (isSuspendedUrl(tab.url, extensionOrigin)) return "Already suspended";

  const policy = sitePolicyForUrl(tab.url, settings);
  if (policy === "never") return "Never suspend domain";
  if (policy === "manual") return matchesDomain(domainForUrl(tab.url), settings.manualDomains || []) ? "Site policy: manual" : "Untrusted domain";
  return "";
}

export function smartSuspensionBlockReason(tab, settings, extensionOrigin, protection) {
  if (!tab?.id) return "Tab is unavailable";
  if (tab.active) return "Active tab";
  if (tab.pinned) return "Pinned tab";
  if (tab.audible) return "Playing audio";
  if (tab.status === "loading") return "Still loading";
  if (tab.discarded) return "Already discarded by browser";
  if (!isSuspendableUrl(tab.url)) return "Not a web page";
  if (isSuspendedUrl(tab.url, extensionOrigin)) return "Already suspended";

  const domain = domainForUrl(tab.url);
  if (matchesDomain(domain, settings.blockedDomains || [])) return "Never suspend domain";
  if (matchesDomain(domain, settings.manualDomains || [])) return "Site policy: manual";
  if (!protection?.ready) return "Protection status unknown";
  if (protection.dirty) return "Unsaved edits";
  if (protection.upload) return "Upload in progress";
  if (protection.media) return "Media activity";
  return "";
}

export function directSuspensionBlockReason(tab, extensionOrigin) {
  if (!tab?.id) return "Tab is unavailable";
  if (tab.active) return "Active tab";
  if (tab.status === "loading") return "Still loading";
  if (tab.discarded) return "Already discarded by browser";
  if (!isSuspendableUrl(tab.url)) return "Not a web page";
  if (isSuspendedUrl(tab.url, extensionOrigin)) return "Already suspended";
  return "";
}

export function planLocalOrganization(tabs) {
  const liveTabs = tabs.filter((tab) => isSuspendableUrl(tab.url));
  const byDomain = new Map();
  const byUrl = new Map();

  for (const tab of liveTabs) {
    const domain = domainForUrl(tab.url);
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(tab);

    const canonicalUrl = new URL(tab.url).href;
    if (!byUrl.has(canonicalUrl)) byUrl.set(canonicalUrl, []);
    byUrl.get(canonicalUrl).push(tab);
  }

  return {
    domainGroups: [...byDomain.entries()]
      .filter(([, items]) => items.length > 1)
      .map(([domain, items]) => ({ domain, tabIds: items.map((tab) => tab.id) })),
    duplicates: [...byUrl.entries()]
      .filter(([, items]) => items.length > 1)
      .map(([url, items]) => ({ url, tabIds: items.map((tab) => tab.id) }))
  };
}
