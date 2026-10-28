import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadModelConfigFromEnv } from "./config.js";

const names = [
  "SOFIA_MODEL_PROVIDER", "SOFIA_MODEL_BASE_URL", "SOFIA_MODEL_API_KEY", "SOFIA_MODEL_NAME",
  "SOFIA_FAST_MODEL", "SOFIA_CODING_MODEL", "SOFIA_REASONING_MODEL", "SOFIA_VISION_MODEL",
  "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "OPENROUTER_MODEL",
  "OPENROUTER_FAST_MODEL", "OPENROUTER_CODING_MODEL", "OPENROUTER_REASONING_MODEL", "OPENROUTER_VISION_MODEL",
  "GEMINI_API_KEY", "Gemini_API_Key", "GEMINI_MODEL",
  "GEMINI_FAST_MODEL", "GEMINI_CODING_MODEL", "GEMINI_REASONING_MODEL", "GEMINI_VISION_MODEL",
  "SOFIA_FAST_COST", "SOFIA_FAST_LATENCY", "SOFIA_FAST_QUALITY",
];

const original = new Map(names.map((name) => [name, process.env[name]]));
function clear() { for (const name of names) delete process.env[name]; }
afterEach(() => {
  clear();
  for (const [name, value] of original) if (value !== undefined) process.env[name] = value;
});

test("generic OpenAI-compatible endpoint uses BASE_URL, KEY, and MODEL", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "openai-compatible";
  process.env.SOFIA_MODEL_BASE_URL = "https://api.example.test/v1/";
  process.env.SOFIA_MODEL_API_KEY = "test-key";
  process.env.SOFIA_MODEL_NAME = "example-model";
  process.env.SOFIA_CODING_MODEL = "coding-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.routes.length, 4);
  for (const route of config.routes) {
    assert.equal(config.providers[route.id]?.baseUrl, "https://api.example.test/v1/");
    assert.equal(config.providers[route.id]?.apiKey, "test-key");
  }
  assert.equal(config.providers.fast?.model, "example-model");
  assert.equal(config.providers.coding?.model, "coding-model");
});

test("Gemini remains an explicit provider option and supports the legacy key name", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "gemini";
  process.env.Gemini_API_Key = "gemini-test-key";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai/");
  assert.equal(config.providers.fast?.apiKey, "gemini-test-key");
  assert.equal(config.providers.fast?.model, "gemini-2.5-flash");
});

test("Gemini route model override takes precedence over the shared model", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.SOFIA_MODEL_NAME = "shared-model";
  process.env.SOFIA_CODING_MODEL = "coding-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.model, "shared-model");
  assert.equal(config.providers.coding?.model, "coding-model");
});

test("OpenRouter legacy configuration remains supported without provider fallback", () => {
  clear();
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.OPENROUTER_MODEL = "openrouter/auto";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "https://openrouter.ai/api/v1/");
  assert.equal(config.providers.fast?.apiKey, "openrouter-test-key");
  assert.equal(config.providers.fast?.model, "openrouter/auto");
});

test("unknown provider is rejected", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "unknown";
  assert.throws(loadModelConfigFromEnv, /SOFIA_MODEL_PROVIDER/);
});

test("missing required credentials fail with actionable configuration errors", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "openai-compatible";
  process.env.SOFIA_MODEL_BASE_URL = "https://api.example.test/v1";
  process.env.SOFIA_MODEL_NAME = "model";
  assert.throws(loadModelConfigFromEnv, /SOFIA_MODEL_API_KEY/);
});
