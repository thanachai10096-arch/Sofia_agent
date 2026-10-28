import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadModelConfigFromEnv } from "./config.js";

const names = [
  "OPENROUTER_API_KEY",
  "OPENROUTER",
  "OPENROUTER_MODEL",
  "OPENROUTER_FAST_MODEL",
  "OPENROUTER_CODING_MODEL",
  "OPENROUTER_REASONING_MODEL",
  "OPENROUTER_VISION_MODEL",
  "GEMINI_API_KEY",
  "Gemini_API_Key",
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
  "SOFIA_MODEL_PROVIDER",
  "SOFIA_MODEL_BASE_URL",
  "SOFIA_MODEL_API_KEY",
  "SOFIA_MODEL",
  "SOFIA_MODEL_ALLOW_INSECURE_HTTP",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "OPENAI_FAST_MODEL",
  "OPENAI_CODING_MODEL",
  "OPENAI_REASONING_MODEL",
  "OPENAI_VISION_MODEL",
  "BASE_URL",
  "API_KEY",
  "MODEL",
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

test("Gemini key selects direct Google Gemini API by default", () => {
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

test("existing Gemini_API_Key deployment secret remains supported", () => {
  clear();
  process.env.Gemini_API_Key = "gemini-existing-test-key";
  process.env.GEMINI_MODEL = "gemini-custom-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.apiKey, "gemini-existing-test-key");
  assert.equal(config.providers.fast?.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai/");
  assert.equal(config.providers.fast?.model, "gemini-custom-model");
});

test("Gemini route-specific model overrides the shared Gemini model", () => {
  clear();
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.GEMINI_MODEL = "gemini-shared-model";
  process.env.GEMINI_CODING_MODEL = "gemini-coding-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.model, "gemini-shared-model");
  assert.equal(config.providers.coding?.model, "gemini-coding-model");
  assert.equal(config.providers.reasoning?.model, "gemini-shared-model");
});

test("OpenRouter and legacy gateway credentials cannot override Gemini", () => {
  clear();
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.OPENROUTER_MODEL = "openai-test-model";
  process.env.SOFIA_AI_GATEWAY_API_KEY = "legacy-test-key";
  process.env.SOFIA_FAST_MODEL = "legacy-fast-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.apiKey, "gemini-test-key");
  assert.equal(config.providers.fast?.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai/");
  assert.equal(config.providers.fast?.model, "gemini-2.5-flash");
});

test("fails closed when no supported model provider is configured", () => {
  clear();
  process.env.SOFIA_AI_GATEWAY_API_KEY = "legacy-test-key";
  assert.throws(loadModelConfigFromEnv, /Configure GEMINI_API_KEY/);
});


test("generic BASE_URL + API_KEY + MODEL config supports custom OpenAI-compatible providers", () => {
  clear();
  process.env.BASE_URL = "https://models.example/v1/";
  process.env.API_KEY = "custom-provider-secret";
  process.env.OPENAI_API_KEY = "must-not-leak-to-custom-endpoint";
  process.env.MODEL = "vendor/model-large";
  const config = loadModelConfigFromEnv();
  assert.equal(config.routes.length, 4);
  for (const route of config.routes) {
    assert.equal(config.providers[route.id]?.baseUrl, "https://models.example/v1");
    assert.equal(config.providers[route.id]?.apiKey, "custom-provider-secret");
    assert.notEqual(config.providers[route.id]?.apiKey, "must-not-leak-to-custom-endpoint");
    assert.equal(config.providers[route.id]?.model, "vendor/model-large");
  }
});

test("OpenRouter can be selected explicitly and supports per-route model overrides", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.OPENROUTER_MODEL = "vendor/default-model";
  process.env.OPENROUTER_CODING_MODEL = "vendor/coding-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(config.providers.fast?.model, "vendor/default-model");
  assert.equal(config.providers.coding?.model, "vendor/coding-model");
});

test("explicit OpenAI provider uses OpenAI defaults and rejects insecure remote URLs", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "openai-test-key";
  process.env.OPENAI_MODEL = "gpt-test-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "https://api.openai.com/v1");
  assert.equal(config.providers.fast?.model, "gpt-test-model");

  process.env.OPENAI_BASE_URL = "http://models.example/v1";
  assert.throws(loadModelConfigFromEnv, /must use HTTPS/);
});

test("custom provider URLs reject embedded credentials, query strings, and fragments", () => {
  clear();
  process.env.SOFIA_MODEL_BASE_URL = "https://user:password@models.example/v1";
  process.env.SOFIA_MODEL_API_KEY = "custom-key";
  assert.throws(loadModelConfigFromEnv, /must not contain credentials/);
});


test("OPENAI_BASE_URL selects the OpenAI preset when no provider is explicitly selected", () => {
  clear();
  process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
  process.env.OPENAI_API_KEY = "openai-compatible-key";
  process.env.OPENAI_MODEL = "vendor/model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "https://gateway.example/v1");
  assert.equal(config.providers.fast?.apiKey, "openai-compatible-key");
  assert.equal(config.providers.fast?.model, "vendor/model");
});


test("OpenAI-compatible provider supports a loopback local model endpoint", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "openai-compatible";
  process.env.SOFIA_MODEL_BASE_URL = "http://localhost:11434/v1";
  process.env.SOFIA_MODEL_API_KEY = "local-model-key";
  process.env.SOFIA_MODEL = "llama-local";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "http://localhost:11434/v1");
  assert.equal(config.providers.fast?.apiKey, "local-model-key");
  assert.equal(config.providers.fast?.model, "llama-local");
});

test("unknown provider names fail closed", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "unknown-vendor";
  assert.throws(loadModelConfigFromEnv, /must be gemini, openai, openrouter, or openai-compatible/);
});
