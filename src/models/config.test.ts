import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadModelConfigFromEnv } from "./config.js";

const names = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
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
  "SOFIA_MODEL_PROVIDER",
  "SOFIA_BASE_URL",
  "SOFIA_API_KEY",
  "SOFIA_MODEL",
  "BASE_URL",
  "API_KEY",
  "MODEL",
  "SOFIA_FAST_MODEL",
  "SOFIA_CODING_MODEL",
  "SOFIA_REASONING_MODEL",
  "SOFIA_VISION_MODEL",
  "SOFIA_ROUTE_FAST_BASE_URL",
  "SOFIA_ROUTE_FAST_API_KEY",
  "SOFIA_ROUTE_FAST_MODEL",
  "SOFIA_ROUTE_CODING_BASE_URL",
  "SOFIA_ROUTE_CODING_API_KEY",
  "SOFIA_ROUTE_CODING_MODEL",
  "SOFIA_ROUTE_REASONING_BASE_URL",
  "SOFIA_ROUTE_REASONING_API_KEY",
  "SOFIA_ROUTE_REASONING_MODEL",
  "SOFIA_ROUTE_VISION_BASE_URL",
  "SOFIA_ROUTE_VISION_API_KEY",
  "SOFIA_ROUTE_VISION_MODEL",
  "SOFIA_AI_GATEWAY_API_KEY",
  "AI_GATEWAY_API_KEY",
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

