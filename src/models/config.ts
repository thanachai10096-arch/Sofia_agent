import type { ModelRoute } from "./types.js";

export interface SofiaModelConfig {
  routes: ModelRoute[];
  providers: Record<string, { baseUrl: string; apiKey: string; model: string }>;
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/";

type ProviderKind = "openai-compatible" | "gemini" | "openrouter";

function selectedProvider(): ProviderKind {
  const configured = process.env.SOFIA_MODEL_PROVIDER?.trim().toLowerCase();
  if (configured === "openai-compatible" || configured === "gemini" || configured === "openrouter") {
    return configured;
  }
  if (configured) {
    throw new Error("SOFIA_MODEL_PROVIDER must be openai-compatible, gemini, or openrouter.");
  }

  // Explicit generic endpoint wins. Otherwise retain existing Gemini deployments,
  // then OpenRouter deployments, without silently switching providers after a failure.
  if (process.env.SOFIA_MODEL_BASE_URL?.trim()) return "openai-compatible";
  if (process.env.GEMINI_API_KEY?.trim() || process.env.Gemini_API_Key?.trim()) return "gemini";
  if (process.env.OPENROUTER_API_KEY?.trim()) return "openrouter";
  throw new Error(
    "Configure SOFIA_MODEL_BASE_URL, SOFIA_MODEL_API_KEY, and SOFIA_MODEL_NAME for an OpenAI-compatible provider, or set GEMINI_API_KEY with SOFIA_MODEL_PROVIDER=gemini.",
  );
}

export function loadModelConfigFromEnv(): SofiaModelConfig {
  const kind = selectedProvider();
  const baseUrl = kind === "gemini"
    ? GEMINI_BASE_URL
    : kind === "openrouter"
      ? (process.env.OPENROUTER_BASE_URL?.trim() || OPENROUTER_BASE_URL)
      : (process.env.SOFIA_MODEL_BASE_URL?.trim() || "");
  const apiKey = kind === "gemini"
    ? (process.env.GEMINI_API_KEY?.trim() || process.env.Gemini_API_Key?.trim() || "")
    : kind === "openrouter"
      ? (process.env.OPENROUTER_API_KEY?.trim() || "")
      : (process.env.SOFIA_MODEL_API_KEY?.trim() || "");
  const defaultModel = kind === "gemini"
    ? (process.env.SOFIA_MODEL_NAME?.trim() || process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash")
    : kind === "openrouter"
      ? (process.env.SOFIA_MODEL_NAME?.trim() || process.env.OPENROUTER_MODEL?.trim() || "openrouter/auto")
      : (process.env.SOFIA_MODEL_NAME?.trim() || "");

  if (!baseUrl) throw new Error("SOFIA_MODEL_BASE_URL is required for the OpenAI-compatible provider.");
  if (!apiKey) throw new Error(kind === "gemini" ? "Set GEMINI_API_KEY to use Gemini." : kind === "openrouter" ? "Set OPENROUTER_API_KEY to use OpenRouter." : "SOFIA_MODEL_API_KEY is required.");
  if (!defaultModel) throw new Error("SOFIA_MODEL_NAME is required for the selected provider.");

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "") + "/";
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
      capabilities: [...capabilities] as import("./types.js").ModelCapability[],
      costWeight: numberEnv(`SOFIA_${id.toUpperCase()}_COST`, cost),
      latencyWeight: numberEnv(`SOFIA_${id.toUpperCase()}_LATENCY`, latency),
      qualityWeight: numberEnv(`SOFIA_${id.toUpperCase()}_QUALITY`, quality),
      healthy: true,
    });
    providers[id] = { baseUrl: normalizedBaseUrl, apiKey, model };
  }
  return { routes, providers };
}
