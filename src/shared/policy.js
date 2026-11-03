import { SUSPENDED_PAGE } from "./constants.js";

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

export function suspensionBlockReason(tab, settings, extensionOrigin) {
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
  if (!matchesDomain(domain, settings.trustedDomains || [])) return "Untrusted domain";
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
