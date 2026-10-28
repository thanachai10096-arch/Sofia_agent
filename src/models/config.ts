import type { ModelCapability, ModelRoute } from "./types.js";

export interface SofiaModelConfig {
  routes: ModelRoute[];
  providers: Record<string, { baseUrl: string; apiKey: string; model: string }>;
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

type ProviderPreset = {
  baseUrl: string;
  apiKeyEnv?: string;
  defaultModel: string;
  requiresApiKey: boolean;
};

const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
    requiresApiKey: true,
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4.1-mini",
    requiresApiKey: true,
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultModel: "openai/gpt-4.1-mini",
    requiresApiKey: true,
  },
  xai: { baseUrl: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY", defaultModel: "", requiresApiKey: true },
  mistral: { baseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY", defaultModel: "", requiresApiKey: true },
  groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY", defaultModel: "", requiresApiKey: true },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY", defaultModel: "", requiresApiKey: true },
  together: { baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY", defaultModel: "", requiresApiKey: true },
  fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", apiKeyEnv: "FIREWORKS_API_KEY", defaultModel: "", requiresApiKey: true },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", apiKeyEnv: "CEREBRAS_API_KEY", defaultModel: "", requiresApiKey: true },
  perplexity: { baseUrl: "https://api.perplexity.ai", apiKeyEnv: "PERPLEXITY_API_KEY", defaultModel: "", requiresApiKey: true },
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", defaultModel: "llama3.2", requiresApiKey: false },
  "openai-compatible": { baseUrl: "", defaultModel: "", requiresApiKey: false },
};

function selectedProvider(): string {
  const configured = process.env.SOFIA_MODEL_PROVIDER?.trim().toLowerCase();
  if (configured) return configured;
  // Preserve existing environment-only deployments while making provider choice explicit
  // whenever SOFIA_MODEL_PROVIDER is supplied.
  if (process.env.SOFIA_MODEL_BASE_URL?.trim()) return "openai-compatible";
  if (process.env.GEMINI_API_KEY?.trim() || process.env.Gemini_API_Key?.trim()) return "gemini";
  if (process.env.OPENROUTER_API_KEY?.trim()) return "openrouter";
  throw new Error("Set SOFIA_MODEL_PROVIDER and the matching provider credentials to configure Sofia's model.");
}

function validateBaseUrl(raw: string, provider: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SOFIA_MODEL_BASE_URL must be a valid absolute URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("SOFIA_MODEL_BASE_URL must not contain credentials, query parameters, or fragments.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("SOFIA_MODEL_BASE_URL must use HTTPS; HTTP is allowed only for loopback model servers.");
  }
  const preset = PROVIDER_PRESETS[provider];
  if (provider !== "openai-compatible" && preset?.baseUrl) {
    const expectedOrigin = new URL(preset.baseUrl).origin;
    if (url.origin !== expectedOrigin) {
      throw new Error(
        `SOFIA_MODEL_BASE_URL for provider "${provider}" must use ${expectedOrigin}; select openai-compatible for a custom endpoint.`,
      );
    }
  }
  return url.toString().replace(/\/+$/, "");
}

export function loadModelConfigFromEnv(): SofiaModelConfig {
  const kind = selectedProvider();
  const preset = PROVIDER_PRESETS[kind];
  if (!preset) {
    throw new Error(
      "Unsupported SOFIA_MODEL_PROVIDER. Supported OpenAI-compatible adapters: gemini, openai, openrouter, xai, mistral, groq, deepseek, together, fireworks, cerebras, perplexity, ollama, openai-compatible.",
    );
  }

  const legacyGeminiKey = process.env.GEMINI_API_KEY?.trim() || process.env.Gemini_API_Key?.trim() || "";
  const apiKey = process.env.SOFIA_MODEL_API_KEY?.trim() ||
    (kind === "gemini" ? legacyGeminiKey : "") ||
    (preset.apiKeyEnv ? process.env[preset.apiKeyEnv]?.trim() : "") || "";
  const configuredBaseUrl = process.env.SOFIA_MODEL_BASE_URL?.trim();
  const legacyOpenRouterBaseUrl = kind === "openrouter" ? process.env.OPENROUTER_BASE_URL?.trim() : "";\n  const rawBaseUrl = configuredBaseUrl || legacyOpenRouterBaseUrl || preset.baseUrl;
  if (!rawBaseUrl) throw new Error("Set SOFIA_MODEL_BASE_URL for the openai-compatible provider.");
  const baseUrl = validateBaseUrl(rawBaseUrl, kind);

  if (preset.requiresApiKey && !apiKey) {
    throw new Error(kind === "gemini"
      ? "Set GEMINI_API_KEY (or the existing Gemini_API_Key variable) to use Sofia."
      : `Set SOFIA_MODEL_API_KEY or ${preset.apiKeyEnv ?? "the provider API key"} to use Sofia.`);
  }

  const defaultModel = process.env.SOFIA_MODEL_NAME?.trim() ||
    (kind === "gemini" ? process.env.GEMINI_MODEL?.trim() : "") ||
    (kind === "openrouter" ? process.env.OPENROUTER_MODEL?.trim() : "") ||
    preset.defaultModel;
  if (!defaultModel) throw new Error("Set SOFIA_MODEL_NAME to the model identifier provided by your endpoint.");

  const definitions = [
    ["fast", ["fast"], 1, 1, 5],
    ["coding", ["coding", "tool-use", "reasoning"], 2, 2, 8],
    ["reasoning", ["reasoning", "long-context"], 3, 3, 9],
    ["vision", ["vision", "reasoning"], 3, 3, 8],
  ] as const;

  const routes: ModelRoute[] = [];
  const providers: SofiaModelConfig["providers"] = {};
  for (const [id, capabilities, cost, latency, quality] of definitions) {
    const routeOverride = process.env[`SOFIA_${id.toUpperCase()}_MODEL`]?.trim();
    const legacyGeminiOverride = kind === "gemini" ? process.env[`GEMINI_${id.toUpperCase()}_MODEL`]?.trim() : "";
    const legacyOpenRouterOverride = kind === "openrouter" ? process.env[`OPENROUTER_${id.toUpperCase()}_MODEL`]?.trim() : "";
    const model = routeOverride || legacyGeminiOverride || legacyOpenRouterOverride || defaultModel;

    routes.push({
      id,
      providerId: id,
      capabilities: [...capabilities] as ModelCapability[],
      costWeight: numberEnv(`SOFIA_${id.toUpperCase()}_COST`, cost),
      latencyWeight: numberEnv(`SOFIA_${id.toUpperCase()}_LATENCY`, latency),
      qualityWeight: numberEnv(`SOFIA_${id.toUpperCase()}_QUALITY`, quality),
      healthy: true,
    });
    providers[id] = { baseUrl, apiKey, model };
  }
  return { routes, providers };
}
