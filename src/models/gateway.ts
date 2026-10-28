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
  /** One deadline for queue wait, provider attempts, and retry delays. Defaults to 45 seconds. */
  requestTimeoutMs?: number;
  /** Native protocol; omitted means OpenAI Chat Completions-compatible. */
  protocol?: "openai-compatible" | "anthropic";
}

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      refusal?: string | null;
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

interface AnthropicResponse {
  content?: Array<
    | { type: "text"; text?: string }
    | { type: "tool_use"; id?: string; name?: string; input?: unknown }
  >;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
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

    // Brain route adapter supplies a JSON context envelope and expects a
    // machine-readable object. Ask Gemini's OpenAI-compatible endpoint for
    // JSON mode on those internal Brain calls only; keep ordinary chat replies
    // as natural language and do not combine JSON mode with tool calling.
    let brainStructuredOutput = false;
    if (request.context) {
      try {
        const contextValue: unknown = JSON.parse(request.context);
        brainStructuredOutput = Boolean(
          contextValue && typeof contextValue === "object" &&
          !Array.isArray(contextValue) &&
          "phase" in contextValue &&
          "instructions" in contextValue &&
          "acceptanceCriteria" in contextValue
        );
      } catch {
        brainStructuredOutput = false;
      }
    }

    const isAnthropic = config.protocol === "anthropic";
    let body: Record<string, unknown>;
    if (isAnthropic) {
      const systemText = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const anthropicMessages = messages
        .filter((message) => message.role !== "system")
        .map((message) => {
          if (message.role === "tool") {
            return {
              role: "user",
              content: [{
                type: "tool_result",
                tool_use_id: message.toolCallId ?? "missing-tool-call-id",
                content: message.content,
              }],
            };
          }
          if (message.role === "assistant" && message.toolCalls?.length) {
            const content: Array<Record<string, unknown>> = [];
            if (message.content.trim()) content.push({ type: "text", text: message.content });
            for (const call of message.toolCalls) {
              let input: unknown = {};
              try { input = JSON.parse(call.arguments); } catch { input = {}; }
              content.push({
                type: "tool_use",
                id: call.id,
                name: call.name,
                input: input && typeof input === "object" && !Array.isArray(input) ? input : {},
              });
            }
            return { role: "assistant", content };
          }
          return { role: message.role === "assistant" ? "assistant" : "user", content: message.content };
        });
      body = {
        model: config.model,
        max_tokens: options.maxOutputTokens ?? 2048,
        messages: anthropicMessages,
        ...(systemText || brainStructuredOutput
          ? { system: [systemText, brainStructuredOutput ? "For this internal agent operation, respond with a single valid JSON object only. Do not wrap it in Markdown fences." : ""].filter(Boolean).join("\n\n") }
          : {}),
        ...(tools ? {
          tools: tools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters,
          })),
        } : {}),
      };
    } else {
      body = {
        model: config.model,
        messages,
        ...(tools ? { tools, tool_choice: "auto" } : {}),
        ...(!tools && brainStructuredOutput ? { response_format: { type: "json_object" } } : {}),
        ...(options.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {}),
      };
    }

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

    const execute = async () => {
      const maxAttempts = 3;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let retryableFailure = false;
        try {
          const response = await fetch(
            config.baseUrl.replace(/\/$/, "") + (isAnthropic ? "/messages" : "/chat/completions"),
            {
              method: "POST",
              headers: {
                ...config.headers,
                ...(isAnthropic
                  ? { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }
                  : { authorization: "Bearer " + config.apiKey }),
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
              signal: requestSignal,
            },
          );
          if (response.ok) {
            // Do not close a half-open circuit until the payload has been validated.
            return response;
          }
          const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
          retryableFailure = retryable;
          // Provider error bodies are untrusted and may echo prompts, request
          // metadata, or credentials. Do not copy them into exceptions/logs.
          void response.body?.cancel().catch(() => undefined);
          lastError = new Error(`Model gateway request failed (${response.status}).`);
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
        circuit.failures++;
        if (circuit.failures >= 3 || circuit.openedAt) {
          circuit.openedAt = Date.now();
          route.healthy = false;
        }
      }
      throw error;
    }

    if (!response.ok) {
      // Keep the same redaction policy for any future path that returns a
      // non-2xx response past the retry loop.
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`Model gateway request failed (${response.status}).`);
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
      const payload: unknown = await response.json();
      if (isAnthropic) {
        const anthropic = payload as AnthropicResponse;
        const blocks = Array.isArray(anthropic.content) ? anthropic.content : [];
        const textContent = blocks
          .filter((block): block is { type: "text"; text?: string } => block.type === "text")
          .map((block) => block.text ?? "")
          .filter((part) => part.trim().length > 0)
          .join("\n");
        const toolCalls = blocks
          .filter((block): block is { type: "tool_use"; id?: string; name?: string; input?: unknown } => block.type === "tool_use")
          .map((block) => ({
            id: block.id,
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input && typeof block.input === "object" && !Array.isArray(block.input) ? block.input : {}),
            },
          }));
        data = {
          choices: [{
            finish_reason: anthropic.stop_reason ?? null,
            message: { content: textContent, tool_calls: toolCalls },
          }],
          usage: {
            prompt_tokens: anthropic.usage?.input_tokens,
            completion_tokens: anthropic.usage?.output_tokens,
          },
        };
      } else {
        data = payload as ChatResponse;
      }
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

    // Gemini's OpenAI-compatible endpoint can return content as typed parts,
    // not only a plain string. Normalize text parts without logging provider
    // payloads (which may contain user data or secrets).
    const text = typeof message.content === "string"
      ? message.content.trim()
      : Array.isArray(message.content)
        ? message.content
            .filter((part): part is { type?: string; text: string } =>
              typeof part?.text === "string" && part.text.trim().length > 0)
            .map((part) => part.text.trim())
            .join("\n")
        : "";

    if (!text && !calls.length) {
      if (message.refusal?.trim()) {
        return failResponse("Model gateway returned a refusal response.");
      }
      const finishReason = data.choices?.[0]?.finish_reason;
      return failResponse(
        finishReason
          ? `Model gateway returned no usable content (finish_reason=${finishReason}).`
          : "Model gateway returned an empty response.",
      );
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
