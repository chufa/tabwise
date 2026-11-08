import { modelRecipient, sameModel, normalizeCompatibleEndpoint, requestModelJson, fetchModelJson } from "../shared/ai-provider.js";
import { normalizeOllamaModel, OLLAMA_PROBE_SCHEMA, validateOllamaProbe } from "../shared/ollama.js";

const KEY = "modelCredential";
export const MODEL_COMMANDS = new Set(["getModelCredentialStatus", "saveCompatibleConfig", "clearModelCredential", "listCompatibleModels", "testCompatibleConnection"]);
export function createModelAccess({ getSettings, changeSettings }) {
  let queue = Promise.resolve();
  const serialized = (work) => { const job = queue.then(work); queue = job.catch(() => {}); return job; };
  const secure = async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  };
  const read = async () => {
    await secure();
    const session = (await chrome.storage.session.get(KEY))[KEY];
    if (session) return { ...session, persistence: "session" };
    const local = (await chrome.storage.local.get(KEY))[KEY];
    return local ? { ...local, persistence: "local" } : null;
  };
  const configured = async () => {
    const config = modelRecipient(await getSettings());
    if (config.provider === "compatible") {
      const credential = await read();
      config.credentialRevision = credential?.endpoint === config.endpoint ? credential.revision : "";
    }
    return config;
  };
  const guard = (sender) => {
    if (sender?.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("src/options/options.html") || !sender.documentId) throw new Error("模型密钥仅可从 TabWise 设置页管理。");
  };
  const credentialFor = async (endpoint) => {
    const stored = await read();
    return stored?.endpoint === endpoint ? stored : null;
  };
  return {
    config: () => serialized(configured),
    async generate(snapshot, prompt, schema, options = {}) {
      const credential = await serialized(async () => {
        if (!sameModel(await configured(), snapshot)) throw new Error("模型设置或密钥已变化，请重新预览。");
        return snapshot.provider === "compatible" ? credentialFor(snapshot.endpoint) : null;
      });
      let result;
      try { result = await requestModelJson(snapshot, prompt, schema, { ...options, key: credential?.key || "" }); }
      catch (error) {
        if (snapshot.provider === "ollama" && error.message.includes("HTTP 403")) {
          throw new Error(`Ollama 拒绝扩展来源（403）。请将 OLLAMA_ORIGINS 设为 ${chrome.runtime.getURL("").replace(/\/$/, "")} 并重启本地服务。`);
        }
        throw error;
      }
      if (!sameModel(await serialized(configured), snapshot)) throw new Error("模型设置或密钥已变化，请重新预览。");
      return result;
    },
    async handle(message, sender) {
      guard(sender);
      if (["listCompatibleModels", "testCompatibleConnection"].includes(message.type)) {
        const config = await serialized(configured);
        if (config.provider !== "compatible") throw new Error("请先保存兼容 API 设置。");
        const credential = await serialized(() => credentialFor(config.endpoint));
        if (message.type === "listCompatibleModels") {
          const body = await fetchModelJson(`${config.endpoint}/models`, { headers: credential?.key ? { Authorization: `Bearer ${credential.key}` } : {} }, { timeoutMs: 15_000 });
          return { ok: true, models: [...new Set((Array.isArray(body?.data) ? body.data : []).map((item) => normalizeOllamaModel(item?.id)).filter(Boolean))].slice(0, 100) };
        }
        const result = await this.generate(config, '仅输出 JSON {"ok":true}。模型自检，不涉及网页数据。', OLLAMA_PROBE_SCHEMA, { maxTokens: 64 });
        validateOllamaProbe(result.answer);
        return { ok: true, latencyMs: result.latencyMs, usage: result.usage };
      }
      return serialized(async () => {
        if (message.type === "getModelCredentialStatus") {
          const stored = await read();
          return { ok: true, hasKey: Boolean(stored?.key), endpoint: stored?.endpoint || "", persistence: stored?.persistence || "session" };
        }
        if (message.type === "clearModelCredential") {
          await secure();
          await chrome.storage.local.remove(KEY); await chrome.storage.session.remove(KEY);
          return { ok: true };
        }
        if (message.type !== "saveCompatibleConfig") throw new Error("模型配置命令无效。");
        const endpoint = normalizeCompatibleEndpoint(message.endpoint), model = normalizeOllamaModel(message.model);
        if (!endpoint || !model) throw new Error("请填写有效的 HTTPS API 地址（本机可用带端口 HTTP）和模型名。");
        const key = typeof message.key === "string" ? message.key.trim() : "";
        if (key.length > 512 || /[^\x21-\x7e]/.test(key)) throw new Error("密钥格式无效。");
        const old = await read();
        if (!key && old?.key && old.endpoint !== endpoint) throw new Error("地址已变化，请填写新服务的密钥或先清除旧密钥。");
        const next = { endpoint, key: key || old?.key || "", revision: crypto.randomUUID() };
        // Persist only through this explicit options command, never through settings/backup/sync.
        await chrome.storage[message.persist === true ? "local" : "session"].set({ [KEY]: next });
        await chrome.storage[message.persist === true ? "session" : "local"].remove(KEY);
        await changeSettings((current) => ({ ...current, aiProvider: "compatible", compatibleEndpoint: endpoint, compatibleModel: model, compatibleJson: message.jsonMode !== false }));
        return { ok: true };
      });
    }
  };
}
