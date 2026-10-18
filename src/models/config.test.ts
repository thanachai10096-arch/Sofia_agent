import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadModelConfigFromEnv } from "./config.js";

const names = [
  "OPENROUTER_API_KEY",
  "OPENROUTER",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_MODEL",
  "OPENROUTER_FAST_MODEL",
  "OPENROUTER_CODING_MODEL",
  "OPENROUTER_REASONING_MODEL",
  "OPENROUTER_VISION_MODEL",
  "Kimi_key",
  "KIMI_API_KEY",
  "KIMI_API_BASE_URL",
  "KIMI_MODEL",
  "KIMI_FAST_MODEL",
  "KIMI_CODING_MODEL",
  "KIMI_REASONING_MODEL",
  "KIMI_VISION_MODEL",
  "GEMINI_API_KEY",
  "Gemini_API_Key",
  "GEMINI_API_BASE_URL",
  "GEMINI_MODEL",
  "GEMINI_FAST_MODEL",
  "GEMINI_CODING_MODEL",
  "GEMINI_REASONING_MODEL",
  "GEMINI_VISION_MODEL",
  "SOFIA_AI_GATEWAY_API_KEY",
  "AI_GATEWAY_API_KEY",
  "SOFIA_AI_GATEWAY_URL",
  "SOFIA_FAST_MODEL",
  "SOFIA_CODING_MODEL",
  "SOFIA_REASONING_MODEL",
  "SOFIA_VISION_MODEL",
];

const original = new Map(names.map((name) => [name, process.env[name]]));

function clear() {
  for (const name of names) delete process.env[name];
}

afterEach(() => {
  clear();
  for (const [name, value] of original) {
    if (value !== undefined) process.env[name] = value;
  }
});

test("OpenRouter is the only provider and defaults to OpenRouter Auto Router", () => {
  clear();
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  const config = loadModelConfigFromEnv();
  assert.equal(config.routes.length, 4);
  for (const route of config.routes) {
    const provider = config.providers[route.id];
    assert.equal(provider?.baseUrl, "https://openrouter.ai/api/v1");
    assert.equal(provider?.apiKey, "openrouter-test-key");
    assert.equal(provider?.model, "openrouter/auto");
    assert.equal(provider?.fallbackModel, undefined);
  }
});

test("existing OPENROUTER secret is supported and route-specific model overrides work", () => {
  clear();
  process.env.OPENROUTER = "openrouter-existing-test-key";
  process.env.OPENROUTER_MODEL = "openai/gpt-4.1-mini";
  process.env.OPENROUTER_CODING_MODEL = "qwen/qwen3-coder:free";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.apiKey, "openrouter-existing-test-key");
  assert.equal(config.providers.fast?.model, "openai/gpt-4.1-mini");
  assert.equal(config.providers.fast?.fallbackModel, "openrouter/auto");
  assert.equal(config.providers.coding?.model, "qwen/qwen3-coder:free");
  assert.equal(config.providers.coding?.fallbackModel, "openrouter/auto");
});

test("other provider credentials and custom endpoint cannot override OpenRouter", () => {
  clear();
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.OPENROUTER_BASE_URL = "https://not-openrouter.example/v1";
  process.env.Kimi_key = "kimi-test-key";
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.SOFIA_AI_GATEWAY_API_KEY = "gateway-test-key";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.apiKey, "openrouter-test-key");
  assert.equal(config.providers.fast?.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(config.providers.fast?.model, "openrouter/auto");
});

test("SOFIA route-specific model aliases are honored while OPENROUTER overrides win", () => {
  clear();
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.OPENROUTER_MODEL = "openai/gpt-4.1-mini";
  process.env.SOFIA_FAST_MODEL = "google/gemini-2.5-flash";
  process.env.SOFIA_CODING_MODEL = "qwen/qwen3-coder:free";
  process.env.OPENROUTER_CODING_MODEL = "openai/gpt-4.1";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.model, "google/gemini-2.5-flash");
  assert.equal(config.providers.coding?.model, "openai/gpt-4.1");
  assert.equal(config.providers.reasoning?.model, "openai/gpt-4.1-mini");
});

test("fails closed when no OpenRouter credential exists", () => {
  clear();
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.Kimi_key = "kimi-test-key";
  process.env.SOFIA_AI_GATEWAY_API_KEY = "gateway-test-key";
  assert.throws(loadModelConfigFromEnv, /OPENROUTER_API_KEY/);
});
