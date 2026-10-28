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
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
type ProviderKind = "gemini" | "openai" | "openrouter" | "openai-compatible";

function validateModelBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("SOFIA model base URL must be a valid absolute URL."); }
  const loopbackHttp = url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const allowInsecureHttp = process.env.SOFIA_MODEL_ALLOW_INSECURE_HTTP?.trim().toLowerCase() === "true";
  if (url.protocol !== "https:" && !loopbackHttp && !(allowInsecureHttp && url.protocol === "http:")) {
    throw new Error("Model API base URL must use HTTPS; HTTP is allowed only for loopback unless SOFIA_MODEL_ALLOW_INSECURE_HTTP=true.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Model API base URL must not contain credentials, query strings, or fragments.");
  }
  return value.replace(/\/$/, "");
}

function selectedProvider(): { kind: ProviderKind; baseUrl: string; apiKey: string; defaultModel: string; routePrefix: string } {
  const requested = process.env.SOFIA_MODEL_PROVIDER?.trim().toLowerCase();
  const geminiKey = process.env.GEMINI_API_KEY?.trim() || process.env.Gemini_API_Key?.trim() || "";
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim() || "";
  const openAiKey = process.env.OPENAI_API_KEY?.trim() || "";
  const explicitSofiaBaseUrl = process.env.SOFIA_MODEL_BASE_URL?.trim() || process.env.BASE_URL?.trim() || "";
  const openAiBaseUrl = process.env.OPENAI_BASE_URL?.trim() || "";
  const customBaseUrl = explicitSofiaBaseUrl || openAiBaseUrl;
  // Do not accidentally send an unrelated OPENAI_API_KEY to a custom BASE_URL.
  const customApiKey = process.env.SOFIA_MODEL_API_KEY?.trim() ||
    (explicitSofiaBaseUrl ? process.env.API_KEY?.trim() : "") ||
    (openAiBaseUrl ? openAiKey : "") ||
    (!explicitSofiaBaseUrl ? openAiKey : "") || "";

  let kind: ProviderKind;
  if (requested) {
    if (requested === "gemini" || requested === "openai" || requested === "openrouter" || requested === "openai-compatible") {
      kind = requested;
    } else {
      throw new Error("SOFIA_MODEL_PROVIDER must be gemini, openai, openrouter, or openai-compatible.");
    }
  } else if (explicitSofiaBaseUrl) {
    kind = "openai-compatible";
  } else if (openAiBaseUrl) {
    kind = "openai";
  } else if (geminiKey) {
    // Preserve existing deployments: Gemini remains the default when its key is configured.
    kind = "gemini";
  } else if (openRouterKey) {
    kind = "openrouter";
  } else if (openAiKey) {
    kind = "openai";
  } else {
    throw new Error("Configure GEMINI_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, or SOFIA_MODEL_BASE_URL + SOFIA_MODEL_API_KEY.");
  }

  if (kind === "gemini") {
    const apiKey = geminiKey;
    if (!apiKey) throw new Error("GEMINI_API_KEY is required when SOFIA_MODEL_PROVIDER=gemini.");
    return {
      kind, baseUrl: GEMINI_BASE_URL, apiKey,
      defaultModel: process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash",
      routePrefix: "GEMINI",
    };
  }
  if (kind === "openrouter") {
    const apiKey = openRouterKey;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is required when SOFIA_MODEL_PROVIDER=openrouter.");
    return {
      kind, baseUrl: OPENROUTER_BASE_URL, apiKey,
      defaultModel: process.env.OPENROUTER_MODEL?.trim() || process.env.SOFIA_MODEL?.trim() || "openai/gpt-4o-mini",
      routePrefix: "OPENROUTER",
    };
  }
  if (kind === "openai") {
    const apiKey = openAiKey || customApiKey;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required when SOFIA_MODEL_PROVIDER=openai.");
    return {
      kind, baseUrl: validateModelBaseUrl(process.env.OPENAI_BASE_URL?.trim() || OPENAI_BASE_URL), apiKey,
      defaultModel: process.env.OPENAI_MODEL?.trim() || process.env.SOFIA_MODEL?.trim() || "gpt-4o-mini",
      routePrefix: "OPENAI",
    };
  }

  if (!customBaseUrl) throw new Error("SOFIA_MODEL_BASE_URL (or BASE_URL) is required for an openai-compatible provider.");
  if (!customApiKey) throw new Error("SOFIA_MODEL_API_KEY (or API_KEY with BASE_URL) is required for an openai-compatible provider.");
  return {
    kind, baseUrl: validateModelBaseUrl(customBaseUrl), apiKey: customApiKey,
    defaultModel: process.env.SOFIA_MODEL?.trim() || process.env.MODEL?.trim() || "gpt-4o-mini",
    routePrefix: "SOFIA",
  };
}

export function loadModelConfigFromEnv(): SofiaModelConfig {
  const selected = selectedProvider();
  const definitions = [
    ["fast", ["fast"], 1, 1, 5],
    ["coding", ["coding", "tool-use", "reasoning"], 2, 2, 8],
    ["reasoning", ["reasoning", "long-context"], 3, 3, 9],
    ["vision", ["vision", "reasoning"], 3, 3, 8],
  ] as const;

  const routes: ModelRoute[] = [];
  const providers: SofiaModelConfig["providers"] = {};

  for (const [id, capabilities, cost, latency, quality] of definitions) {
    const routeModel = selected.kind === "gemini"
      ? process.env[`GEMINI_${id.toUpperCase()}_MODEL`]?.trim()
      : selected.kind === "openrouter"
        ? process.env[`OPENROUTER_${id.toUpperCase()}_MODEL`]?.trim()
        : selected.kind === "openai"
          ? process.env[`OPENAI_${id.toUpperCase()}_MODEL`]?.trim()
          : undefined;
    const model = routeModel ||
      process.env[`SOFIA_${id.toUpperCase()}_MODEL`]?.trim() ||
      process.env[`SOFIA_${id.toUpperCase()}`]?.trim() ||
      selected.defaultModel;

    routes.push({
      id,
      providerId: id,
      capabilities: [...capabilities] as import("./types.js").ModelCapability[],
      costWeight: numberEnv(`SOFIA_${id.toUpperCase()}_COST`, cost),
      latencyWeight: numberEnv(`SOFIA_${id.toUpperCase()}_LATENCY`, latency),
      qualityWeight: numberEnv(`SOFIA_${id.toUpperCase()}_QUALITY`, quality),
      healthy: true,
    });
    providers[id] = { baseUrl: selected.baseUrl, apiKey: selected.apiKey, model };
  }

  return { routes, providers };
}
