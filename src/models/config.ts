import type { ModelRoute } from "./types.js";

export interface SofiaModelConfig {
  routes: ModelRoute[];
  providers: Record<string, { baseUrl: string; apiKey: string; model: string }>;
}

type Environment = Record<string, string | undefined>;

function numberEnv(env: Environment, name: string, fallback: number) {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const ROUTE_DEFINITIONS = [
  ["fast", ["fast"], 1, 1, 5],
  ["coding", ["coding", "tool-use", "reasoning"], 2, 2, 8],
  ["reasoning", ["reasoning", "long-context"], 3, 3, 9],
  ["vision", ["vision", "reasoning"], 3, 3, 8],
] as const;

function validateBaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("SOFIA_MODEL_BASE_URL must be a valid HTTP(S) URL."); }
  const localHttp = parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
  if ((parsed.protocol !== "https:" && !localHttp) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("SOFIA_MODEL_BASE_URL must use HTTPS (HTTP is allowed only for localhost) and must not contain credentials, query, or fragment.");
  }
  return parsed.toString().replace(/\/$/, "") + (parsed.pathname.endsWith("/") ? "" : "/");
}

/**
 * Configure any OpenAI-compatible chat-completions endpoint with:
 * SOFIA_MODEL_BASE_URL, SOFIA_MODEL_API_KEY, and SOFIA_MODEL.
 * When these are all absent, preserve the legacy direct Gemini setup.
 * Provider selection is explicit; Sofia never silently falls back to another vendor.
 */
export function loadModelConfigFromEnv(env: Environment = process.env): SofiaModelConfig {
  const genericValues = [
    env.SOFIA_MODEL_BASE_URL?.trim(),
    env.SOFIA_MODEL_API_KEY?.trim(),
    env.SOFIA_MODEL?.trim(),
  ];
  const genericConfigured = genericValues.some(Boolean);
  let baseUrl: string;
  let apiKey: string;
  let defaultModel: string;
  let generic = false;

  if (genericConfigured) {
    if (genericValues.some((value) => !value)) {
      throw new Error("Set all three variables together: SOFIA_MODEL_BASE_URL, SOFIA_MODEL_API_KEY, and SOFIA_MODEL.");
    }
    baseUrl = validateBaseUrl(genericValues[0]!);
    apiKey = genericValues[1]!;
    defaultModel = genericValues[2]!;
    generic = true;
  } else {
    apiKey = env.GEMINI_API_KEY?.trim() || env.Gemini_API_Key?.trim() || "";
    if (!apiKey) {
      throw new Error("Configure SOFIA_MODEL_BASE_URL + SOFIA_MODEL_API_KEY + SOFIA_MODEL, or set GEMINI_API_KEY for the legacy Gemini default.");
    }
    baseUrl = GEMINI_BASE_URL;
    defaultModel = env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  }

  const providerPrefix = generic
    ? (env.SOFIA_MODEL_PROVIDER?.trim() || "custom").toUpperCase()
    : "GEMINI";
  if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(providerPrefix)) {
    throw new Error("SOFIA_MODEL_PROVIDER must contain only letters, numbers, and underscores and start with a letter.");
  }

  const routes: ModelRoute[] = [];
  const providers: SofiaModelConfig["providers"] = {};
  for (const [id, capabilities, cost, latency, quality] of ROUTE_DEFINITIONS) {
    const routeSpecificModel = generic
      ? env[`SOFIA_${id.toUpperCase()}_MODEL`]?.trim()
      : env[`GEMINI_${id.toUpperCase()}_MODEL`]?.trim();
    const model = routeSpecificModel || defaultModel;
    routes.push({
      id,
      providerId: id,
      capabilities: [...capabilities] as import("./types.js").ModelCapability[],
      costWeight: numberEnv(env, `SOFIA_${id.toUpperCase()}_COST`, cost),
      latencyWeight: numberEnv(env, `SOFIA_${id.toUpperCase()}_LATENCY`, latency),
      qualityWeight: numberEnv(env, `SOFIA_${id.toUpperCase()}_QUALITY`, quality),
      healthy: true,
    });
    providers[id] = { baseUrl, apiKey, model };
  }

  return { routes, providers };
}
