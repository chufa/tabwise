const MAX_RECORDS = 50;

export function redactDiagnostic({ source = "unknown", message = "", at = Date.now() }) {
  const redacted = String(message)
    .replace(/[a-z][a-z\d+.-]*:\/\/[^/\s?#]+(?:\/[^\s?#]*)?(?:\?[^\s#]*)?(?:#[^\s]*)?/gi, (value) => {
      try {
        const url = new URL(value);
        return `${url.protocol}//${url.hostname}`;
      } catch {
        return "[address]";
      }
    })
    .replace(/\b(?:token|key|secret|password)=([^\s&]+)/gi, "$1=[redacted]")
    .slice(0, 280);
  return { source: String(source).slice(0, 48), message: redacted, at: Number(at) || Date.now() };
}

export function appendDiagnostic(records, item) {
  return [redactDiagnostic(item), ...records].slice(0, MAX_RECORDS);
}

export function diagnosticBundle({ extensionVersion, settings = {}, records = [] }) {
  return {
    schemaVersion: 1,
    exportedAt: Date.now(),
    extensionVersion,
    settings: {
      idleMinutes: settings.idleMinutes,
      autoSuspend: Boolean(settings.autoSuspend),
      suspensionMode: settings.suspensionMode,
      suspensionStrategy: settings.suspensionStrategy,
      resourceBudgetEnabled: Boolean(settings.resourceBudgetEnabled),
      trustedDomainCount: settings.trustedDomains?.length || 0,
      blockedDomainCount: settings.blockedDomains?.length || 0
    },
    records: records.map(redactDiagnostic)
  };
}
