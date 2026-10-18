import type {
  ChatMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelRoute,
  ToolDefinition,
} from "./types.js";

export interface GatewayProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Used only when the configured model returns HTTP 404 (unknown/unavailable model). */
  fallbackModel?: string;
  /** Injectable fetch implementation for deterministic gateway tests. */
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  maxConcurrent?: number;
  /** One deadline for queue wait, provider attempts, and retry delays. Defaults to 45 seconds. */
  requestTimeoutMs?: number;
}

interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface GateWaiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class ConcurrencyGate {
  private active = 0;
  private readonly waiters: GateWaiter[] = [];
  constructor(private readonly limit: number) {}

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new Error("Request aborted.");
    if (this.active < this.limit) { this.active++; return; }
    await new Promise<void>((resolve, reject) => {
      const waiter: GateWaiter = { resolve, reject, ...(signal ? { signal } : {}) };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal?.reason ?? new Error("Request aborted."));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      if (signal?.aborted) waiter.onAbort();
    });
  }

  private release(): void {
    while (this.waiters.length) {
      const next = this.waiters.shift()!;
      next.signal?.removeEventListener("abort", next.onAbort!);
      if (next.signal?.aborted) {
        next.reject(next.signal.reason ?? new Error("Request aborted."));
        continue;
      }
      next.resolve();
      return;
    }
    this.active--;
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      if (signal?.aborted) throw signal.reason ?? new Error("Request aborted.");
      return await operation();
    } finally { this.release(); }
  }
}

