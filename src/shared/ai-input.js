export function sanitizeAiText(value) {
  return String(value || "")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[网址已隐去]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已隐去]")
    .replace(/\b(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*\S+/gi, "[敏感字段已隐去]")
    .replace(/\b(?:sk-|ghp_|github_pat_)[a-zA-Z0-9_-]+/g, "[凭据已隐去]");
}
