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
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    try { return await operation(); } finally { this.active--; this.waiters.shift()?.(); }
  }
}

export class SofiaModelGateway implements ModelProvider {
  private readonly gates = new Map<string, ConcurrencyGate>();

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
    const execute = () => fetch(
      config.baseUrl.replace(/\/$/, "") + "/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + config.apiKey,
          "content-type": "application/json",
          ...config.headers,
        },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    const response = await (gate ? gate.run(execute) : execute());

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
