import test from "node:test";
import assert from "node:assert/strict";
import { ollamaCapability, validateOllamaProbe } from "../src/shared/ollama.js";

test("recognizes completion models and rejects invalid self-check output", () => {
  assert.equal(ollamaCapability({ capabilities: ["embedding"] }), false);
  assert.equal(ollamaCapability({ capabilities: ["completion", "vision"] }), true);
  assert.equal(ollamaCapability({}), null);
  assert.equal(validateOllamaProbe('{"ok":true}'), true);
  for (const output of ['{"ok":false}', 'text', '{"ok":true,"action":"close"}']) assert.throws(() => validateOllamaProbe(output));
});
import { buildOllamaRequest, normalizeOllamaEndpoint } from "../src/shared/ollama.js";

test("accepts only local Ollama endpoints", () => {
  assert.equal(normalizeOllamaEndpoint("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(normalizeOllamaEndpoint("http://localhost:11434/"), "http://localhost:11434");
  assert.equal(normalizeOllamaEndpoint("https://example.com:11434", "http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(normalizeOllamaEndpoint("http://127.0.0.1:11434/private", "http://127.0.0.1:11434"), "http://127.0.0.1:11434");
});

test("builds bounded non-streaming Ollama requests", () => {
  const request = buildOllamaRequest("整理标签", "qwen3:8b");

  assert.deepEqual(request, {
    model: "qwen3:8b",
    prompt: "整理标签",
    stream: false,
    options: { temperature: 0.2, num_predict: 900 }
  });
});

test("structured theme requests spend the output budget on JSON instead of thinking", () => {
  const schema = { type: "object" };
  const request = buildOllamaRequest("主题输入", "qwen3.8:27b-mlx", schema);
  assert.equal(request.think, false);
  assert.equal(request.format, schema);
  assert.equal(request.stream, false);
});
