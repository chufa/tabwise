import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCompatibleEndpoint, modelRecipient, requestModelJson, compatibleAnswer, fetchModelJson } from "../src/shared/ai-provider.js";
import { createModelAccess } from "../src/background/model-access.js";

test("compatible endpoints require HTTPS or explicit loopback HTTP and reject credential-bearing URLs", () => {
  assert.equal(normalizeCompatibleEndpoint("https://model.test/v1/"), "https://model.test/v1");
  assert.equal(normalizeCompatibleEndpoint("http://localhost:1234/v1"), "http://localhost:1234/v1");
  for (const url of ["http://remote.test/v1", "http://localhost/v1", "https://key@remote.test/v1", "https://remote.test/v1?key=x", "https://remote.test/#x", "file:///v1"]) {
    assert.equal(normalizeCompatibleEndpoint(url), "");
  }
  assert.equal(modelRecipient({ aiProvider: "browser" }).model, "浏览器内置");
  assert.throws(() => modelRecipient({ aiProvider: "compatible" }), /配置/);
});
test("compatible requests send bounded structured messages with no cookies or redirects", async () => {
  const config = { provider: "compatible", endpoint: "https://model.test/v1", model: "model" };
  let calls = 0;
  const fetcher = async (url, init) => {
    calls++;
    assert.equal(url, "https://model.test/v1/chat/completions");
    assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer fixture-key");
    const body = JSON.parse(init.body);
    assert.equal(body.stream, false); assert.equal(body.response_format.type, "json_object");
    assert.equal(body.max_tokens, 2400);
    assert.ok(body.messages[0].content.includes("JSON"));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { total_tokens: 42 } }));
  };
  const result = await requestModelJson(config, "synthetic input", { type: "object" }, { fetcher, key: "fixture-key", maxTokens: 2400 });
  assert.equal(result.answer, '{"ok":true}'); assert.equal(result.usage.totalTokens, 42); assert.equal(calls, 1);
});
test("HTTP errors, malformed/truncated output, oversized bodies and cancelled requests do not leak server secrets or retry", async () => {
  const config = { provider: "compatible", endpoint: "https://model.test/v1", model: "model" };
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(requestModelJson(config, "input", {}, { fetcher: async () => { calls++; return new Response("secret-key", { status }); } }), (e) => !e.message.includes("secret-key"));
    assert.equal(calls, 1);
  }
  assert.throws(() => compatibleAnswer({ choices: [{ finish_reason: "length", message: { content: "{}" } }] }), /截断/);
  assert.throws(() => compatibleAnswer({ choices: [{ message: { tool_calls: [{}] } }] }), /文本/);
  await assert.rejects(requestModelJson(config, "input", {}, { fetcher: async () => new Response("x".repeat(1024 * 1024 + 1)) }), /过大/);
  await assert.rejects(requestModelJson(config, "input", {}, { fetcher: async () => new Response("not-json") }), /JSON/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestModelJson(config, "input", {}, { signal: controller.signal, fetcher: async () => { throw new Error("must not fetch"); } }), /停止/);
  await assert.rejects(requestModelJson(config, "input", {}, { fetcher: async () => { throw new Error("secret-key network failure"); } }), /无法连接/);
});

