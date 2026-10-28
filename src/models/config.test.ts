import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadModelConfigFromEnv } from "./config.js";

const names = [
  "SOFIA_MODEL_PROVIDER", "SOFIA_MODEL_API_KEY", "SOFIA_MODEL_BASE_URL", "SOFIA_MODEL_NAME",
  "SOFIA_FAST_MODEL", "SOFIA_CODING_MODEL", "SOFIA_REASONING_MODEL", "SOFIA_VISION_MODEL",
  "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY", "DEEPSEEK_API_KEY", "TOGETHER_API_KEY", "FIREWORKS_API_KEY", "CEREBRAS_API_KEY", "PERPLEXITY_API_KEY",
  "GEMINI_API_KEY", "Gemini_API_Key", "GEMINI_MODEL",
  "GEMINI_FAST_MODEL", "GEMINI_CODING_MODEL", "GEMINI_REASONING_MODEL", "GEMINI_VISION_MODEL",
  "SOFIA_AI_GATEWAY_API_KEY", "AI_GATEWAY_API_KEY", "SOFIA_AI_GATEWAY_URL",
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

test("Gemini remains the default and existing Gemini secrets continue to work", () => {
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

test("legacy Gemini_API_Key and route-specific model overrides remain supported", () => {
  clear();
  process.env.Gemini_API_Key = "gemini-existing-test-key";
  process.env.GEMINI_MODEL = "gemini-shared-model";
  process.env.GEMINI_CODING_MODEL = "gemini-coding-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.apiKey, "gemini-existing-test-key");
  assert.equal(config.providers.fast?.model, "gemini-shared-model");
  assert.equal(config.providers.coding?.model, "gemini-coding-model");
});

test("OpenAI provider uses its own credential and model", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "openai-test-key";
  process.env.SOFIA_MODEL_NAME = "gpt-test-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "https://api.openai.com/v1");
  assert.equal(config.providers.fast?.apiKey, "openai-test-key");
  assert.equal(config.providers.fast?.model, "gpt-test-model");
});


test("Anthropic selects the native Messages API protocol", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
  process.env.SOFIA_MODEL_NAME = "claude-test-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "https://api.anthropic.com/v1");
  assert.equal(config.providers.fast?.apiKey, "anthropic-test-key");
  assert.equal(config.providers.fast?.model, "claude-test-model");
  assert.equal(config.providers.fast?.protocol, "anthropic");
});

test("OpenRouter and Ollama presets are supported without changing core routing", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  assert.equal(loadModelConfigFromEnv().providers.fast?.baseUrl, "https://openrouter.ai/api/v1");

  clear();
  process.env.SOFIA_MODEL_PROVIDER = "ollama";
  process.env.SOFIA_MODEL_NAME = "local-model";
  const local = loadModelConfigFromEnv();
  assert.equal(local.providers.fast?.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(local.providers.fast?.apiKey, "");
  assert.equal(local.providers.fast?.model, "local-model");
});

test("custom OpenAI-compatible endpoints support provider-specific credentials and route models", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "openai-compatible";
  process.env.SOFIA_MODEL_BASE_URL = "https://models.example.test/v1/";
  process.env.SOFIA_MODEL_API_KEY = "custom-test-key";
  process.env.SOFIA_MODEL_NAME = "custom-default";
  process.env.SOFIA_CODING_MODEL = "custom-coder";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "https://models.example.test/v1");
  assert.equal(config.providers.fast?.apiKey, "custom-test-key");
  assert.equal(config.providers.fast?.model, "custom-default");
  assert.equal(config.providers.coding?.model, "custom-coder");
});

test("remote HTTP endpoints, credentials in URLs, and unknown providers fail closed", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "openai-compatible";
  process.env.SOFIA_MODEL_BASE_URL = "http://models.example.test/v1";
  assert.throws(loadModelConfigFromEnv, /HTTPS/);

  process.env.SOFIA_MODEL_BASE_URL = "https://user:pass@models.example.test/v1";
  assert.throws(loadModelConfigFromEnv, /must not contain credentials/);

  process.env.SOFIA_MODEL_PROVIDER = "unknown-provider";
  assert.throws(loadModelConfigFromEnv, /Unsupported SOFIA_MODEL_PROVIDER/);
});

