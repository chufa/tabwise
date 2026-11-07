export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export function highlightMatch(value, query = "") {
  const text = String(value || "");
  const tokens = [...new Set(String(query).trim().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!tokens.length) return escapeHtml(text);
  const pattern = new RegExp(tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu");
  let output = "", cursor = 0;
  for (const match of text.matchAll(pattern)) {
    output += escapeHtml(text.slice(cursor, match.index)) + `<mark>${escapeHtml(match[0])}</mark>`;
    cursor = match.index + match[0].length;
  }
  return output + escapeHtml(text.slice(cursor));
}
