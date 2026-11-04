import test from "node:test";
import assert from "node:assert/strict";
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
