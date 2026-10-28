import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadModelConfigFromEnv } from "./config.js";

const names = [
  "OPENROUTER_API_KEY", "OPENROUTER", "OPENROUTER_MODEL",
  "OPENROUTER_FAST_MODEL", "OPENROUTER_CODING_MODEL",
  "OPENROUTER_REASONING_MODEL", "OPENROUTER_VISION_MODEL",
  "GEMINI_API_KEY", "Gemini_API_Key", "GEMINI_MODEL",
  "GEMINI_FAST_MODEL", "GEMINI_CODING_MODEL",
  "GEMINI_REASONING_MODEL", "GEMINI_VISION_MODEL",
  "SOFIA_AI_GATEWAY_API_KEY", "AI_GATEWAY_API_KEY", "SOFIA_AI_GATEWAY_URL",
  "SOFIA_FAST_MODEL", "SOFIA_CODING_MODEL", "SOFIA_REASONING_MODEL", "SOFIA_VISION_MODEL",
  "SOFIA_PROVIDER_IDS",
  "SOFIA_PROVIDER_PRIMARY_BASE_URL", "SOFIA_PROVIDER_PRIMARY_API_KEY", "SOFIA_PROVIDER_PRIMARY_MODEL",
  "SOFIA_PROVIDER_SECONDARY_BASE_URL", "SOFIA_PROVIDER_SECONDARY_API_KEY", "SOFIA_PROVIDER_SECONDARY_MODEL",
  "SOFIA_FAST_PROVIDER", "SOFIA_CODING_PROVIDER",
];

const original = new Map(names.map((name) => [name, process.env[name]]));
function clear() { for (const name of names) delete process.env[name]; }
afterEach(() => {
  clear();
  for (const [name, value] of original) if (value !== undefined) process.env[name] = value;
});

test("legacy Gemini environment configuration remains backward compatible", () => {
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

test("explicit provider configuration supports custom OpenAI-compatible endpoints without Gemini", () => {
  clear();
  process.env.SOFIA_PROVIDER_IDS = "primary";
  process.env.SOFIA_PROVIDER_PRIMARY_BASE_URL = "https://api.example.test/v1";
  process.env.SOFIA_PROVIDER_PRIMARY_API_KEY = "explicit-test-key";
  process.env.SOFIA_PROVIDER_PRIMARY_MODEL = "example-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.routes.length, 4);
  assert.equal(config.routes[0]?.providerId, "primary");
  assert.equal(config.providers.primary?.baseUrl, "https://api.example.test/v1");
  assert.equal(config.providers.primary?.apiKey, "explicit-test-key");
  assert.equal(config.providers.primary?.model, "example-model");
});

test("routes can explicitly select different configured providers and models", () => {
  clear();
  process.env.SOFIA_PROVIDER_IDS = "primary,secondary";
  process.env.SOFIA_PROVIDER_PRIMARY_BASE_URL = "https://one.example.test/v1";
  process.env.SOFIA_PROVIDER_PRIMARY_API_KEY = "primary-key";
  process.env.SOFIA_PROVIDER_PRIMARY_MODEL = "primary-model";
  process.env.SOFIA_PROVIDER_SECONDARY_BASE_URL = "https://two.example.test/v1";
  process.env.SOFIA_PROVIDER_SECONDARY_API_KEY = "secondary-key";
  process.env.SOFIA_PROVIDER_SECONDARY_MODEL = "secondary-model";
  process.env.SOFIA_CODING_PROVIDER = "secondary";
  process.env.SOFIA_CODING_MODEL = "coding-model";
  const config = loadModelConfigFromEnv();
  assert.equal(config.routes.find((route) => route.id === "fast")?.providerId, "primary");
  const coding = config.routes.find((route) => route.id === "coding");
  assert.equal(coding?.providerId, "secondary-coding");
  assert.equal(config.providers["secondary-coding"]?.model, "coding-model");
  assert.equal(config.providers.secondary?.model, "secondary-model");
});

test("explicit provider configuration fails closed on missing credentials and unknown route provider", () => {
  clear();
  process.env.SOFIA_PROVIDER_IDS = "primary";
  process.env.SOFIA_PROVIDER_PRIMARY_BASE_URL = "https://one.example.test/v1";
  process.env.SOFIA_PROVIDER_PRIMARY_MODEL = "primary-model";
  assert.throws(loadModelConfigFromEnv, /requires SOFIA_PROVIDER_PRIMARY_BASE_URL/);
  process.env.SOFIA_PROVIDER_PRIMARY_API_KEY = "primary-key";
  process.env.SOFIA_FAST_PROVIDER = "not-configured";
  assert.throws(loadModelConfigFromEnv, /unconfigured provider/);
});

test("provider IDs must be unique and URL must be valid", () => {
  clear();
  process.env.SOFIA_PROVIDER_IDS = "primary,primary";
  assert.throws(loadModelConfigFromEnv, /unique provider IDs/);
  process.env.SOFIA_PROVIDER_IDS = "primary";
  process.env.SOFIA_PROVIDER_PRIMARY_BASE_URL = "not-a-url";
  process.env.SOFIA_PROVIDER_PRIMARY_API_KEY = "key";
  process.env.SOFIA_PROVIDER_PRIMARY_MODEL = "model";
  assert.throws(loadModelConfigFromEnv, /Invalid base URL/);
});

test("does not use legacy credentials when explicit provider configuration is incomplete", () => {
  clear();
  process.env.SOFIA_PROVIDER_IDS = "primary";
  process.env.GEMINI_API_KEY = "gemini-should-not-be-fallback";
  assert.throws(loadModelConfigFromEnv, /requires SOFIA_PROVIDER_PRIMARY_BASE_URL/);
});

test("fails closed when neither explicit providers nor legacy Gemini credentials are configured", () => {
  clear();
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.SOFIA_AI_GATEWAY_API_KEY = "legacy-test-key";
  assert.throws(loadModelConfigFromEnv, /SOFIA_PROVIDER_IDS/);
});
