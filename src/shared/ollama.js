const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const OLLAMA_PROBE_SCHEMA = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { const: true } } };

export function ollamaCapability(body) {
  return Array.isArray(body?.capabilities) ? body.capabilities.includes("completion") : null;
}

export function validateOllamaProbe(answer) {
  let value;
  try { value = JSON.parse(answer); } catch { throw new Error("模型自检未返回有效 JSON。"); }
  if (!value || value.ok !== true || Object.keys(value).length !== 1) throw new Error("模型自检 JSON 不符合要求。");
  return true;
}

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

export function buildOllamaRequest(prompt, model, format) {
  return {
    model: normalizeOllamaModel(model),
    // Structured input is already bounded to 20 pages by the snapshot builder.
    prompt: format ? String(prompt || "") : String(prompt || "").slice(0, 6_000),
    stream: false,
    ...(format ? { format, think: false } : {}),
    options: { temperature: 0.2, num_predict: 900 }
  };
}