const owner = { id: "extension", url: "chrome-extension://extension/src/options/options.html", documentId: "options" };
function fixture() {
  const data = { local: {}, session: {} }, levels = {}, reads = [];
  globalThis.chrome = { runtime: { id: "extension", getURL: (p) => `chrome-extension://extension/${p}` }, storage: Object.fromEntries(["local", "session"].map((area) => [area, {
    setAccessLevel: async ({ accessLevel }) => { levels[area] = accessLevel; },
    get: async (key) => { reads.push(area); assert.equal(levels[area], "TRUSTED_CONTEXTS"); return structuredClone({ [key]: data[area][key] }); },
    set: async (value) => Object.assign(data[area], structuredClone(value)),
    remove: async (key) => { delete data[area][key]; }
  }])) };
  let settings = { aiProvider: "compatible", compatibleEndpoint: "https://model.test/v1", compatibleModel: "model", compatibleJson: true };
  const access = createModelAccess({ getSettings: async () => settings, changeSettings: async (update) => { settings = update(settings); return settings; } });
  return { access, data, reads, settings: () => settings };
}
test("keys are options-owned, endpoint-bound and session-only by default; metadata never reveals secrets", async () => {
  const f = fixture();
  await assert.rejects(f.access.handle({ type: "saveCompatibleConfig", endpoint: "https://model.test/v1", model: "model", key: "fixture-key" }, { ...owner, url: "https://web.test/" }), /设置页/);
  assert.equal(f.reads.length, 0);
  await f.access.handle({ type: "saveCompatibleConfig", endpoint: "https://model.test/v1", model: "model", key: "fixture-key" }, owner);
  assert.ok(JSON.stringify(f.data.session).includes("fixture-key")); assert.ok(!JSON.stringify(f.data.local).includes("fixture-key"));
  assert.ok(!JSON.stringify(f.settings()).includes("fixture-key"));
  const first = await f.access.config();
  assert.ok(!JSON.stringify(first).includes("fixture-key"));
  const status = await f.access.handle({ type: "getModelCredentialStatus" }, owner);
  assert.equal(status.hasKey, true); assert.equal(status.persistence, "session");
  assert.ok(!JSON.stringify(status).includes("fixture-key"));
  await assert.rejects(f.access.handle({ type: "saveCompatibleConfig", endpoint: "https://other.test/v1", model: "model" }, owner), /密钥/);
  await f.access.handle({ type: "saveCompatibleConfig", endpoint: "https://model.test/v1", model: "model", key: "new-fixture", persist: true }, owner);
  assert.ok(JSON.stringify(f.data.local).includes("new-fixture")); assert.ok(!JSON.stringify(f.data.session).includes("new-fixture"));
  assert.notEqual((await f.access.config()).credentialRevision, first.credentialRevision);
  await f.access.handle({ type: "clearModelCredential" }, owner);
  assert.equal((await f.access.handle({ type: "getModelCredentialStatus" }, owner)).hasKey, false);
  assert.ok(!JSON.stringify(f.data).includes("new-fixture"));
});
test("provider timeout aborts transport, oversized declared bodies are cancelled, and refusals remain data", async () => {
  let cancelled = false, timeoutSignal;
  const fetcher = async (url, init) => {
    timeoutSignal = init.signal;
    return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  };
  await assert.rejects(fetchModelJson("https://model.test/v1", {}, { fetcher, timeoutMs: 5 }), /超时/);
  assert.equal(timeoutSignal.aborted, true);
  await assert.rejects(fetchModelJson("https://model.test/v1", {}, { fetcher: async () => new Response(new ReadableStream({
    cancel() { cancelled = true; }
  }), { headers: { "content-length": 1024 * 1024 + 1 } }) }), /过大/);
  assert.equal(cancelled, true);
  assert.throws(() => compatibleAnswer({ choices: [{ message: { refusal: "refused" } }] }), /拒绝/);
  await assert.rejects(requestModelJson({ provider: "ollama", endpoint: "https://remote.test", model: "model" }, "input", {}), /地址/);
  await assert.rejects(requestModelJson({ provider: "browser" }, "input", {}), /提供方/);
  await assert.rejects(requestModelJson({ provider: "compatible", endpoint: "https://model.test/v1", model: "model" }, "x".repeat(120001), {}), /输入/);
});
test("model access performs authenticated probes and model listing, and rejects a changed credential during inference", async () => {
  const f = fixture(), savedFetch = globalThis.fetch;
  let received, complete, started;
  const pendingFetch = new Promise((resolve) => { complete = resolve; });
  try {
    await f.access.handle({ type: "saveCompatibleConfig", endpoint: "https://model.test/v1", model: "model", key: "fixture-key" }, owner);
    globalThis.fetch = async (url, init) => {
      assert.equal(init.headers.Authorization, "Bearer fixture-key");
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "model" }, { id: "model" }, { id: "<bad>" }] }));
      const request = JSON.parse(init.body); received = request;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }));
    };
    assert.deepEqual((await f.access.handle({ type: "listCompatibleModels" }, owner)).models, ["model"]);
    assert.equal((await f.access.handle({ type: "testCompatibleConnection" }, owner)).ok, true);
    assert.equal(received.max_tokens, 64);
    const snapshot = await f.access.config();
    const arrived = new Promise((resolve) => { started = resolve; });
    globalThis.fetch = async () => { started(); return pendingFetch; };
    const run = f.access.generate(snapshot, "input", {});
    await arrived;
    await f.access.handle({ type: "clearModelCredential" }, owner);
    complete(new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] })));
    await assert.rejects(run, /密钥已变化/);
    assert.ok(!JSON.stringify(await f.access.config()).includes("fixture-key"));
    f.settings().aiProvider = "browser";
    await assert.rejects(f.access.handle({ type: "listCompatibleModels" }, owner), /保存/);
    await assert.rejects(f.access.handle({ type: "saveCompatibleConfig", endpoint: "https://model.test/v1", model: "model", key: "newline\nkey" }, owner), /格式/);
  } finally { globalThis.fetch = savedFetch; }
});
test("Ollama model access applies structured bounds and gives an actionable origin error without body echoes", async () => {
  const f = fixture(), savedFetch = globalThis.fetch;
  f.settings().aiProvider = "ollama"; f.settings().ollamaEndpoint = "http://127.0.0.1:11434"; f.settings().ollamaModel = "fixture";
  try {
    const snapshot = await f.access.config();
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(init.body);
      assert.equal(payload.think, false);
      assert.equal(payload.options.num_predict, 1600);
      return new Response(JSON.stringify({ response: "{}", done: true, eval_count: 10 }));
    };
    const result = await f.access.generate(snapshot, "input", {}, { maxTokens: 1600 });
    assert.equal(result.usage.totalTokens, 10);
    globalThis.fetch = async () => new Response("secret echoed", { status: 403 });
    await assert.rejects(f.access.generate(snapshot, "input", {}), /OLLAMA_ORIGINS/);
    globalThis.fetch = async () => new Response(JSON.stringify({ response: "{}", done: false }));
    await assert.rejects(f.access.generate(snapshot, "input", {}), /截断/);
    globalThis.fetch = async () => new Response(JSON.stringify({ response: "{}", done: true, done_reason: "length" }));
    await assert.rejects(f.access.generate(snapshot, "input", {}), /截断/);
  } finally { globalThis.fetch = savedFetch; }
});