test("common compatible inference providers accept provider-specific credentials", () => {
  const providers = [
    ["xai", "XAI_API_KEY", "https://api.x.ai/v1"],
    ["mistral", "MISTRAL_API_KEY", "https://api.mistral.ai/v1"],
    ["groq", "GROQ_API_KEY", "https://api.groq.com/openai/v1"],
    ["deepseek", "DEEPSEEK_API_KEY", "https://api.deepseek.com/v1"],
    ["together", "TOGETHER_API_KEY", "https://api.together.xyz/v1"],
    ["fireworks", "FIREWORKS_API_KEY", "https://api.fireworks.ai/inference/v1"],
    ["cerebras", "CEREBRAS_API_KEY", "https://api.cerebras.ai/v1"],
    ["perplexity", "PERPLEXITY_API_KEY", "https://api.perplexity.ai"],
  ] as const;
  for (const [providerId, keyName, baseUrl] of providers) {
    clear();
    process.env.SOFIA_MODEL_PROVIDER = providerId;
    process.env[keyName] = "provider-test-key";
    process.env.SOFIA_MODEL_NAME = "provider-model-id";
    const config = loadModelConfigFromEnv();
    assert.equal(config.providers.fast?.baseUrl, baseUrl, providerId);
    assert.equal(config.providers.fast?.apiKey, "provider-test-key", providerId);
    assert.equal(config.providers.fast?.model, "provider-model-id", providerId);
  }
});

test("OpenAI-compatible provider requires a base URL and remote providers require a key", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "openai-compatible";
  assert.throws(loadModelConfigFromEnv, /SOFIA_MODEL_BASE_URL/);

  process.env.SOFIA_MODEL_PROVIDER = "openai";
  assert.throws(loadModelConfigFromEnv, /SOFIA_MODEL_API_KEY/);
});

test("legacy gateway credentials cannot silently override the selected provider", () => {
  clear();
  process.env.SOFIA_AI_GATEWAY_API_KEY = "legacy-test-key";
  process.env.SOFIA_MODEL_PROVIDER = "openai";
  assert.throws(loadModelConfigFromEnv, /SOFIA_MODEL_API_KEY/);
});


test("custom endpoint rejects query strings and fragments to avoid ambiguous request targets", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "openai-compatible";
  process.env.SOFIA_MODEL_API_KEY = "custom-test-key";
  process.env.SOFIA_MODEL_NAME = "custom-model";

  process.env.SOFIA_MODEL_BASE_URL = "https://models.example.test/v1?tenant=other";
  assert.throws(loadModelConfigFromEnv, /must not contain credentials, query parameters, or fragments/);

  process.env.SOFIA_MODEL_BASE_URL = "https://models.example.test/v1#fragment";
  assert.throws(loadModelConfigFromEnv, /must not contain credentials, query parameters, or fragments/);
});

test("Gemini provider cannot be redirected to a non-Google API origin", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.SOFIA_MODEL_BASE_URL = "https://generativelanguage.googleapis.com.attacker.example/v1";
  assert.throws(loadModelConfigFromEnv, /official Gemini API origin/);

  process.env.SOFIA_MODEL_BASE_URL = "https://attacker.example/gemini";
  assert.throws(loadModelConfigFromEnv, /official Gemini API origin/);
});

test("explicit provider-neutral API key takes precedence only for the selected provider", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "openai";
  process.env.SOFIA_MODEL_API_KEY = "explicit-openai-key";
  process.env.OPENAI_API_KEY = "provider-openai-key";
  process.env.GEMINI_API_KEY = "unselected-gemini-key";
  process.env.SOFIA_MODEL_NAME = "gpt-test-model";

  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.apiKey, "explicit-openai-key");
  assert.equal(config.providers.fast?.baseUrl, "https://api.openai.com/v1");
  assert.equal(config.providers.fast?.model, "gpt-test-model");
});

test("loopback Ollama is allowed but remote HTTP custom endpoints are rejected", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "ollama";
  process.env.SOFIA_MODEL_NAME = "local-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "http://127.0.0.1:11434/v1");

  process.env.SOFIA_MODEL_PROVIDER = "openai-compatible";
  process.env.SOFIA_MODEL_BASE_URL = "http://models.example.test/v1";
  process.env.SOFIA_MODEL_NAME = "remote-model";
  assert.throws(loadModelConfigFromEnv, /HTTPS/);
});
