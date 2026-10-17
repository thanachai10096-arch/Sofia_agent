import type { ModelRoute } from "./types.js";

export interface SofiaModelConfig {
  routes: ModelRoute[];
  providers: Record<string, { baseUrl: string; apiKey: string; model: string }>;
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export function loadModelConfigFromEnv(): SofiaModelConfig {
  // Prefer Gemini when configured. Keep legacy gateway support for backward compatibility.
  const geminiKey =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.Gemini_API_Key?.trim() ||
    "";
  const legacyApiKey =
    process.env.SOFIA_AI_GATEWAY_API_KEY?.trim() ||
    process.env.AI_GATEWAY_API_KEY?.trim() ||
    "";
  const useGemini = geminiKey.length > 0;
  const apiKey = useGemini ? geminiKey : legacyApiKey;
  const baseUrl = useGemini
    ? (process.env.GEMINI_API_BASE_URL?.trim() ||
       "https://generativelanguage.googleapis.com/v1beta/openai")
    : (process.env.SOFIA_AI_GATEWAY_URL?.trim() ||
       "https://ai-gateway.vercel.sh/v1");

  if (!apiKey) {
    throw new Error(
      "Set GEMINI_API_KEY to use Gemini, or SOFIA_AI_GATEWAY_API_KEY for the legacy gateway.",
    );
  }

  const geminiModel =
    process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  const definitions = [
    ["fast", ["fast"], 1, 1, 5],
    ["coding", ["coding", "tool-use", "reasoning"], 2, 2, 8],
    ["reasoning", ["reasoning", "long-context"], 3, 3, 9],
    ["vision", ["vision", "reasoning"], 3, 3, 8],
  ] as const;

  const routes: ModelRoute[] = [];
  const providers: SofiaModelConfig["providers"] = {};

  for (const [id, capabilities, cost, latency, quality] of definitions) {
    const configuredModel = process.env[`SOFIA_${id.toUpperCase()}_MODEL`]?.trim();
    const model = useGemini
      ? (process.env[`GEMINI_${id.toUpperCase()}_MODEL`]?.trim() || geminiModel)
      : configuredModel;

    if (!model) continue;

    routes.push({
      id,
      providerId: id,
      capabilities: [...capabilities] as import("./types.js").ModelCapability[],
      costWeight: numberEnv(`SOFIA_${id.toUpperCase()}_COST`, cost),
      latencyWeight: numberEnv(`SOFIA_${id.toUpperCase()}_LATENCY`, latency),
      qualityWeight: numberEnv(`SOFIA_${id.toUpperCase()}_QUALITY`, quality),
      healthy: true,
    });
    providers[id] = { baseUrl, apiKey, model };
  }

  if (!routes.length) {
    throw new Error(
      useGemini
        ? "Gemini is configured, but no Gemini model route could be created."
        : "Configure at least one SOFIA_*_MODEL environment variable.",
    );
  }

  return { routes, providers };
}
