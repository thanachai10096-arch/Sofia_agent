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
  // Legacy credentials must not influence provider selection.
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

test("OpenRouter key selects only OpenRouter and defaults to its auto router", () => {
  clear();
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  const config = loadModelConfigFromEnv();
  assert.equal(config.routes.length, 4);
  for (const route of config.routes) {
    const provider = config.providers[route.id];
    assert.equal(provider?.baseUrl, "https://openrouter.ai/api/v1");
    assert.equal(provider?.apiKey, "openrouter-test-key");
    assert.equal(provider?.model, "openrouter/auto");
  }
});

test("existing OPENROUTER deployment secret remains supported", () => {
  clear();
  process.env.OPENROUTER = "openrouter-existing-test-key";
  process.env.OPENROUTER_MODEL = "openai/gpt-4.1-mini";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.apiKey, "openrouter-existing-test-key");
  assert.equal(config.providers.fast?.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(config.providers.fast?.model, "openai/gpt-4.1-mini");
});

test("OpenRouter route-specific model overrides the shared OpenRouter model", () => {
  clear();
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.OPENROUTER_MODEL = "openai/gpt-4.1-mini";
  process.env.OPENROUTER_CODING_MODEL = "anthropic/claude-sonnet-4";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.model, "openai/gpt-4.1-mini");
  assert.equal(config.providers.coding?.model, "anthropic/claude-sonnet-4");
  assert.equal(config.providers.reasoning?.model, "openai/gpt-4.1-mini");
});

test("legacy Gemini and AI Gateway credentials cannot override OpenRouter", () => {
  clear();
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.GEMINI_MODEL = "gemini-test-model";
  process.env.SOFIA_AI_GATEWAY_API_KEY = "legacy-test-key";
  process.env.SOFIA_FAST_MODEL = "legacy-fast-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.apiKey, "openrouter-test-key");
  assert.equal(config.providers.fast?.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(config.providers.fast?.model, "openrouter/auto");
});

test("fails closed when no OpenRouter API key is configured", () => {
  clear();
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.SOFIA_AI_GATEWAY_API_KEY = "legacy-test-key";
  assert.throws(loadModelConfigFromEnv, /OPENROUTER_API_KEY/);
});