test("Gemini key selects direct Google Gemini API when no other provider is configured", () => {
  clear();
  process.env.GEMINI_API_KEY = "gemini-test-key";
  const config = loadModelConfigFromEnv();
  assert.equal(config.routes.length, 4);
  for (const route of config.routes) {
    const provider = config.providers[route.id];
    assert.equal(provider?.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
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
  assert.equal(config.providers.fast?.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
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

test("OpenRouter can be selected and route-specific model IDs are respected", () => {
  clear();
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.OPENROUTER_MODEL = "openrouter/auto";
  process.env.OPENROUTER_CODING_MODEL = "anthropic/claude-sonnet";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.apiKey, "openrouter-test-key");
  assert.equal(config.providers.fast?.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(config.providers.fast?.model, "openrouter/auto");
  assert.equal(config.providers.coding?.model, "anthropic/claude-sonnet");
});

test("explicit provider selection wins when multiple provider credentials are present", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.OPENROUTER_MODEL = "openrouter/auto";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.apiKey, "gemini-test-key");
  assert.equal(config.providers.fast?.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
});

test("custom OpenAI-compatible endpoint supports SOFIA_BASE_URL, SOFIA_API_KEY, and SOFIA_MODEL", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "custom";
  process.env.SOFIA_BASE_URL = "https://llm.example.test/v1/";
  process.env.SOFIA_API_KEY = "custom-provider-key";
  process.env.SOFIA_MODEL = "vendor/model-default";
  process.env.SOFIA_CODING_MODEL = "vendor/model-code";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "https://llm.example.test/v1");
  assert.equal(config.providers.fast?.apiKey, "custom-provider-key");
  assert.equal(config.providers.fast?.model, "vendor/model-default");
  assert.equal(config.providers.coding?.model, "vendor/model-code");
  assert.equal(config.providers.reasoning?.model, "vendor/model-default");
});

test("generic BASE_URL, API_KEY, and MODEL aliases are supported", () => {
  clear();
  process.env.BASE_URL = "http://127.0.0.1:1234/v1";
  process.env.API_KEY = "local-model-key";
  process.env.MODEL = "local/model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(config.providers.fast?.apiKey, "local-model-key");
  assert.equal(config.providers.fast?.model, "local/model");
});

test("partial custom provider configuration fails instead of silently switching providers", () => {
  clear();
  process.env.SOFIA_BASE_URL = "https://llm.example.test/v1";
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  assert.throws(loadModelConfigFromEnv, /requires SOFIA_BASE_URL, SOFIA_API_KEY, and SOFIA_MODEL/);
});

test("fails with actionable guidance when no supported provider is configured", () => {
  clear();
  process.env.SOFIA_AI_GATEWAY_API_KEY = "legacy-test-key";
  process.env.AI_GATEWAY_API_KEY = "legacy-test-key";
  assert.throws(loadModelConfigFromEnv, /Configure SOFIA_BASE_URL, SOFIA_API_KEY, and SOFIA_MODEL/);
});

test("rejects malformed or credential-bearing custom base URLs", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "custom";
  process.env.SOFIA_BASE_URL = "https://user:password@llm.example.test/v1";
  process.env.SOFIA_API_KEY = "custom-provider-key";
  process.env.SOFIA_MODEL = "vendor/model";
  assert.throws(loadModelConfigFromEnv, /must not contain credentials/);
});


test("requires explicit provider selection when OpenRouter and Gemini credentials both exist", () => {
  clear();
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.GEMINI_API_KEY = "gemini-test-key";
  assert.throws(loadModelConfigFromEnv, /set SOFIA_MODEL_PROVIDER to choose explicitly/);
});


test("a route can use an independent OpenAI-compatible provider while other routes retain the default provider", () => {
  clear();
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.GEMINI_MODEL = "gemini-default";
  process.env.SOFIA_ROUTE_FAST_BASE_URL = "https://api.openai.com/v1/";
  process.env.SOFIA_ROUTE_FAST_API_KEY = "openai-route-key";
  process.env.SOFIA_ROUTE_FAST_MODEL = "gpt-fast-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "https://api.openai.com/v1");
  assert.equal(config.providers.fast?.apiKey, "openai-route-key");
  assert.equal(config.providers.fast?.model, "gpt-fast-model");
  assert.equal(config.providers.coding?.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(config.providers.coding?.apiKey, "gemini-test-key");
  assert.equal(config.providers.coding?.model, "gemini-default");
});

test("all model routes can be configured independently without a global default provider", () => {
  clear();
  for (const route of ["FAST", "CODING", "REASONING", "VISION"]) {
    process.env[`SOFIA_ROUTE_${route}_BASE_URL`] = `https://${route.toLowerCase()}.example.test/v1`;
    process.env[`SOFIA_ROUTE_${route}_API_KEY`] = `${route.toLowerCase()}-test-key`;
    process.env[`SOFIA_ROUTE_${route}_MODEL`] = `${route.toLowerCase()}/model`;
  }
  const config = loadModelConfigFromEnv();
  assert.equal(config.routes.length, 4);
  assert.equal(config.providers.fast?.model, "fast/model");
  assert.equal(config.providers.coding?.baseUrl, "https://coding.example.test/v1");
  assert.equal(config.providers.reasoning?.apiKey, "reasoning-test-key");
  assert.equal(config.providers.vision?.model, "vision/model");
});

test("partial route-specific provider configuration fails closed", () => {
  clear();
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.SOFIA_ROUTE_FAST_BASE_URL = "https://api.openai.com/v1";
  process.env.SOFIA_ROUTE_FAST_MODEL = "gpt-fast-model";
  assert.throws(loadModelConfigFromEnv, /SOFIA_ROUTE_FAST_BASE_URL, SOFIA_ROUTE_FAST_API_KEY, and SOFIA_ROUTE_FAST_MODEL must be configured together/);
});

test("route-specific provider URLs reject embedded credentials and non-HTTP schemes", () => {
  clear();
  for (const route of ["FAST", "CODING", "REASONING", "VISION"]) {
    process.env[`SOFIA_ROUTE_${route}_BASE_URL`] = `https://${route.toLowerCase()}.example.test/v1`;
    process.env[`SOFIA_ROUTE_${route}_API_KEY`] = `${route.toLowerCase()}-test-key`;
    process.env[`SOFIA_ROUTE_${route}_MODEL`] = `${route.toLowerCase()}/model`;
  }
  process.env.SOFIA_ROUTE_FAST_BASE_URL = "https://user:password@fast.example.test/v1";
  assert.throws(loadModelConfigFromEnv, /must not contain credentials/);
  process.env.SOFIA_ROUTE_FAST_BASE_URL = "ftp://fast.example.test/v1";
  assert.throws(loadModelConfigFromEnv, /must use HTTP or HTTPS/);
});
