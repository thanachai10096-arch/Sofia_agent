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
  headers?: Record<string, string>;
  maxConcurrent?: number;
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

class ConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<{ resolve: () => void; signal?: AbortSignal }> = [];
  constructor(private readonly limit: number) {}
  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const waiter = { resolve, ...(signal ? { signal } : {}) };
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal!.reason ?? new Error("Request aborted."));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waiters.push(waiter);
      });
    }
    if (signal?.aborted) throw signal.reason ?? new Error("Request aborted.");
    this.active++;
    try { return await operation(); }
    finally {
      this.active--;
      const next = this.waiters.shift();
      next?.resolve();
    }
  }
}

interface CircuitState { failures: number; openedAt: number; }

export class SofiaModelGateway implements ModelProvider {
  private readonly gates = new Map<string, ConcurrencyGate>();
  private readonly circuits = new Map<string, CircuitState>();

  constructor(
    private readonly providers: Record<string, GatewayProviderConfig>,
  ) {
    for (const [id, config] of Object.entries(providers)) this.gates.set(id, new ConcurrencyGate(Math.max(1, config.maxConcurrent ?? 8)));
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
            role: "system",
            content:
              "You are Sofia, a general-purpose software agent. Use available tools when they help accomplish the task. Never reveal internal model routing.",
          },
          { role: "user", content: request.task },
          ...(request.context
            ? [
                {
                  role: "user",
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
    const gate = this.gates.get(providerId);
    const circuit = this.circuits.get(providerId) ?? { failures: 0, openedAt: 0 };
    this.circuits.set(providerId, circuit);

    if (circuit.openedAt && Date.now() - circuit.openedAt < 15_000) {
      throw new Error(`Model provider ${providerId} temporarily unavailable.`);
    }
    if (circuit.openedAt) circuit.openedAt = 0;

    const execute = async () => {
      const maxAttempts = 3;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const timeoutMs = 45_000;
        const signal = options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs);
        try {
          const response = await fetch(
            config.baseUrl.replace(/\\/$/, "") + "/chat/completions",
            {
              method: "POST",
              headers: {
                authorization: "Bearer " + config.apiKey,
                "content-type": "application/json",
                ...config.headers,
              },
              body: JSON.stringify(body),
              signal,
            },
          );
          if (response.ok) {
            circuit.failures = 0;
            circuit.openedAt = 0;
            return response;
          }
          const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
          const detail = await response.text();
          lastError = new Error(`Model gateway request failed (${response.status}): ${detail.slice(0, 500)}`);
          if (!retryable || attempt === maxAttempts || options.signal?.aborted) throw lastError;
          const retryAfter = Number(response.headers.get("retry-after") ?? "");
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 5_000)
            : Math.min(250 * 2 ** (attempt - 1), 2_000) + Math.floor(Math.random() * 100);
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, delay);
            options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(options.signal!.reason); }, { once: true });
          });
        } catch (error) {
          lastError = error;
          if (options.signal?.aborted || attempt === maxAttempts) throw error;
          await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 2_000)));
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Model provider request failed.");
    };

    let response: Response;
    try {
      response = await (gate ? gate.run(execute, options.signal) : execute());
    } catch (error) {
      circuit.failures++;
      if (circuit.failures >= 3) circuit.openedAt = Date.now();
      throw error;
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Model gateway request failed (${response.status}): ${detail.slice(0, 500)}`,
      );
    }

    const data = (await response.json()) as ChatResponse;
    const message = data.choices?.[0]?.message;

    if (!message) {
      throw new Error("Model gateway returned no message.");
    }

    const calls = (message.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `call-${request.step}-${index}`,
      name: call.function?.name ?? "",
      input: JSON.parse(call.function?.arguments ?? "{}") as Record<
        string,
        unknown
      >,
    }));

    const text = message.content?.trim() ?? "";

    if (!text && !calls.length) {
      throw new Error("Model gateway returned an empty response.");
    }

    const inputTokens = data.usage?.prompt_tokens;
    const outputTokens = data.usage?.completion_tokens;

    return {
      text,
      toolCalls: calls.length ? calls : undefined,
      assistantMessage: {
        role: "assistant",
        content: text,
        toolCalls: calls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input),
        })),
      },
      ...(Number.isSafeInteger(inputTokens) &&
      inputTokens >= 0 &&
      Number.isSafeInteger(outputTokens) &&
      outputTokens >= 0
        ? { usage: { inputTokens, outputTokens } }
        : {}),
    };
  }
}
