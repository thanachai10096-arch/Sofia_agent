import { randomUUID } from "node:crypto";

export type PythonAiServiceErrorCode =
  | "CONFIGURATION" | "REQUEST_INVALID" | "TIMEOUT" | "ABORTED"
  | "NETWORK" | "HTTP" | "RESPONSE_INVALID";

export class PythonAiServiceError extends Error {
  constructor(readonly code: PythonAiServiceErrorCode, message: string, readonly statusCode?: number) {
    super(message);
    this.name = "PythonAiServiceError";
  }
}

export interface PythonAiServiceClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}
export interface EmbeddingResult { model: string; dimensions: number; embeddings: number[][]; }
export interface RerankResult { model: string; results: Array<{ index: number; score: number }>; }

const MAX_ITEMS = 64;
const MAX_TEXT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REQUEST_BYTES = 512 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validateBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new PythonAiServiceError("CONFIGURATION", "Python AI service URL is invalid."); }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHosts.has(url.hostname))) ||
      url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "")) {
    throw new PythonAiServiceError("CONFIGURATION", "Python AI service URL must use HTTPS (HTTP is allowed only for loopback development).");
  }
  return url.origin;
}
function validateTexts(texts: unknown, label: string): asserts texts is string[] {
  if (!Array.isArray(texts) || texts.length < 1 || texts.length > MAX_ITEMS) {
    throw new PythonAiServiceError("REQUEST_INVALID", label + " must contain 1–64 items.");
  }
  if (texts.some((text) => typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_CHARS)) {
    throw new PythonAiServiceError("REQUEST_INVALID", label + " contains an empty or oversized text.");
  }
}
function validateModelName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}
async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    throw new PythonAiServiceError("RESPONSE_INVALID", "Python AI service response is too large.");
  }
  if (!response.body) throw new PythonAiServiceError("RESPONSE_INVALID", "Python AI service returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new PythonAiServiceError("RESPONSE_INVALID", "Python AI service response is too large.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new PythonAiServiceError("RESPONSE_INVALID", "Python AI service response is not valid UTF-8."); }
}
function parseEmbeddingResult(value: unknown, expectedCount: number): EmbeddingResult {
  if (!isRecord(value) || !validateModelName(value.model) ||
      !Number.isSafeInteger(value.dimensions) || (value.dimensions as number) < 1 ||
      (value.dimensions as number) > 65_536 ||
      !Array.isArray(value.embeddings) || value.embeddings.length !== expectedCount) {
    throw new PythonAiServiceError("RESPONSE_INVALID", "Python AI service returned an invalid embedding response.");
  }
  const dimensions = value.dimensions as number;
  const embeddings: number[][] = [];
  for (const vector of value.embeddings) {
    if (!Array.isArray(vector) || vector.length !== dimensions ||
        vector.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
      throw new PythonAiServiceError("RESPONSE_INVALID", "Python AI service returned malformed embedding values.");
    }
    embeddings.push([...vector] as number[]);
  }
  return { model: value.model, dimensions, embeddings };
}
function parseRerankResult(value: unknown, expectedCount: number): RerankResult {
  if (!isRecord(value) || !validateModelName(value.model) ||
      !Array.isArray(value.results) || value.results.length !== expectedCount) {
    throw new PythonAiServiceError("RESPONSE_INVALID", "Python AI service returned an invalid rerank response.");
  }
  const seen = new Set<number>();
  const results: Array<{ index: number; score: number }> = [];
  for (const item of value.results) {
    if (!isRecord(item) || !Number.isSafeInteger(item.index) ||
        (item.index as number) < 0 || (item.index as number) >= expectedCount ||
        typeof item.score !== "number" || !Number.isFinite(item.score) ||
        seen.has(item.index as number)) {
      throw new PythonAiServiceError("RESPONSE_INVALID", "Python AI service returned malformed rerank values.");
    }
    seen.add(item.index as number);
    results.push({ index: item.index as number, score: item.score });
  }
  return { model: value.model, results };
}

/**
 * Optional transport adapter for the isolated Python AI service.
 * It has no memory, tool, identity, or authorization authority.
 * Callers must retain their existing lexical retrieval path as fallback.
 * No automatic retries: retries must be explicit and budgeted by the caller.
 */
export class PythonAiServiceClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PythonAiServiceClientOptions) {
    this.baseUrl = validateBaseUrl(options.baseUrl);
    if (typeof options.token !== "string" || options.token.length < 24 || /[\r\n]/u.test(options.token)) {
      throw new PythonAiServiceError("CONFIGURATION", "Python AI service token is missing or invalid.");
    }
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > MAX_TIMEOUT_MS ||
        !Number.isSafeInteger(this.maxRequestBytes) || this.maxRequestBytes < 1 ||
        !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) {
      throw new PythonAiServiceError("CONFIGURATION", "Python AI service client limits are invalid.");
    }
  }

  async embed(texts: string[], options: { signal?: AbortSignal; normalize?: boolean } = {}): Promise<EmbeddingResult> {
    validateTexts(texts, "texts");
    const result = await this.post("/v1/embeddings", { texts, normalize: options.normalize ?? true }, options.signal);
    return parseEmbeddingResult(result, texts.length);
  }

  async rerank(query: string, documents: string[], options: { signal?: AbortSignal } = {}): Promise<RerankResult> {
    if (typeof query !== "string" || !query.trim() || query.length > MAX_TEXT_CHARS) {
      throw new PythonAiServiceError("REQUEST_INVALID", "query is empty or oversized.");
    }
    validateTexts(documents, "documents");
    const result = await this.post("/v1/rerank", { query, documents }, options.signal);
    return parseRerankResult(result, documents.length);
  }

  private async post(path: string, payload: unknown, callerSignal?: AbortSignal): Promise<unknown> {
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).byteLength > this.maxRequestBytes) {
      throw new PythonAiServiceError("REQUEST_INVALID", "Python AI service request is too large.");
    }
    if (callerSignal?.aborted) throw new PythonAiServiceError("ABORTED", "Python AI service request was cancelled.");
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("Deadline exceeded.")); }, this.timeoutMs);
    const requestId = randomUUID();
    try {
      const response = await this.fetchImpl(this.baseUrl + path, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: "Bearer " + this.token,
          "content-type": "application/json",
          accept: "application/json",
          "x-request-id": requestId,
        },
        body,
      });
      if (!response.ok) throw new PythonAiServiceError("HTTP", "Python AI service request failed.", response.status);
      if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
        throw new PythonAiServiceError("RESPONSE_INVALID", "Python AI service returned an unexpected content type.");
      }
      const raw = await readBoundedBody(response, this.maxResponseBytes);
      try { return JSON.parse(raw) as unknown; }
      catch { throw new PythonAiServiceError("RESPONSE_INVALID", "Python AI service returned invalid JSON."); }
    } catch (error) {
      if (error instanceof PythonAiServiceError) throw error;
      if (timedOut) throw new PythonAiServiceError("TIMEOUT", "Python AI service request timed out.");
      if (callerSignal?.aborted) throw new PythonAiServiceError("ABORTED", "Python AI service request was cancelled.");
      throw new PythonAiServiceError("NETWORK", "Python AI service is unavailable.");
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