interface CircuitState { failures: number; openedAt: number; probeInFlight?: boolean; }

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted."));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason ?? new Error("Request aborted.")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export class SofiaModelGateway implements ModelProvider {
  private readonly gates = new Map<string, ConcurrencyGate>();
  private readonly circuits = new Map<string, CircuitState>();

  constructor(
    private readonly providers: Record<string, GatewayProviderConfig>,
  ) {
    for (const [id, config] of Object.entries(providers)) {
      const limit = config.maxConcurrent ?? 8;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
        throw new Error("Invalid maxConcurrent for model provider " + id + ".");
      }
      const timeout = config.requestTimeoutMs ?? 45_000;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
        throw new Error("Invalid requestTimeoutMs for model provider " + id + ".");
      }
      this.gates.set(id, new ConcurrencyGate(limit));
    }
  }

  async generate(
    request: ModelRequest,
    route: ModelRoute,
    options: { signal?: AbortSignal; maxOutputTokens?: number } = {},
  ): Promise<ModelResponse> {
    const config = this.providers[route.providerId ?? route.id];
    if (!config) {
      throw new Error(`No provider configuration for route ${route.id}`);
    }

    const messages: ChatMessage[] = request.messages?.length
      ? request.messages
      : [
          {
            role: "system" as const,
            content:
              "You are Sofia, a general-purpose software agent. Use available tools when they help accomplish the task. Never reveal internal model routing.",
          },
          { role: "user" as const, content: request.task },
          ...(request.context
            ? [
                {
                  role: "user" as const,
                  content: `Workspace context:\n${request.context}`,
                },
              ]
            : []),
        ];

    const tools: ToolDefinition[] | undefined = request.tools?.length
      ? request.tools
      : undefined;

    const body = {
      model: config.model,
      messages,
      ...(tools ? { tools, tool_choice: "auto" } : {}),
      ...(options.maxOutputTokens
        ? { max_tokens: options.maxOutputTokens }
        : {}),
    };

    const providerId = route.providerId ?? route.id;
    const timeoutMs = config.requestTimeoutMs ?? 45_000;
    const requestSignal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const gate = this.gates.get(providerId);
    const circuit = this.circuits.get(providerId) ?? { failures: 0, openedAt: 0, probeInFlight: false };
    this.circuits.set(providerId, circuit);

    if (circuit.openedAt) {
      if (Date.now() - circuit.openedAt < 15_000) {
        route.healthy = false;
        throw new Error(`Model provider ${providerId} temporarily unavailable.`);
      }
      if (circuit.probeInFlight) throw new Error(`Model provider ${providerId} recovery probe already in progress.`);
      circuit.probeInFlight = true;
    }

    const execute = async (model = config.model): Promise<Response> => {
      const maxAttempts = 3;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let retryableFailure = false;
        try {
          const response = await (config.fetchImpl ?? fetch)(
            config.baseUrl.replace(/\/$/, "") + "/chat/completions",
            {
              method: "POST",
              headers: {
                ...config.headers,
                authorization: "Bearer " + config.apiKey,
                "content-type": "application/json",
              },
              body: JSON.stringify({ ...body, model }),
              signal: requestSignal,
            },
          );
          if (response.ok) {
            // Do not close a half-open circuit until the payload has been validated.
            return response;
          }
          const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
          retryableFailure = retryable;
          const detail = await response.text();
          lastError = new Error(`Model gateway request failed (${response.status}): ${detail.slice(0, 500)}`);
          // A stale or unsupported model ID should not make Discord completely unusable
          // when OpenRouter's Auto Router is available. Retry once with the configured
          // safe fallback; never mask authentication, quota, or network errors.
          if (response.status === 404 && model === config.model && config.fallbackModel && config.fallbackModel !== config.model) {
            return execute(config.fallbackModel);
          }
          if (!retryable || attempt === maxAttempts || options.signal?.aborted) throw lastError;
          const retryAfter = Number(response.headers.get("retry-after") ?? "");
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 5_000)
            : Math.min(250 * 2 ** (attempt - 1), 2_000) + Math.floor(Math.random() * 100);
          if (requestSignal.aborted) throw requestSignal.reason ?? new Error("Model gateway request timed out.");
          await abortableDelay(delay, requestSignal);
        } catch (error) {
          lastError = error;
          if (requestSignal.aborted || attempt === maxAttempts ||
              (error instanceof Error && error.message.startsWith("Model gateway request failed (") && !retryableFailure)) {
            throw requestSignal.aborted && requestSignal.reason instanceof Error ? requestSignal.reason : error;
          }
          await abortableDelay(Math.min(250 * 2 ** (attempt - 1), 2_000), requestSignal);
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Model provider request failed.");
    };

    let response: Response;
    try {
      response = await (gate ? gate.run(execute, requestSignal) : execute());
    } catch (error) {
      circuit.probeInFlight = false;
      if (!options.signal?.aborted) {
        // Non-retryable 4xx responses (including OpenRouter 402 billing/quota
        // rejections) are actionable provider responses, not transient outages.
        // Do not let them poison the circuit and replace the useful HTTP status
        // with a later generic "temporarily unavailable" error.
        const status = error instanceof Error
          ? Number(error.message.match(/^Model gateway request failed \((\d{3})\):/)?.[1])
          : NaN;
        const permanentClientRejection =
          Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
        if (permanentClientRejection) {
          circuit.failures = 0;
          circuit.openedAt = 0;
          route.healthy = true;
        } else {
          circuit.failures++;
          if (circuit.failures >= 3 || circuit.openedAt) {
            circuit.openedAt = Date.now();
            route.healthy = false;
          }
        }
      }
      throw error;
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Model gateway request failed (${response.status}): ${detail.slice(0, 500)}`,
      );
    }

    const failResponse = (message: string): never => {
      circuit.probeInFlight = false;
      route.healthy = false;
      circuit.failures++;
      if (circuit.failures >= 3 || circuit.openedAt) {
        circuit.openedAt = Date.now();
        route.healthy = false;
      }
      throw new Error(message);
    };

    let data: ChatResponse;
    try {
      data = (await response.json()) as ChatResponse;
    } catch {
      return failResponse("Model gateway returned invalid JSON.");
    }
    const message = data.choices?.[0]?.message;

    if (!message) {
      return failResponse("Model gateway returned no message.");
    }

    const calls = (message.tool_calls ?? []).map((call, index) => {
      const name = call.function?.name ?? "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.function?.arguments ?? "{}") as unknown;
      } catch {
        return failResponse(`invalid arguments for tool call ${name || index}.`);
      }
      if (!name.trim() || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return failResponse(`invalid arguments for tool call ${name || index}.`);
      }
      return {
        id: call.id ?? `call-${request.step}-${index}`,
        name,
        input: parsed as Record<string, unknown>,
      };
    });

    const text = message.content?.trim() ?? "";

    if (!text && !calls.length) {
      return failResponse("Model gateway returned an empty response.");
    }
    circuit.failures = 0;
    circuit.openedAt = 0;
    circuit.probeInFlight = false;
    route.healthy = true;

    const inputTokens = data.usage?.prompt_tokens;
    const outputTokens = data.usage?.completion_tokens;

    const inputTokenCount = typeof inputTokens === "number" ? inputTokens : undefined;
    const outputTokenCount = typeof outputTokens === "number" ? outputTokens : undefined;
    const usage =
      inputTokenCount !== undefined &&
      outputTokenCount !== undefined &&
      Number.isSafeInteger(inputTokenCount) &&
      inputTokenCount >= 0 &&
      Number.isSafeInteger(outputTokenCount) &&
      outputTokenCount >= 0
        ? { inputTokens: inputTokenCount, outputTokens: outputTokenCount }
        : undefined;

    return {
      text,
      toolCalls: calls.length ? calls : undefined,
      assistantMessage: {
        role: "assistant" as const,
        content: text,
        toolCalls: calls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input),
        })),
      },
      ...(usage ? { usage } : {}),
    };
  }
}
