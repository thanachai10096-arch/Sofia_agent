import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadModelConfigFromEnv } from "./config.js";

const names = [
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

test("Gemini key selects Gemini OpenAI-compatible endpoint and default model", () => {
  clear();
  process.env.GEMINI_API_KEY = "test-key";
  const config = loadModelConfigFromEnv();
  assert.equal(config.routes.length, 4);
  assert.equal(config.providers.fast?.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(config.providers.fast?.model, "gemini-2.5-flash");
  assert.equal(config.providers.coding?.model, "gemini-2.5-flash");
});

test("explicit Sofia gateway key takes precedence when both keys are present", () => {
  clear();
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.SOFIA_AI_GATEWAY_API_KEY = "legacy-test-key";
  process.env.SOFIA_FAST_MODEL = "gateway-fast";
  process.env.SOFIA_CODING_MODEL = "gateway-coding";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.apiKey, "legacy-test-key");
  assert.equal(config.providers.fast?.baseUrl, "https://ai-gateway.vercel.sh/v1");
  assert.equal(config.providers.fast?.model, "gateway-fast");
  assert.equal(config.providers.coding?.model, "gateway-coding");
});

test("Gemini-specific route model overrides shared Gemini model", () => {
  clear();
  process.env.Gemini_API_Key = "test-key";
  process.env.GEMINI_MODEL = "gemini-shared";
  process.env.GEMINI_CODING_MODEL = "gemini-coding";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.coding?.model, "gemini-coding");
  assert.equal(config.providers.fast?.model, "gemini-shared");
});

test("legacy gateway configuration remains supported when Gemini is absent", () => {
  clear();
  process.env.SOFIA_AI_GATEWAY_API_KEY = "legacy-test-key";
  process.env.SOFIA_AI_GATEWAY_URL = "https://gateway.example/v1";
  process.env.SOFIA_FAST_MODEL = "legacy-fast";
  const config = loadModelConfigFromEnv();
  assert.equal(config.routes.length, 1);
  assert.equal(config.providers.fast?.baseUrl, "https://gateway.example/v1");
  assert.equal(config.providers.fast?.model, "legacy-fast");
});

test("Kimi key takes precedence and selects the Moonshot OpenAI-compatible endpoint", () => {
  clear();
  process.env.Kimi_key = "kimi-test-key";
  process.env.SOFIA_AI_GATEWAY_API_KEY = "gateway-test-key";
  process.env.SOFIA_FAST_MODEL = "configured-fast";
  process.env.KIMI_MODEL = "kimi-test-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.apiKey, "kimi-test-key");
  assert.equal(config.providers.fast?.baseUrl, "https://api.moonshot.ai/v1");
  assert.equal(config.providers.fast?.model, "kimi-test-model");
  assert.equal(config.providers.coding?.model, "kimi-test-model");
});

test("Kimi route-specific model overrides shared Kimi model", () => {
  clear();
  process.env.KIMI_API_KEY = "kimi-test-key";
  process.env.KIMI_MODEL = "kimi-shared";
  process.env.KIMI_CODING_MODEL = "kimi-coding";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.coding?.model, "kimi-coding");
  assert.equal(config.providers.fast?.model, "kimi-shared");
});
