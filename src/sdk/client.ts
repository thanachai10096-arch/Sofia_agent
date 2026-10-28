export interface SofiaClientOptions {
  apiKey: string;
  baseUrl: string;
  /** Injectable fetch implementation for mobile runtimes, tests, or custom transports. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout, useful for mobile networks that stall without disconnecting. */
  requestTimeoutMs?: number;
}

export interface SofiaRunInput {
  task: string;
  workspace?: string;
  context?: string | Record<string, unknown>;
  maxSteps?: number;
  acceptanceCriteria?: Array<{ id: string; description: string; probe: { tool: string; input: Record<string, unknown> } }>;
}

export type SofiaModelProvider = "openai-compatible" | "gemini" | "openrouter";
export interface SofiaModelProfileInput {
  provider: SofiaModelProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
}
export interface SofiaModelProfileMetadata {
  provider: SofiaModelProvider;
  model: string;
  baseUrl: string;
  updatedAt: string;
}

export type SofiaContinuousWorkStatus = "active" | "paused" | "stopped" | "completed" | "failed";

export interface SofiaContinuousWorkRecord {
  id: string;
  ownerKeyId: string;
  task: string;
  status: SofiaContinuousWorkStatus;
  iteration: number;
  maxIterationsPerActivation: number;
  maxLifetimeIterations?: number;
  currentJobId?: string;
  lastSummary?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export type SofiaRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** Per-API-key usage counters for the current rolling 24-hour window. */
export interface SofiaUsageSnapshot {
  keyId: string;
  runs: number;
  toolCalls: number;
  startedAt: number;
}

export interface SofiaRunResponse {
  id: string;
  status: SofiaRunStatus;
  result?: { output: string; kind: string; steps: number };
  error?: string;
}

export interface SofiaPollOptions {
  intervalMs?: number;
  maxIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class SofiaApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SofiaApiError";
  }
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error("Sofia request aborted.");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function isTransient(error: unknown): boolean {
  if (error instanceof SofiaApiError) return error.status === 429 || error.status >= 500;
  // Network disconnects are common while a mobile app changes networks/background state.
  return !(error instanceof Error && /abort(ed)?/i.test(error.message));
}

export class SofiaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: SofiaClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    // Validate before retaining a URL that will receive the caller's bearer token.
    const base = new URL(options.baseUrl);
    const loopbackHttp = base.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
    if (base.protocol !== "https:" && !loopbackHttp) {
      throw new Error("Sofia API baseUrl must use HTTPS (HTTP is allowed only for loopback development).");
    }
    if (base.username || base.password) {
      throw new Error("Sofia API baseUrl must not contain embedded credentials.");
    }
    if (base.search || base.hash) {
      throw new Error("Sofia API baseUrl must not contain a query string or fragment.");
    }
    if (!options.apiKey.trim()) throw new Error("Sofia API key is required.");
    this.baseUrl = base.toString().replace(/\/$/, "");
  }

  private url(path: string) {
    return new URL(path, this.baseUrl);
  }

  private headers() {
    return {
      authorization: `Bearer ${this.options.apiKey}`,
      "content-type": "application/json",
    };
  }

  private async request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw abortError(signal);
    const controller = new AbortController();
    const timeoutMs = Math.max(1, this.options.requestTimeoutMs ?? 30_000);
    const timeout = setTimeout(() => controller.abort(new Error("Sofia request timed out.")), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason ?? new Error("Sofia request aborted."));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    try {
      const response = await this.fetchImpl(this.url(path), { ...init, signal: controller.signal });
      let data: Record<string, unknown>;
      try {
        const parsed: unknown = await response.json();
        data = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
      } catch {
        data = {};
      }
      if (!response.ok) {
        const message = typeof data.error === "string" ? data.error : `Sofia API error ${response.status}`;
        throw new SofiaApiError(message, response.status);
      }
      return data as T;
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (controller.signal.aborted) throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error("Sofia request timed out.");
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async run(input: SofiaRunInput, signal?: AbortSignal): Promise<SofiaRunResponse> {
    return this.request<SofiaRunResponse>("/v1/agent/runs", {
      method: "POST", headers: this.headers(), body: JSON.stringify(input),
    }, signal);
  }

  /** Starts a durable async run so a mobile client can reconnect and poll by ID. */
  async start(input: SofiaRunInput, signal?: AbortSignal, options: { idempotencyKey?: string; messagingContext?: import("../integrations/chat-adapter.js").SignedMessagingContext } = {}): Promise<SofiaRunResponse> {
    const headers: Record<string, string> = this.headers();
    if (options.idempotencyKey) {
      if (options.idempotencyKey.length > 128 || /[\x00-\x1f\x7f]/.test(options.idempotencyKey)) {
        throw new Error("Sofia idempotencyKey must be at most 128 characters and contain no control characters.");
      }
      headers["idempotency-key"] = options.idempotencyKey;
    }
    return this.request<SofiaRunResponse>("/v1/agent/runs", {
      method: "POST", headers, body: JSON.stringify({ ...input, async: true, ...(options.messagingContext ? { _messagingContext: options.messagingContext } : {}) }),
    }, signal);
  }

  /** Read this API key's model profile. Provider credentials are never returned. */
  /** Read this API key's current usage counters; no provider credentials or raw key are returned. */
  async getUsage(signal?: AbortSignal): Promise<SofiaUsageSnapshot> {
    return this.request<SofiaUsageSnapshot>("/v1/usage", { headers: this.headers() }, signal);
  }

  async getModelProfile(signal?: AbortSignal): Promise<{ profile: SofiaModelProfileMetadata | null }> {
    return this.request("/v1/model-profile", {
      headers: this.headers(),
    }, signal);
  }

  /** Set this API key's encrypted provider/model profile. The response contains metadata only. */
  async setModelProfile(input: SofiaModelProfileInput, signal?: AbortSignal): Promise<{ profile: SofiaModelProfileMetadata }> {
    return this.request("/v1/model-profile", {
      method: "PUT", headers: this.headers(), body: JSON.stringify(input),
    }, signal);
  }

  async deleteModelProfile(signal?: AbortSignal): Promise<{ deleted: boolean }> {
    return this.request("/v1/model-profile", {
      method: "DELETE", headers: this.headers(),
    }, signal);
  }

  /** Execute a chat action bound to a signed platform/user identity; intended for trusted server-side bridges only. */
  async continuousWorkChatAction(input: {
    signedTask: string;
    messagingContext: {
      platform: "telegram" | "discord" | "slack" | "line" | "whatsapp" | "matrix";
      userId: string;
      conversationId: string;
      messageId: string;
      taskHash: string;
      signature: string;
    };
  }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/v1/continuous-work/chat", {
      method: "POST", headers: this.headers(), body: JSON.stringify(input),
    }, signal);
  }

  /** Create a paused, owner-scoped objective that can be resumed in bounded work slices. */
  async createContinuousWork(task: string, signal?: AbortSignal): Promise<{ work: SofiaContinuousWorkRecord }> {
    return this.request("/v1/continuous-work", {
      method: "POST", headers: this.headers(), body: JSON.stringify({ task }),
    }, signal);
  }

  async listContinuousWork(signal?: AbortSignal): Promise<{ work: SofiaContinuousWorkRecord[] }> {
    return this.request("/v1/continuous-work", { headers: this.headers() }, signal);
  }

  async getContinuousWork(id: string, signal?: AbortSignal): Promise<{ work: SofiaContinuousWorkRecord }> {
    return this.request(`/v1/continuous-work/${encodeURIComponent(id)}`, { headers: this.headers() }, signal);
  }

  /** Run one bounded activation; poll getContinuousWork for progress and resume later if paused. */
  async resumeContinuousWork(id: string, signal?: AbortSignal): Promise<{ accepted: boolean; workId: string; status: string }> {
    return this.request(`/v1/continuous-work/${encodeURIComponent(id)}/resume`, {
      method: "POST", headers: this.headers(),
    }, signal);
  }

  /** Keep resuming bounded activations server-side until completed, failed, paused, or stopped. */
  async continueContinuousWork(id: string, signal?: AbortSignal): Promise<{ accepted: boolean; workId: string; mode: "continuous" }> {
    return this.request(`/v1/continuous-work/${encodeURIComponent(id)}/continue`, {
      method: "POST", headers: this.headers(),
    }, signal);
  }

  async pauseContinuousWork(id: string, signal?: AbortSignal): Promise<{ work: SofiaContinuousWorkRecord }> {
    return this.request(`/v1/continuous-work/${encodeURIComponent(id)}/pause`, {
      method: "POST", headers: this.headers(),
    }, signal);
  }

  async stopContinuousWork(id: string, signal?: AbortSignal): Promise<{ work: SofiaContinuousWorkRecord }> {
    return this.request(`/v1/continuous-work/${encodeURIComponent(id)}/stop`, {
      method: "POST", headers: this.headers(),
    }, signal);
  }

  async startJob(input: SofiaRunInput, signal?: AbortSignal): Promise<SofiaRunResponse> {
    return this.request<SofiaRunResponse>("/v1/jobs", {
      method: "POST", headers: this.headers(), body: JSON.stringify(input),
    }, signal);
  }

  async getJob(id: string, signal?: AbortSignal): Promise<SofiaRunResponse> {
    return this.request<SofiaRunResponse>(`/v1/jobs/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${this.options.apiKey}` },
    }, signal);
  }

  async resumeJob(id: string, signal?: AbortSignal): Promise<SofiaRunResponse> {
    return this.request<SofiaRunResponse>(`/v1/jobs/${encodeURIComponent(id)}/resume`, {
      method: "POST", headers: this.headers(),
    }, signal);
  }

  async cancelJob(id: string, signal?: AbortSignal): Promise<SofiaRunResponse> {
    return this.request<SofiaRunResponse>(`/v1/jobs/${encodeURIComponent(id)}/cancel`, {
      method: "POST", headers: this.headers(),
    }, signal);
  }

  async waitForJob(id: string, options: SofiaPollOptions = {}): Promise<SofiaRunResponse> {
    return this.waitFor(() => this.getJob(id, options.signal), options);
  }

  async getRun(id: string, signal?: AbortSignal): Promise<SofiaRunResponse> {
    return this.request<SofiaRunResponse>(`/v1/agent/runs/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${this.options.apiKey}` },
    }, signal);
  }

  async cancel(id: string, signal?: AbortSignal): Promise<SofiaRunResponse> {
    return this.request<SofiaRunResponse>(`/v1/agent/runs/${encodeURIComponent(id)}`, {
      method: "DELETE", headers: { authorization: `Bearer ${this.options.apiKey}` },
    }, signal);
  }

  async waitForRun(id: string, options: SofiaPollOptions = {}): Promise<SofiaRunResponse> {
    return this.waitFor(() => this.getRun(id, options.signal), options);
  }

  private async waitFor(
    fetchStatus: () => Promise<SofiaRunResponse>,
    options: SofiaPollOptions,
  ): Promise<SofiaRunResponse> {
    const initialInterval = Math.max(100, options.intervalMs ?? 1_000);
    const maxInterval = Math.max(initialInterval, options.maxIntervalMs ?? 10_000);
    const timeoutMs = Math.max(1, options.timeoutMs ?? 30 * 60 * 1_000);
    const started = Date.now();
    let interval = initialInterval;
    let lastTransientError: unknown;

    while (Date.now() - started < timeoutMs) {
      if (options.signal?.aborted) throw abortError(options.signal);
      try {
        const run = await fetchStatus();
        if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return run;
        lastTransientError = undefined;
        interval = initialInterval;
      } catch (error) {
        if (options.signal?.aborted) throw abortError(options.signal);
        if (!isTransient(error)) throw error;
        lastTransientError = error;
        interval = Math.min(maxInterval, Math.max(initialInterval, interval * 2));
      }

      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) break;
      await sleep(Math.min(interval, remaining), options.signal);
    }

    if (lastTransientError && Date.now() - started >= timeoutMs) {
      throw new Error("Timed out waiting for Sofia job after repeated transient API errors.", { cause: lastTransientError });
    }
    throw new Error("Timed out waiting for Sofia job.");
  }
}
