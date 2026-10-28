import type { ModelCapability } from "./types.js";

export interface ModelDiscoveryConfig {
  baseUrl: string;
  apiKey?: string;
  protocol?: "openai-compatible" | "anthropic";
}

export interface DiscoveredModel {
  id: string;
  displayName?: string;
  ownedBy?: string;
  created?: number;
  /** Null means the endpoint does not provide verified capability metadata. */
  capabilities: ModelCapability[] | null;
}

export interface DiscoverModelsOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Lists model IDs from an OpenAI-compatible or Anthropic endpoint.
 * This is discovery only: listing a model does not prove its tool, vision,
 * context-window, or structured-output support.
 */
export async function discoverModels(
  config: ModelDiscoveryConfig,
  options: DiscoverModelsOptions = {},
): Promise<DiscoveredModel[]> {
  const url = validateDiscoveryBaseUrl(config.baseUrl);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error("Invalid model discovery timeout.");
  }

  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const isAnthropic = config.protocol === "anthropic";
  let response: Response;
  try {
    response = await fetch(url + "/models", {
      method: "GET",
      headers: {
        ...(config.apiKey
          ? isAnthropic
            ? { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }
            : { authorization: "Bearer " + config.apiKey }
          : {}),
        accept: "application/json",
      },
      signal,
      redirect: "error",
    });
  } catch {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Model discovery aborted.");
    if (signal.aborted) throw new Error("Model discovery timed out.");
    throw new Error("Unable to reach the configured model discovery endpoint.");
  }
  if (!response.ok) {
    throw new Error("Model discovery endpoint returned HTTP " + response.status + ".");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Model discovery endpoint returned invalid JSON.");
  }
  if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
    throw new Error("Model discovery endpoint returned an unsupported response shape.");
  }

  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const item of payload.data) {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string") continue;
    const id = item.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = "display_name" in item && typeof item.display_name === "string"
      ? item.display_name
      : undefined;
    const ownedBy = "owned_by" in item && typeof item.owned_by === "string"
      ? item.owned_by
      : undefined;
    const created = "created" in item && typeof item.created === "number" && Number.isFinite(item.created)
      ? item.created
      : undefined;
    models.push({
      id,
      ...(displayName ? { displayName } : {}),
      ...(ownedBy ? { ownedBy } : {}),
      ...(created !== undefined ? { created } : {}),
      capabilities: null,
    });
  }
  return models;
}

function validateDiscoveryBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Model discovery base URL must be a valid absolute URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Model discovery base URL must not contain credentials, query parameters, or fragments.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Model discovery base URL must use HTTPS; HTTP is allowed only for loopback model servers.");
  }
  return url.toString().replace(/\/+$/, "");
}
