import type { BrainReasoner, PreparedInference } from "./types.js";
import {
  TokenAwareGateway,
  type BrainPhase,
  type InferenceRequest,
} from "./token-aware-gateway.js";

function phaseFromRequest(request: string): BrainPhase {
  try {
    const parsed = JSON.parse(request) as { phase?: unknown };
    switch (parsed.phase) {
      case "understand":
      case "plan":
      case "replan":
      case "implement":
      case "diagnose":
      case "review":
      case "finalize":
        return parsed.phase;
      default:
        return "implement";
    }
  } catch {
    return "implement";
  }
}

function asInferenceRequest(request: string): InferenceRequest {
  const parsed = JSON.parse(request) as {
    phase?: unknown;
    payload?: Record<string, unknown>;
  };

  const payload = parsed.payload ?? {};
  const understanding = payload.understanding as Record<string, unknown> | undefined;

  return {
    phase: phaseFromRequest(request),
    minimumQualityTier:
      typeof payload.minimumQualityTier === "number"
        ? payload.minimumQualityTier
        : 1,
    requiredCapabilities: Array.isArray(payload.requiredCapabilities)
      ? payload.requiredCapabilities.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    core: {
      instructions:
        "Return only the structured value required by this Brain phase. Do not claim tool execution.",
      task:
        typeof payload.task === "string"
          ? payload.task
          : "Execute the requested Brain phase.",
      acceptanceCriteria: Array.isArray(understanding?.successCriteria)
        ? understanding.successCriteria.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      state: payload,
      toolSchemas: [],
    },
    evidence: [],
  };
}

export class TokenAwareBrainReasoner implements BrainReasoner {
  constructor(private readonly gateway: TokenAwareGateway) {}

  async prepare(
    request: string,
    options: {
      signal: AbortSignal;
      maxContextTokens: number;
    },
  ): Promise<PreparedInference> {
    if (options.signal.aborted) {
      options.signal.throwIfAborted();
    }

    const parsed = JSON.parse(request) as { phase?: unknown };
    const input = asInferenceRequest(request);
    if (typeof parsed.phase === "string") {
      input.core = {
        ...input.core,
        state: {
          ...(input.core.state && typeof input.core.state === "object"
            ? input.core.state
            : {}),
          phase: parsed.phase,
        },
      };
    }

    // Preparation is deliberately local. The gateway performs the real
    // tokenizer-bound reservation immediately before provider invocation.
    return {
      inputTokens: Math.min(
        options.maxContextTokens,
        1,
      ),
      invoke: async (invokeOptions) => {
        const result = await this.gateway.generateMetered(
          input,
          invokeOptions.signal,
        );

        return {
          value: result.value,
          usage: result.usage,
        };
      },
    };
  }
}
