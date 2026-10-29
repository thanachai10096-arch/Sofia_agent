import type { ModelCapability, ModelRoute } from "./types.js";

export interface SofiaGatewayProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
  maxConcurrent?: number;
  requestTimeoutMs?: number;
}

export interface SofiaModelConfig {
  routes: ModelRoute[];
  providers: Record<string, SofiaGatewayProviderConfig>;
}

type ProviderDefinition = {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  maxConcurrent?: number;
  requestTimeoutMs?: number;
};

type ProviderManifest = Record<string, ProviderDefinition>;

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

const definitions: ReadonlyArray<{
  id: "fast" | "coding" | "reasoning" | "vision";
  capabilities: readonly ModelCapability[];
  cost: number;
  latency: number;
  quality: number;
}> = [
  { id: "fast", capabilities: ["fast"], cost: 1, latency: 1, quality: 5 },
  { id: "coding", capabilities: ["coding", "tool-use", "reasoning"], cost: 2, latency: 2, quality: 8 },
  { id: "reasoning", capabilities: ["reasoning", "long-context"], cost: 3, latency: 3, quality: 9 },
  { id: "vision", capabilities: ["vision", "reasoning"], cost: 3, latency: 3, quality: 8 },
];

function textEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function numberEnv(name: string, fallback: number): number {
  const raw = textEnv(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseProviderManifest(raw: string): ProviderManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SOFIA_MODEL_PROVIDERS must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SOFIA_MODEL_PROVIDERS must be a JSON object keyed by provider ID.");
  }

  const manifest: ProviderManifest = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
      throw new Error(`Invalid model provider ID: ${id}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Provider ${id} must be an object.`);
    }
    const item = value as Record<string, unknown>;
    const baseUrl = typeof item.baseUrl === "string" ? item.baseUrl.trim() : "";
    const model = typeof item.model === "string" ? item.model.trim() : "";
    if (!baseUrl || !model) {
      throw new Error(`Provider ${id} requires baseUrl and model.`);
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      throw new Error(`Provider ${id} has an invalid baseUrl.`);
    }
    const localHost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsedUrl.hostname);
    if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && localHost)) {
      throw new Error(`Provider ${id} baseUrl must use HTTPS (HTTP is allowed only for localhost).`);
    }
    const apiKeyEnv = typeof item.apiKeyEnv === "string" ? item.apiKeyEnv.trim() : undefined;
    const apiKey = typeof item.apiKey === "string" ? item.apiKey : undefined;
    const headers: Record<string, string> = {};
    if (item.headers !== undefined) {
      if (!item.headers || typeof item.headers !== "object" || Array.isArray(item.headers)) {
        throw new Error(`Provider ${id} headers must be an object.`);
      }
      for (const [name, headerValue] of Object.entries(item.headers as Record<string, unknown>)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
            typeof headerValue !== "string" ||
            /^(authorization|proxy-authorization|host|content-length)$/i.test(name)) {
          throw new Error(`Provider ${id} has an invalid or reserved header.`);
        }
        headers[name] = headerValue;
      }
    }
    const maxConcurrent = item.maxConcurrent;
    const requestTimeoutMs = item.requestTimeoutMs;
    if (maxConcurrent !== undefined &&
        (!Number.isSafeInteger(maxConcurrent) || (maxConcurrent as number) < 1 || (maxConcurrent as number) > 256)) {
      throw new Error(`Provider ${id} maxConcurrent must be an integer from 1 to 256.`);
    }
    if (requestTimeoutMs !== undefined &&
        (!Number.isSafeInteger(requestTimeoutMs) || (requestTimeoutMs as number) < 1)) {
      throw new Error(`Provider ${id} requestTimeoutMs must be a positive integer.`);
    }
    manifest[id] = {
      baseUrl: baseUrl.replace(/\/$/, ""),
      model,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(maxConcurrent !== undefined ? { maxConcurrent: maxConcurrent as number } : {}),
      ...(requestTimeoutMs !== undefined ? { requestTimeoutMs: requestTimeoutMs as number } : {}),
    };
  }
  if (!Object.keys(manifest).length) throw new Error("SOFIA_MODEL_PROVIDERS cannot be empty.");
  return manifest;
}

