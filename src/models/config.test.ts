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
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_FAST_MODEL",
  "ANTHROPIC_CODING_MODEL",
  "ANTHROPIC_REASONING_MODEL",
  "ANTHROPIC_VISION_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "OPENAI_FAST_MODEL",
  "OPENAI_CODING_MODEL",
  "OPENAI_REASONING_MODEL",
  "OPENAI_VISION_MODEL",
  "SOFIA_MODEL_PROTOCOL",
  "SOFIA_MODEL_PROVIDER",
  "SOFIA_FAST_PROVIDER",
  "SOFIA_CODING_PROVIDER",
  "SOFIA_REASONING_PROVIDER",
  "SOFIA_VISION_PROVIDER",
  "SOFIA_BASE_URL",
  "SOFIA_API_KEY",
  "SOFIA_MODEL_API_KEY",
  "SOFIA_PROVIDER_API_KEY",
  "SOFIA_MODEL",
  "BASE_URL",
  "API_KEY",
  "MODEL",
  "SOFIA_FAST_MODEL",
  "SOFIA_CODING_MODEL",
  "SOFIA_REASONING_MODEL",
  "SOFIA_VISION_MODEL",
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

test("model routes can use different configured providers in the same Sofia runtime", () => {
  clear();
  process.env.OPENROUTER_API_KEY = "openrouter-provider-key";
  process.env.GEMINI_API_KEY = "gemini-provider-key";
  process.env.ANTHROPIC_API_KEY = "anthropic-provider-key";
  process.env.ANTHROPIC_MODEL = "claude-default";
  process.env.SOFIA_BASE_URL = "https://local-model.example.test/v1";
  process.env.SOFIA_MODEL_API_KEY = "local-provider-key";
  process.env.SOFIA_MODEL = "local-default";
  process.env.SOFIA_FAST_PROVIDER = "openrouter";
  process.env.SOFIA_CODING_PROVIDER = "anthropic";
  process.env.SOFIA_REASONING_PROVIDER = "gemini";
  process.env.SOFIA_VISION_PROVIDER = "custom";
  process.env.OPENROUTER_FAST_MODEL = "openrouter/fast";
  process.env.ANTHROPIC_CODING_MODEL = "claude-code";
  process.env.GEMINI_REASONING_MODEL = "gemini-reason";
  process.env.SOFIA_VISION_MODEL = "local-vision";

  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(config.providers.fast?.apiKey, "openrouter-provider-key");
  assert.equal(config.providers.fast?.model, "openrouter/fast");
  assert.equal(config.providers.coding?.baseUrl, "https://api.anthropic.com/v1");
  assert.equal(config.providers.coding?.protocol, "anthropic-messages");
  assert.equal(config.providers.coding?.model, "claude-code");
  assert.equal(config.providers.reasoning?.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(config.providers.reasoning?.apiKey, "gemini-provider-key");
  assert.equal(config.providers.reasoning?.model, "gemini-reason");
  assert.equal(config.providers.vision?.baseUrl, "https://local-model.example.test/v1");
  assert.equal(config.providers.vision?.apiKey, "local-provider-key");
  assert.equal(config.providers.vision?.model, "local-vision");
});

test("partial route provider overrides still require an unambiguous global fallback", () => {
  clear();
  process.env.OPENROUTER_API_KEY = "openrouter-provider-key";
  process.env.GEMINI_API_KEY = "gemini-provider-key";
  process.env.SOFIA_FAST_PROVIDER = "openrouter";
  assert.throws(loadModelConfigFromEnv, /set SOFIA_MODEL_PROVIDER to choose explicitly/);
});

test("OpenAI provider uses its native OpenAI-compatible endpoint and explicit model", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "openai-provider-key";
  process.env.OPENAI_MODEL = "gpt-test-model";
  process.env.OPENAI_BASE_URL = "https://api.openai.com/v1/";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "https://api.openai.com/v1");
  assert.equal(config.providers.fast?.apiKey, "openai-provider-key");
  assert.equal(config.providers.fast?.model, "gpt-test-model");
  assert.equal(config.providers.fast?.protocol, "openai-compatible");
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

test("Sofia API authentication key does not accidentally select a custom model provider", () => {
  clear();
  process.env.SOFIA_API_KEY = "sofia-client-api-key";
  process.env.OPENROUTER_API_KEY = "openrouter-provider-key";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.apiKey, "openrouter-provider-key");
  assert.equal(config.providers.fast?.baseUrl, "https://openrouter.ai/api/v1");
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

test("openai-compatible is accepted as an explicit provider alias", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "openai-compatible";
  process.env.SOFIA_BASE_URL = "https://llm.example.test/v1";
  process.env.SOFIA_MODEL_API_KEY = "provider-key";
  process.env.SOFIA_MODEL = "vendor/model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "https://llm.example.test/v1");
  assert.equal(config.providers.fast?.apiKey, "provider-key");
  assert.equal(config.providers.fast?.model, "vendor/model");
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

test("dedicated model provider key takes precedence over Sofia API key", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "custom";
  process.env.SOFIA_BASE_URL = "https://llm.example.test/v1";
  process.env.SOFIA_API_KEY = "sofia-client-api-key";
  process.env.SOFIA_MODEL_API_KEY = "external-provider-key";
  process.env.SOFIA_MODEL = "vendor/model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.apiKey, "external-provider-key");
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
  assert.throws(loadModelConfigFromEnv, /requires SOFIA_BASE_URL, SOFIA_MODEL_API_KEY, and SOFIA_MODEL/);
});

test("fails with actionable guidance when no supported provider is configured", () => {
  clear();
  process.env.SOFIA_AI_GATEWAY_API_KEY = "legacy-test-key";
  process.env.AI_GATEWAY_API_KEY = "legacy-test-key";
  assert.throws(loadModelConfigFromEnv, /Configure SOFIA_BASE_URL, SOFIA_MODEL_API_KEY, and SOFIA_MODEL/);
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


test("Anthropic provider uses the native Messages protocol and route-specific model IDs", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
  process.env.ANTHROPIC_MODEL = "claude-test-model";
  process.env.ANTHROPIC_CODING_MODEL = "claude-coding-test-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "https://api.anthropic.com/v1");
  assert.equal(config.providers.fast?.apiKey, "anthropic-test-key");
  assert.equal(config.providers.fast?.model, "claude-test-model");
  assert.equal(config.providers.fast?.protocol, "anthropic-messages");
  assert.equal(config.providers.coding?.model, "claude-coding-test-model");
});

test("custom endpoints can opt into the Anthropic Messages protocol", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "custom";
  process.env.SOFIA_MODEL_PROTOCOL = "anthropic-messages";
  process.env.SOFIA_BASE_URL = "https://anthropic-proxy.example.test/v1";
  process.env.SOFIA_API_KEY = "proxy-key";
  process.env.SOFIA_MODEL = "claude-proxy-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.protocol, "anthropic-messages");
  assert.equal(config.providers.fast?.baseUrl, "https://anthropic-proxy.example.test/v1");
});
