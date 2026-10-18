import type { ModelRoute } from "./types.js";

export interface SofiaModelConfig {
  routes: ModelRoute[];
  providers: Record<string, { baseUrl: string; apiKey: string; model: string; fallbackModel?: string }>;
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

export function loadModelConfigFromEnv(): SofiaModelConfig {
  // OpenRouter remains the default. Gemini is opt-in for temporary deployments;
  // credentials and endpoints are never mixed between providers.
  const selectedProvider = process.env.SOFIA_MODEL_PROVIDER?.trim().toLowerCase() || "openrouter";
  if (selectedProvider !== "openrouter" && selectedProvider !== "gemini") {
    throw new Error("SOFIA_MODEL_PROVIDER must be either openrouter or gemini.");
  }

  const isGemini = selectedProvider === "gemini";
  const apiKey = isGemini
    ? process.env.GEMINI_API_KEY?.trim() || process.env.Gemini_API_Key?.trim() || ""
    : process.env.OPENROUTER_API_KEY?.trim() || process.env.OPENROUTER?.trim() || "";
  if (!apiKey) {
    throw new Error(isGemini
      ? "Set GEMINI_API_KEY (or the existing Gemini_API_Key variable) to use Gemini."
      : "Set OPENROUTER_API_KEY (or the OpenRouter-only OPENROUTER variable) to use Sofia.");
  }

  const baseUrl = isGemini ? GEMINI_BASE_URL : OPENROUTER_BASE_URL;
  const defaultModel = isGemini
    ? process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash"
    : process.env.OPENROUTER_MODEL?.trim() || "openrouter/auto";
  const definitions = [
    ["fast", ["fast"], 1, 1, 5],
    ["coding", ["coding", "tool-use", "reasoning"], 2, 2, 8],
    ["reasoning", ["reasoning", "long-context"], 3, 3, 9],
    ["vision", ["vision", "reasoning"], 3, 3, 8],
  ] as const;

  const routes: ModelRoute[] = [];
  const providers: SofiaModelConfig["providers"] = {};

  for (const [id, capabilities, cost, latency, quality] of definitions) {
    const model = isGemini
      ? process.env["GEMINI_" + id.toUpperCase() + "_MODEL"]?.trim() ||
        process.env["SOFIA_" + id.toUpperCase() + "_MODEL"]?.trim() ||
        defaultModel
      : process.env["OPENROUTER_" + id.toUpperCase() + "_MODEL"]?.trim() ||
        process.env[`SOFIA_${id.toUpperCase()}_MODEL]?.trim() ||
        defaultModel;

    routes.push({
      id,
      providerId: id,
      capabilities: [...capabilities] as import("./types.js").ModelCapability[],
      costWeight: numberEnv(`SOFIA_${id.toUpperCase()}_COST`, cost),
      latencyWeight: numberEnv(`SOFIA_${id.toUpperCase()}_LATENCY`, latency),
      qualityWeight: numberEnv(`SOFIA_${id.toUpperCase()}_QUALITY`, quality),
      healthy: true,
    });
    providers[id] = {
      baseUrl,
      apiKey,
      model,
      ...(!isGemini && model !== "openrouter/auto" ? { fallbackModel: "openrouter/auto" } : {}),
    };
  }

  return { routes, providers };
}
