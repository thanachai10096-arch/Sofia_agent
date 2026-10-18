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

test("fails closed when no Gemini API key is configured", () => {
  clear();
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.SOFIA_AI_GATEWAY_API_KEY = "legacy-test-key";
  assert.throws(loadModelConfigFromEnv, /GEMINI_API_KEY/);
});
