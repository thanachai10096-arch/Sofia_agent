import type { ModelRoute } from "./types.js";

export interface SofiaModelProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SofiaModelConfig {
  routes: ModelRoute[];
  providers: Record<string, SofiaModelProviderConfig>;
}

interface ProviderSelection {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  routeModelPrefix: "OPENROUTER" | "GEMINI" | "SOFIA";
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function firstEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Model provider base URL must be an absolute HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Model provider base URL must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Model provider base URL must not contain credentials, query parameters, or a fragment.");
  }
  const normalized = value.replace(/\/+$/, "");
  if (!normalized || normalized.endsWith("/chat/completions")) {
    throw new Error("Model provider base URL must be the API root, not the chat-completions endpoint.");
  }
  return normalized;
}

function selectProvider(): ProviderSelection {
  const requested = process.env.SOFIA_MODEL_PROVIDER?.trim().toLowerCase();
  const customBaseUrl = firstEnv("SOFIA_BASE_URL", "BASE_URL");
  const customApiKey = firstEnv("SOFIA_API_KEY", "API_KEY");
  const customModel = firstEnv("SOFIA_MODEL", "MODEL");
  const hasCustomConfig = Boolean(customBaseUrl || customApiKey || customModel);

  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim() ?? "";
  const geminiKey = firstEnv("GEMINI_API_KEY", "Gemini_API_Key");

  if (requested && !["openrouter", "gemini", "custom", "openai-compatible"].includes(requested)) {
    throw new Error("SOFIA_MODEL_PROVIDER must be openrouter, gemini, or custom.");
  }

  const chooseCustom = (): ProviderSelection => {
    if (!customBaseUrl || !customApiKey || !customModel) {
      throw new Error("Custom model configuration requires SOFIA_BASE_URL, SOFIA_API_KEY, and SOFIA_MODEL (or BASE_URL, API_KEY, and MODEL).");
    }
    return {
      baseUrl: normalizeBaseUrl(customBaseUrl),
      apiKey: customApiKey,
      defaultModel: customModel,
      routeModelPrefix: "SOFIA",
    };
  };

  const chooseOpenRouter = (): ProviderSelection => {
    if (!openRouterKey) throw new Error("SOFIA_MODEL_PROVIDER=openrouter requires OPENROUTER_API_KEY.");
    return {
      baseUrl: normalizeBaseUrl(firstEnv("OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1"),
      apiKey: openRouterKey,
      defaultModel: firstEnv("OPENROUTER_MODEL") || "openrouter/auto",
      routeModelPrefix: "OPENROUTER",
    };
  };

  const chooseGemini = (): ProviderSelection => {
    if (!geminiKey) throw new Error("SOFIA_MODEL_PROVIDER=gemini requires GEMINI_API_KEY or Gemini_API_Key.");
    return {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: geminiKey,
      defaultModel: firstEnv("GEMINI_MODEL") || "gemini-2.5-flash",
      routeModelPrefix: "GEMINI",
    };
  };

  if (requested === "custom" || requested === "openai-compatible") return chooseCustom();
  if (requested === "openrouter") return chooseOpenRouter();
  if (requested === "gemini") return chooseGemini();

  // A complete custom tuple is an explicit provider choice. If multiple
  // built-in providers are configured, require an explicit selection so adding
  // a second credential cannot silently redirect prompts to another vendor.
  if (hasCustomConfig) return chooseCustom();
  if (openRouterKey && geminiKey) {
    throw new Error("Both OpenRouter and Gemini credentials are configured; set SOFIA_MODEL_PROVIDER to choose explicitly.");
  }
  if (openRouterKey) return chooseOpenRouter();
  if (geminiKey) return chooseGemini();

  throw new Error(
    "Configure SOFIA_BASE_URL, SOFIA_API_KEY, and SOFIA_MODEL for an OpenAI-compatible endpoint, " +
    "or set OPENROUTER_API_KEY or GEMINI_API_KEY.",
  );
}

/**
 * Configure one provider explicitly, then optionally assign different models
 * to Sofia's fast, coding, reasoning, and vision routes. Custom endpoints must
 * implement the OpenAI Chat Completions-compatible API.
 */
export function loadModelConfigFromEnv(): SofiaModelConfig {
  const selected = selectProvider();
  const definitions = [
    ["fast", ["fast"], 1, 1, 5],
    ["coding", ["coding", "tool-use", "reasoning"], 2, 2, 8],
    ["reasoning", ["reasoning", "long-context"], 3, 3, 9],
    ["vision", ["vision", "reasoning"], 3, 3, 8],
  ] as const;

  const routes: ModelRoute[] = [];
  const providers: SofiaModelConfig["providers"] = {};

  for (const [id, capabilities, cost, latency, quality] of definitions) {
    const routeModelName = selected.routeModelPrefix + "_" + id.toUpperCase() + "_MODEL";
    const model = firstEnv(routeModelName) || selected.defaultModel;

    routes.push({
      id,
      providerId: id,
      capabilities: [...capabilities] as import("./types.js").ModelCapability[],
      costWeight: numberEnv("SOFIA_" + id.toUpperCase() + "_COST", cost),
      latencyWeight: numberEnv("SOFIA_" + id.toUpperCase() + "_LATENCY", latency),
      qualityWeight: numberEnv("SOFIA_" + id.toUpperCase() + "_QUALITY", quality),
      healthy: true,
    });
    providers[id] = {
      baseUrl: selected.baseUrl,
      apiKey: selected.apiKey,
      model,
    };
  }

  return { routes, providers };
}
