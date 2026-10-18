import type { ModelRoute } from "./types.js";

export interface SofiaModelConfig {
  routes: ModelRoute[];
  providers: Record<string, { baseUrl: string; apiKey: string; model: string }>;
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

export function loadModelConfigFromEnv(): SofiaModelConfig {
  // Sofia uses Google's Gemini API through its OpenAI-compatible endpoint.
  // Support the existing deployment variable name without exposing its value.
  const apiKey =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.Gemini_API_Key?.trim() ||
    "";
  if (!apiKey) {
    throw new Error("Set GEMINI_API_KEY (or the existing Gemini_API_Key variable) to use Sofia.");
  }

  const defaultModel = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  const definitions = [
    ["fast", ["fast"], 1, 1, 5],
    ["coding", ["coding", "tool-use", "reasoning"], 2, 2, 8],
    ["reasoning", ["reasoning", "long-context"], 3, 3, 9],
    ["vision", ["vision", "reasoning"], 3, 3, 8],
  ] as const;

  const routes: ModelRoute[] = [];
  const providers: SofiaModelConfig["providers"] = {};

  for (const [id, capabilities, cost, latency, quality] of definitions) {
    const model =
      process.env[`GEMINI_${id.toUpperCase()}_MODEL`]?.trim() ||
      process.env[`GEMINI_${id.toUpperCase()}_MODEL`]?.trim() ||
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
    providers[id] = { baseUrl: GEMINI_OPENAI_BASE_URL, apiKey, model };
  }

  return { routes, providers };
}
