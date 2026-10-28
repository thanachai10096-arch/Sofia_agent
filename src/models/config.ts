import type { ModelRoute, ModelCapability } from "./types.js";

export interface SofiaModelConfig {
  routes: ModelRoute[];
  providers: Record<string, { baseUrl: string; apiKey: string; model: string }>;
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const definitions = [
  ["fast", ["fast"], 1, 1, 5],
  ["coding", ["coding", "tool-use", "reasoning"], 2, 2, 8],
  ["reasoning", ["reasoning", "long-context"], 3, 3, 9],
  ["vision", ["vision", "reasoning"], 3, 3, 8],
] as const;

function loadExplicitProviderConfig(): SofiaModelConfig | undefined {
  const rawIds = process.env.SOFIA_PROVIDER_IDS?.trim();
  if (!rawIds) return undefined;

  const ids = rawIds.split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("SOFIA_PROVIDER_IDS must contain unique provider IDs");
  }

  const providers: SofiaModelConfig["providers"] = {};
  for (const id of ids) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error("Invalid provider ID in SOFIA_PROVIDER_IDS");
    }
    const prefix = "SOFIA_PROVIDER_" + id.toUpperCase();
    const baseUrl = process.env[prefix + "_BASE_URL"]?.trim() ?? "";
    const apiKey = process.env[prefix + "_API_KEY"]?.trim() ?? "";
    const model = process.env[prefix + "_MODEL"]?.trim() ?? "";
    if (!baseUrl || !apiKey || !model) {
      throw new Error("Explicit provider " + id + " requires " + prefix + "_BASE_URL, " + prefix + "_API_KEY, and " + prefix + "_MODEL");
    }
    let parsed: URL;
    try { parsed = new URL(baseUrl); }
    catch { throw new Error("Invalid base URL for explicit provider " + id); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Provider base URL must use HTTP or HTTPS for " + id);
    }
    providers[id] = { baseUrl: baseUrl.replace(/\\/+$/, ""), apiKey, model };
  }

  const defaultProvider = ids[0]!;
  const routes: ModelRoute[] = definitions.map(([id, capabilities, cost, latency, quality]) => {
    const selectedProvider = process.env[`SOFIA_${id.toUpperCase()}_PROVIDER`]?.trim() || defaultProvider;
    if (!Object.hasOwn(providers, selectedProvider)) {
      throw new Error("Route " + id + " selects an unconfigured provider");
    }
    return {
      id,
      providerId: selectedProvider,
      capabilities: [...capabilities] as ModelCapability[],
      costWeight: numberEnv(`SOFIA_${id.toUpperCase()}_COST`, cost),
      latencyWeight: numberEnv(`SOFIA_${id.toUpperCase()}_LATENCY`, latency),
      qualityWeight: numberEnv(`SOFIA_${id.toUpperCase()}_QUALITY`, quality),
      healthy: true,
    };
  });

  // Route-specific model IDs need distinct provider entries because the gateway
  // resolves a provider config by providerId. Avoid mutating shared provider config.
  const expandedProviders = { ...providers };
  for (const route of routes) {
    const routeModel = process.env[`SOFIA_${route.id.toUpperCase()}_MODEL`]?.trim();
    if (!routeModel) continue;
    const originalId = route.providerId!;
    const distinctId = originalId + "-" + route.id;
    expandedProviders[distinctId] = { ...providers[originalId]!, model: routeModel };
    route.providerId = distinctId;
  }

  return { routes, providers: expandedProviders };
}

/**
 * Configure any explicitly selected OpenAI-compatible provider(s) with
 * SOFIA_PROVIDER_IDS and SOFIA_PROVIDER_<ID>_{BASE_URL,API_KEY,MODEL}.
 * There is deliberately no automatic cross-provider fallback.
 *
 * Existing Gemini environment variables remain supported for backward compatibility.
 */
export function loadModelConfigFromEnv(): SofiaModelConfig {
  const explicit = loadExplicitProviderConfig();
  if (explicit) return explicit;

  const apiKey =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.Gemini_API_Key?.trim() ||
    "";
  if (!apiKey) {
    throw new Error("Set SOFIA_PROVIDER_IDS with provider configuration, or GEMINI_API_KEY for legacy Gemini configuration.");
  }

  const defaultModel = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  const routes: ModelRoute[] = [];
  const providers: SofiaModelConfig["providers"] = {};

  for (const [id, capabilities, cost, latency, quality] of definitions) {
    const model = process.env[`GEMINI_${id.toUpperCase()}_MODEL`]?.trim() || defaultModel;
    routes.push({
      id,
      providerId: id,
      capabilities: [...capabilities] as ModelCapability[],
      costWeight: numberEnv(`SOFIA_${id.toUpperCase()}_COST`, cost),
      latencyWeight: numberEnv(`SOFIA_${id.toUpperCase()}_LATENCY`, latency),
      qualityWeight: numberEnv(`SOFIA_${id.toUpperCase()}_QUALITY`, quality),
      healthy: true,
    });
    providers[id] = { baseUrl: GEMINI_BASE_URL, apiKey, model };
  }

  return { routes, providers };
}
