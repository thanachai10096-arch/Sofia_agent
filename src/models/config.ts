import type { ModelRoute } from "./types.js";

export interface SofiaModelConfig {
  routes: ModelRoute[];
  providers: Record<string, { baseUrl: string; apiKey: string; model: string }>;
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function loadModelConfigFromEnv(): SofiaModelConfig {
  // OpenRouter is the only supported provider. Deliberately do not fall back to
  // Gemini, Vercel AI Gateway, or any other endpoint when configuration fails.
  const apiKey = process.env.OPENROUTER_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error("Set OPENROUTER_API_KEY to use Sofia's OpenRouter model provider.");
  }

  const defaultModel = process.env.OPENROUTER_MODEL?.trim() || "openrouter/auto";
  const definitions = [
    ["fast", ["fast"], 1, 1, 5],
    ["coding", ["coding", "tool-use", "reasoning"], 2, 2, 8],
    ["reasoning", ["reasoning", "long-context"], 3, 3, 9],
    ["vision", ["vision", "reasoning"], 3, 3, 8],
  ] as const;

  const routes: ModelRoute[] = [];
  const providers: SofiaModelConfig["providers"] = {};

  for (const [id, capabilities, cost, latency, quality] of definitions) {
    const model = process.env[`OPENROUTER_${id.toUpperCase()}_MODEL`]?.trim() || defaultModel;

    routes.push({
      id,
      providerId: id,
      capabilities: [...capabilities] as import("./types.js").ModelCapability[],
      costWeight: numberEnv(`SOFIA_${id.toUpperCase()}_COST`, cost),
      latencyWeight: numberEnv(`SOFIA_${id.toUpperCase()}_LATENCY`, latency),
      qualityWeight: numberEnv(`SOFIA_${id.toUpperCase()}_QUALITY`, quality),
      healthy: true,
    });
    providers[id] = { baseUrl: OPENROUTER_BASE_URL, apiKey, model };
  }

  return { routes, providers };
}