function resolveProvider(
  id: string,
  definition: ProviderDefinition,
  routeId: string,
): SofiaGatewayProviderConfig {
  const routePrefix = `SOFIA_${routeId.toUpperCase()}_`;
  const baseUrl = textEnv(routePrefix + "BASE_URL") || definition.baseUrl;
  const model = textEnv(routePrefix + "MODEL") || definition.model;
  const keyName = textEnv(routePrefix + "API_KEY_ENV") || definition.apiKeyEnv;
  const apiKey = textEnv(routePrefix + "API_KEY") ||
    (keyName ? textEnv(keyName) : "") ||
    (definition.apiKey ?? "");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Provider ${id} has an invalid base URL.`);
  }
  const localHost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) {
    throw new Error(`Provider ${id} base URL must use HTTPS (HTTP is allowed only for localhost).`);
  }
  if (!model) throw new Error(`No model configured for route ${routeId}.`);
  return {
    baseUrl: baseUrl.replace(/\/$/, "") + "/",
    apiKey,
    model,
    ...(definition.headers ? { headers: definition.headers } : {}),
    ...(definition.maxConcurrent !== undefined ? { maxConcurrent: definition.maxConcurrent } : {}),
    ...(definition.requestTimeoutMs !== undefined ? { requestTimeoutMs: definition.requestTimeoutMs } : {}),
  };
}

/**
 * Model-agnostic OpenAI-compatible configuration.
 *
 * Each task route can select a provider and model independently. This adapter
 * supports any provider exposing the OpenAI Chat Completions-compatible API;
 * non-compatible APIs require a dedicated adapter. Credentials should be
 * supplied via secret environment variables, never committed to source control.
 */
export function loadModelConfigFromEnv(): SofiaModelConfig {
  const manifestRaw = textEnv("SOFIA_MODEL_PROVIDERS");
  const manifest = manifestRaw ? parseProviderManifest(manifestRaw) : undefined;
  const legacyGeminiKey = textEnv("GEMINI_API_KEY") || textEnv("Gemini_API_Key");
  const legacyGeminiModel = textEnv("GEMINI_MODEL") || "gemini-2.5-flash";

  const legacyGemini: ProviderDefinition = {
    baseUrl: GEMINI_BASE_URL,
    model: legacyGeminiModel,
    apiKey: legacyGeminiKey,
  };

  if (!manifest && !legacyGeminiKey) {
    throw new Error(
      "Configure SOFIA_MODEL_PROVIDERS and SOFIA_<ROUTE>_PROVIDER, or set GEMINI_API_KEY for legacy Gemini configuration.",
    );
  }

  const routes: ModelRoute[] = [];
  const providers: SofiaModelConfig["providers"] = {};
  for (const definition of definitions) {
    const prefix = `SOFIA_${definition.id.toUpperCase()}_`;
    const selectedProvider = textEnv(prefix + "PROVIDER") ||
      (manifest && Object.keys(manifest).length === 1 ? Object.keys(manifest)[0] : "") ||
      (manifest ? "" : "gemini");

    let providerDefinition: ProviderDefinition | undefined;
    if (selectedProvider === "gemini" && !manifest) {
      providerDefinition = legacyGemini;
    } else {
      providerDefinition = selectedProvider ? manifest?.[selectedProvider] : undefined;
    }
    if (!providerDefinition) {
      throw new Error(
        `No provider configured for route ${definition.id}. Set SOFIA_${definition.id.toUpperCase()}_PROVIDER to a key in SOFIA_MODEL_PROVIDERS.`,
      );
    }

    const providerKey = definition.id;
    const legacyRouteModel = !manifest ? textEnv(`GEMINI_${definition.id.toUpperCase()}_MODEL`) : "";
    const routeProvider: ProviderDefinition = {
      ...providerDefinition,
      ...(textEnv(prefix + "BASE_URL") ? { baseUrl: textEnv(prefix + "BASE_URL") } : {}),
      ...(textEnv(prefix + "MODEL") ? { model: textEnv(prefix + "MODEL") } : {}),
      ...(legacyRouteModel && !textEnv(prefix + "MODEL") ? { model: legacyRouteModel } : {}),
    };
    providers[providerKey] = resolveProvider(selectedProvider, routeProvider, definition.id);
    routes.push({
      id: definition.id,
      providerId: providerKey,
      capabilities: [...definition.capabilities],
      costWeight: numberEnv(`SOFIA_${definition.id.toUpperCase()}_COST`, definition.cost),
      latencyWeight: numberEnv(`SOFIA_${definition.id.toUpperCase()}_LATENCY`, definition.latency),
      qualityWeight: numberEnv(`SOFIA_${definition.id.toUpperCase()}_QUALITY`, definition.quality),
      healthy: true,
    });
  }
  return { routes, providers };
}
