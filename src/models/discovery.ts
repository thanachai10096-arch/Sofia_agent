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


export interface ModelCapabilityProbeConfig extends ModelDiscoveryConfig {
  model: string;
}

export interface ModelCapabilityProbeResult {
  model: string;
  chat: "supported";
  toolUse: "supported" | "unknown";
  /** Only includes capabilities demonstrated by this probe. */
  verifiedCapabilities: ModelCapability[];
}

/**
 * Performs small, billable requests to verify basic chat and tool-call behavior.
 * It never executes the tool; it only checks whether the model returns a tool call.
 * Vision, reasoning quality, context window, and structured-output support are not inferred.
 */
export async function probeModelCapabilities(
  config: ModelCapabilityProbeConfig,
  options: DiscoverModelsOptions = {},
): Promise<ModelCapabilityProbeResult> {
  const baseUrl = validateDiscoveryBaseUrl(config.baseUrl);
  const model = config.model.trim();
  if (!model) throw new Error("A model ID is required for capability probing.");
  if (model.length > 512) throw new Error("Model ID is too long.");
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error("Invalid model capability probe timeout.");
  }
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const anthropic = config.protocol === "anthropic";

  const request = async (tools: boolean): Promise<{ ok: boolean; toolCall: boolean }> => {
    const endpoint = anthropic ? baseUrl + "/messages" : baseUrl + "/chat/completions";
    const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
    if (config.apiKey) {
      if (anthropic) {
        headers["x-api-key"] = config.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers.authorization = "Bearer " + config.apiKey;
      }
    }
    const body = anthropic
      ? {
          model,
          max_tokens: 32,
          messages: [{ role: "user", content: tools
            ? "Call the function report_probe with {\"ok\":true}. Do not answer in text."
            : "Reply with the single word OK." }],
          ...(tools ? { tools: [{
            name: "report_probe",
            description: "Reports that the model supports tool calls. Do not execute anything.",
            input_schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
          }], tool_choice: { type: "tool", name: "report_probe" } } : {}),
        }
      : {
          model,
          max_tokens: 32,
          messages: [{ role: "user", content: tools
            ? "Call the function report_probe with {\"ok\":true}. Do not answer in text."
            : "Reply with the single word OK." }],
          ...(tools ? { tools: [{
            type: "function",
            function: {
              name: "report_probe",
              description: "Reports that the model supports tool calls. Do not execute anything.",
              parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
            },
          }], tool_choice: { type: "function", function: { name: "report_probe" } } } : {}),
        };

    let response: Response;
    try {
      response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal, redirect: "error" });
    } catch {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Model capability probe aborted.");
      if (signal.aborted) throw new Error("Model capability probe timed out.");
      throw new Error("Unable to reach the configured model capability probe endpoint.");
    }
    if (!response.ok) {
      if (tools && [400, 404, 405, 422].includes(response.status)) return { ok: false, toolCall: false };
      throw new Error("Model capability probe endpoint returned HTTP " + response.status + ".");
    }
    let payload: unknown;
    try { payload = await response.json(); } catch {
      throw new Error("Model capability probe endpoint returned invalid JSON.");
    }
    if (!payload || typeof payload !== "object") throw new Error("Model capability probe endpoint returned an unsupported response.");
    if (anthropic) {
      const content = "content" in payload && Array.isArray(payload.content) ? payload.content : [];
      return { ok: true, toolCall: content.some((item) => !!item && typeof item === "object" && "type" in item && item.type === "tool_use") };
    }
    const choices = "choices" in payload && Array.isArray(payload.choices) ? payload.choices : [];
    const first = choices[0];
    const message = first && typeof first === "object" && "message" in first && first.message && typeof first.message === "object"
      ? first.message
      : null;
    const toolCalls = message && "tool_calls" in message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
    return { ok: choices.length > 0, toolCall: toolCalls.length > 0 };
  };

  const chatResult = await request(false);
  if (!chatResult.ok) throw new Error("Model capability probe did not receive a valid chat completion.");
  const toolResult = await request(true);
  return {
    model,
    chat: "supported",
    toolUse: toolResult.toolCall ? "supported" : "unknown",
    verifiedCapabilities: toolResult.toolCall ? ["tool-use"] : [],
  };
}
