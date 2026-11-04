const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function normalizeOllamaEndpoint(value, fallback = "") {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname === "::1" ? "[::1]" : url.hostname) || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return fallback;
    }
    return url.origin;
  } catch {
    return fallback;
  }
}

export function normalizeOllamaModel(value, fallback = "") {
  const model = String(value || "").trim().slice(0, 120);
  return /^[a-zA-Z0-9_.:/-]+$/.test(model) ? model : fallback;
}

export function buildOllamaRequest(prompt, model) {
  return {
    model: normalizeOllamaModel(model),
    prompt: String(prompt || "").slice(0, 6_000),
    stream: false,
    options: { temperature: 0.2, num_predict: 900 }
  };
}
