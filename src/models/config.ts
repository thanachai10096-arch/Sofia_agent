import type { ModelRoute } from "./types.js";

export interface SofiaModelProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol?: "openai-compatible" | "anthropic-messages";
}

export interface SofiaModelConfig {
  routes: ModelRoute[];
  providers: Record<string, SofiaModelProviderConfig>;
}

interface ProviderSelection {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  routeModelPrefix: "OPENROUTER" | "GEMINI" | "ANTHROPIC" | "SOFIA";
  protocol: "openai-compatible" | "anthropic-messages";
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

function optionalBooleanEnv(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error(name + " must be true or false.");
}

function optionalPositiveIntegerEnv(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(name + " must be a positive safe integer.");
  }
  return parsed;
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
  const anthropicKey = firstEnv("ANTHROPIC_API_KEY");

  if (requested && !["openrouter", "gemini", "anthropic", "custom", "openai-compatible"].includes(requested)) {
    throw new Error("SOFIA_MODEL_PROVIDER must be openrouter, gemini, anthropic, or custom.");
  }

  const chooseCustom = (): ProviderSelection => {
    if (!customBaseUrl || !customApiKey || !customModel) {
      throw new Error("Custom model configuration requires SOFIA_BASE_URL, SOFIA_API_KEY, and SOFIA_MODEL (or BASE_URL, API_KEY, and MODEL).");
    }
    const protocol = firstEnv("SOFIA_MODEL_PROTOCOL") || "openai-compatible";
    if (protocol !== "openai-compatible" && protocol !== "anthropic-messages") {
      throw new Error("SOFIA_MODEL_PROTOCOL must be openai-compatible or anthropic-messages.");
    }
    return {
      baseUrl: normalizeBaseUrl(customBaseUrl),
      apiKey: customApiKey,
      defaultModel: customModel,
      routeModelPrefix: "SOFIA",
      protocol,
    };
  };

  const chooseOpenRouter = (): ProviderSelection => {
    if (!openRouterKey) throw new Error("SOFIA_MODEL_PROVIDER=openrouter requires OPENROUTER_API_KEY.");
    return {
      baseUrl: normalizeBaseUrl(firstEnv("OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1"),
      apiKey: openRouterKey,
      defaultModel: firstEnv("OPENROUTER_MODEL") || "openrouter/auto",
      routeModelPrefix: "OPENROUTER",
      protocol: "openai-compatible",
    };
  };

  const chooseGemini = (): ProviderSelection => {
    if (!geminiKey) throw new Error("SOFIA_MODEL_PROVIDER=gemini requires GEMINI_API_KEY or Gemini_API_Key.");
    return {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: geminiKey,
      defaultModel: firstEnv("GEMINI_MODEL") || "gemini-2.5-flash",
      routeModelPrefix: "GEMINI",
      protocol: "openai-compatible",
    };
  };


  const chooseAnthropic = (): ProviderSelection => {
    if (!anthropicKey) throw new Error("SOFIA_MODEL_PROVIDER=anthropic requires ANTHROPIC_API_KEY.");
    const model = firstEnv("ANTHROPIC_MODEL");
    if (!model) throw new Error("SOFIA_MODEL_PROVIDER=anthropic requires ANTHROPIC_MODEL.");
    return {
      baseUrl: normalizeBaseUrl(firstEnv("ANTHROPIC_BASE_URL") || "https://api.anthropic.com/v1"),
      apiKey: anthropicKey,
      defaultModel: model,
      routeModelPrefix: "ANTHROPIC",
      protocol: "anthropic-messages",
    };
  };

  if (requested === "custom" || requested === "openai-compatible") return chooseCustom();
  if (requested === "openrouter") return chooseOpenRouter();
  if (requested === "gemini") return chooseGemini();
  if (requested === "anthropic") return chooseAnthropic();

  // A complete custom tuple is an explicit provider choice. If multiple
  // built-in providers are configured, require an explicit selection so adding
  // a second credential cannot silently redirect prompts to another vendor.
  if (hasCustomConfig) return chooseCustom();
  const configuredBuiltIns = [openRouterKey, geminiKey, anthropicKey].filter(Boolean).length;
  if (configuredBuiltIns > 1) {
    throw new Error("Multiple built-in provider credentials are configured; set SOFIA_MODEL_PROVIDER to choose explicitly.");
  }
  if (openRouterKey) return chooseOpenRouter();
  if (geminiKey) return chooseGemini();
  if (anthropicKey) return chooseAnthropic();

  throw new Error(
    "Configure SOFIA_BASE_URL, SOFIA_API_KEY, and SOFIA_MODEL for an OpenAI-compatible endpoint, " +
    "or set OPENROUTER_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY.",
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

    const featurePrefix = "SOFIA_" + id.toUpperCase() + "_SUPPORTS_";
    const toolCalling = optionalBooleanEnv(featurePrefix + "TOOL_CALLING");
    const vision = optionalBooleanEnv(featurePrefix + "VISION");
    const structuredOutput = optionalBooleanEnv(featurePrefix + "STRUCTURED_OUTPUT");
    const contextWindow = optionalPositiveIntegerEnv("SOFIA_" + id.toUpperCase() + "_CONTEXT_WINDOW");
    const featureSupport = {
      ...(toolCalling !== undefined ? { toolCalling } : {}),
      ...(vision !== undefined ? { vision } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };

    routes.push({
      id,
      providerId: id,
      model,
      capabilities: [...capabilities] as import("./types.js").ModelCapability[],
      costWeight: numberEnv("SOFIA_" + id.toUpperCase() + "_COST", cost),
      latencyWeight: numberEnv("SOFIA_" + id.toUpperCase() + "_LATENCY", latency),
      qualityWeight: numberEnv("SOFIA_" + id.toUpperCase() + "_QUALITY", quality),
      healthy: true,
      ...(Object.keys(featureSupport).length ? { featureSupport } : {}),
    });
    providers[id] = {
      baseUrl: selected.baseUrl,
      apiKey: selected.apiKey,
      model,
      protocol: selected.protocol,
    };
  }

  return { routes, providers };
}
