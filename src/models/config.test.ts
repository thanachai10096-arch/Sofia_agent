import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadModelConfigFromEnv } from "./config.js";

const names = [
  "SOFIA_MODEL_PROVIDERS",
  "SOFIA_FAST_PROVIDER", "SOFIA_CODING_PROVIDER", "SOFIA_REASONING_PROVIDER", "SOFIA_VISION_PROVIDER",
  "SOFIA_FAST_BASE_URL", "SOFIA_CODING_BASE_URL", "SOFIA_REASONING_BASE_URL", "SOFIA_VISION_BASE_URL",
  "SOFIA_FAST_API_KEY", "SOFIA_CODING_API_KEY", "SOFIA_REASONING_API_KEY", "SOFIA_VISION_API_KEY",
  "SOFIA_FAST_MODEL", "SOFIA_CODING_MODEL", "SOFIA_REASONING_MODEL", "SOFIA_VISION_MODEL",
  "SOFIA_FAST_COST", "SOFIA_FAST_LATENCY", "SOFIA_FAST_QUALITY",
  "GEMINI_API_KEY", "Gemini_API_Key", "GEMINI_MODEL",
  "GEMINI_FAST_MODEL", "GEMINI_CODING_MODEL", "GEMINI_REASONING_MODEL", "GEMINI_VISION_MODEL",
  "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "SOFIA_AI_GATEWAY_API_KEY",
  "SOFIA_FAST_API_KEY_ENV", "SOFIA_CODING_API_KEY_ENV", "SOFIA_REASONING_API_KEY_ENV", "SOFIA_VISION_API_KEY_ENV",
  "TEST_PROVIDER_KEY",
];
const original = new Map(names.map((name) => [name, process.env[name]]));
function clear() { for (const name of names) delete process.env[name]; }
afterEach(() => {
  clear();
  for (const [name, value] of original) if (value !== undefined) process.env[name] = value;
});

test("keeps legacy Gemini configuration backward compatible", () => {
  clear();
  process.env.GEMINI_API_KEY = "gemini-test-key";
  const config = loadModelConfigFromEnv();
  assert.equal(config.routes.length, 4);
  for (const route of config.routes) {
    const provider = config.providers[route.id];
    assert.equal(provider?.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai/");
    assert.equal(provider?.apiKey, "gemini-test-key");
    assert.equal(provider?.model, "gemini-2.5-flash");
  }
});

test("supports arbitrary OpenAI-compatible providers and independent models per route", () => {
  clear();
  process.env.TEST_PROVIDER_KEY = "secret-for-test";
  process.env.SOFIA_MODEL_PROVIDERS = JSON.stringify({
    openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "TEST_PROVIDER_KEY", model: "vendor/default" },
    ollama: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:14b" },
  });
  process.env.SOFIA_FAST_PROVIDER = "openrouter";
  process.env.SOFIA_CODING_PROVIDER = "ollama";
  process.env.SOFIA_REASONING_PROVIDER = "openrouter";
  process.env.SOFIA_VISION_PROVIDER = "openrouter";
  process.env.SOFIA_FAST_MODEL = "vendor/fast-model";
  process.env.SOFIA_REASONING_MODEL = "vendor/reasoner";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "https://openrouter.ai/api/v1/");
  assert.equal(config.providers.fast?.apiKey, "secret-for-test");
  assert.equal(config.providers.fast?.model, "vendor/fast-model");
  assert.equal(config.providers.coding?.baseUrl, "http://localhost:11434/v1/");
  assert.equal(config.providers.coding?.apiKey, "");
  assert.equal(config.providers.coding?.model, "qwen2.5:14b");
  assert.equal(config.providers.reasoning?.model, "vendor/reasoner");
  assert.equal(config.routes.find((route) => route.id === "coding")?.providerId, "coding");
});

test("supports a single declared provider as the default for all routes", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDERS = JSON.stringify({
    gateway: { baseUrl: "https://api.example.com/v1", apiKeyEnv: "TEST_PROVIDER_KEY", model: "model-x" },
  });
  process.env.TEST_PROVIDER_KEY = "secret";
  const config = loadModelConfigFromEnv();
  assert.equal(config.routes.length, 4);
  assert.equal(config.providers.vision?.model, "model-x");
});

test("rejects malformed provider manifest and unsafe remote HTTP URLs", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDERS = "{bad json";
  assert.throws(loadModelConfigFromEnv, /valid JSON/);
  process.env.SOFIA_MODEL_PROVIDERS = JSON.stringify({
    bad: { baseUrl: "http://api.example.com/v1", model: "model-x" },
  });
  assert.throws(loadModelConfigFromEnv, /HTTPS/);
});

test("rejects invalid provider references instead of silently falling back", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDERS = JSON.stringify({
    valid: { baseUrl: "https://api.example.com/v1", model: "model-x" },
  });
  process.env.SOFIA_FAST_PROVIDER = "missing";
  assert.throws(loadModelConfigFromEnv, /No provider configured for route fast/);
});

test("preserves route weights and supports legacy per-route Gemini model overrides", () => {
  clear();
  process.env.Gemini_API_Key = "gemini-existing-test-key";
  process.env.GEMINI_MODEL = "gemini-shared-model";
  process.env.GEMINI_CODING_MODEL = "gemini-coding-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.model, "gemini-shared-model");
  assert.equal(config.providers.coding?.model, "gemini-coding-model");
  assert.equal(config.routes.find((route) => route.id === "coding")?.qualityWeight, 8);
});

test("fails clearly when neither generic providers nor legacy Gemini are configured", () => {
  clear();
  assert.throws(loadModelConfigFromEnv, /SOFIA_MODEL_PROVIDERS/);
});

test("configures a native Anthropic Messages provider", () => {
  clear();
  process.env.TEST_PROVIDER_KEY = "anthropic-secret";
  process.env.SOFIA_MODEL_PROVIDERS = JSON.stringify({ anthropic: { baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "TEST_PROVIDER_KEY", model: "claude-sonnet-test", protocol: "anthropic-messages" } });
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.protocol, "anthropic-messages");
  assert.equal(config.providers.fast?.apiKey, "anthropic-secret");
  assert.equal(config.providers.fast?.baseUrl, "https://api.anthropic.com/v1/");
});

test("rejects unsupported provider protocols instead of silently treating them as OpenAI-compatible", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDERS = JSON.stringify({ unknown: { baseUrl: "https://api.example.com/v1", model: "model-x", protocol: "custom-wire" } });
  assert.throws(loadModelConfigFromEnv, /protocol must be/);
});
