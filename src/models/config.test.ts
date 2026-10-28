import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadModelConfigFromEnv } from "./config.js";

const names = [
  "OPENROUTER_API_KEY", "OPENROUTER", "OPENROUTER_MODEL",
  "OPENROUTER_FAST_MODEL", "OPENROUTER_CODING_MODEL", "OPENROUTER_REASONING_MODEL", "OPENROUTER_VISION_MODEL",
  "GEMINI_API_KEY", "Gemini_API_Key", "GEMINI_MODEL", "GEMINI_FAST_MODEL", "GEMINI_CODING_MODEL",
  "GEMINI_REASONING_MODEL", "GEMINI_VISION_MODEL", "SOFIA_AI_GATEWAY_API_KEY", "AI_GATEWAY_API_KEY",
  "SOFIA_AI_GATEWAY_URL", "SOFIA_FAST_MODEL", "SOFIA_CODING_MODEL", "SOFIA_REASONING_MODEL",
  "SOFIA_VISION_MODEL", "SOFIA_MODEL_BASE_URL", "SOFIA_MODEL_API_KEY", "SOFIA_MODEL",
  "SOFIA_MODEL_PROVIDER",
];
const original = new Map(names.map((name) => [name, process.env[name]]));
function clear() { for (const name of names) delete process.env[name]; }
afterEach(() => {
  clear();
  for (const [name, value] of original) if (value !== undefined) process.env[name] = value;
});

test("Gemini remains the backward-compatible default", () => {
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

test("existing Gemini_API_Key and route-specific model overrides remain supported", () => {
  clear();
  process.env.Gemini_API_Key = "gemini-existing-test-key";
  process.env.GEMINI_MODEL = "gemini-shared-model";
  process.env.GEMINI_CODING_MODEL = "gemini-coding-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.apiKey, "gemini-existing-test-key");
  assert.equal(config.providers.fast?.model, "gemini-shared-model");
  assert.equal(config.providers.coding?.model, "gemini-coding-model");
});

test("any OpenAI-compatible provider can be configured explicitly", () => {
  clear();
  process.env.SOFIA_MODEL_PROVIDER = "open-ai";
  process.env.SOFIA_MODEL_BASE_URL = "https://openrouter.ai/api/v1";
  process.env.SOFIA_MODEL_API_KEY = "openrouter-test-key";
  process.env.SOFIA_MODEL = "openai/gpt-4.1-mini";
  process.env.SOFIA_CODING_MODEL = "openai/gpt-4.1";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.baseUrl, "https://openrouter.ai/api/v1/");
  assert.equal(config.providers.fast?.apiKey, "openrouter-test-key");
  assert.equal(config.providers.fast?.model, "openai/gpt-4.1-mini");
  assert.equal(config.providers.coding?.model, "openai/gpt-4.1");
});

test("generic provider configuration must be complete and never silently falls back", () => {
  clear();
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.SOFIA_MODEL_BASE_URL = "https://api.example.com/v1";
  assert.throws(loadModelConfigFromEnv, /Set all three variables together/);
});

test("generic provider URLs require HTTPS except localhost and reject embedded credentials", () => {
  clear();
  process.env.SOFIA_MODEL_BASE_URL = "http://example.com/v1";
  process.env.SOFIA_MODEL_API_KEY = "custom-test-key";
  process.env.SOFIA_MODEL = "custom-model";
  assert.throws(loadModelConfigFromEnv, /must use HTTPS/);
  process.env.SOFIA_MODEL_BASE_URL = "http://localhost:1234/v1";
  assert.equal(loadModelConfigFromEnv().providers.fast?.baseUrl, "http://localhost:1234/v1/");
  process.env.SOFIA_MODEL_BASE_URL = "https://user:pass@example.com/v1";
  assert.throws(loadModelConfigFromEnv, /must use HTTPS/);
});

test("legacy OpenRouter and gateway variables do not override the Gemini default", () => {
  clear();
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.OPENROUTER_MODEL = "openai-test-model";
  process.env.SOFIA_AI_GATEWAY_API_KEY = "legacy-test-key";
  const config = loadModelConfigFromEnv();
  assert.equal(config.providers.fast?.apiKey, "gemini-test-key");
  assert.equal(config.providers.fast?.model, "gemini-2.5-flash");
});

test("fails closed when neither generic model config nor Gemini key is configured", () => {
  clear();
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.SOFIA_AI_GATEWAY_API_KEY = "legacy-test-key";
  assert.throws(loadModelConfigFromEnv, /Configure SOFIA_MODEL_BASE_URL/);
});

test("reads local .env model settings while explicit process variables take precedence", () => {
  clear();
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-config-test-"));
  const envPath = path.join(directory, ".env");
  try {
    writeFileSync(envPath, [
      'SOFIA_MODEL_PROVIDER="local"',
      'SOFIA_MODEL_BASE_URL="http://localhost:1234/v1"',
      'SOFIA_MODEL_API_KEY="local-key-with-\\\\slash"',
      'SOFIA_MODEL="local-model"',
      "",
    ].join("\n"), { mode: 0o600 });
    const fromFile = loadModelConfigFromEnv({}, envPath);
    assert.equal(fromFile.providers.fast?.baseUrl, "http://localhost:1234/v1/");
    assert.equal(fromFile.providers.fast?.apiKey, "local-key-with-\\slash");
    assert.equal(fromFile.providers.fast?.model, "local-model");

    process.env.SOFIA_MODEL_API_KEY = "environment-key";
    const overridden = loadModelConfigFromEnv(process.env, envPath);
    assert.equal(overridden.providers.fast?.apiKey, "environment-key");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
