import { TextEncoder } from "node:util";

import type { ModelProvider, ModelRequest, ModelRoute, TaskKind } from "../models/types.js";
import type { InternalRoute, PackedPrompt, PreparedCall, ProviderReply } from "./token-aware-gateway.js";

const encoder = new TextEncoder();

function upperBoundTokens(value: unknown): number {
  const text = JSON.stringify(value);
  return encoder.encode(text).byteLength;
}

function taskKindForPhase(phase: string): TaskKind {
  switch (phase) {
    case "implement":
    case "diagnose":
      return "coding";
    case "understand":
    case "plan":
    case "review":
      return "analysis";
    default:
      return "general";
  }
}

function parsePhase(prompt: PackedPrompt): string {
  const state = prompt.core.state;
  if (state && typeof state === "object" && "phase" in state) {
    const phase = (state as { phase?: unknown }).phase;
    if (typeof phase === "string") return phase;
  }
  return "implement";
}

function parseStructured(value: unknown): unknown {
  if (typeof value !== "string") return value;
  let text = value.trim();

  const fenced = text.match(/^\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`$/i);
  if (fenced) text = (fenced[1] ?? "").trim();

  try {
    let parsed: unknown = JSON.parse(text);
    // Some OpenAI-compatible providers return JSON encoded as a JSON string.
    // Decode that extra wrapper without coercing primitives or arbitrary text.
    if (typeof parsed === "string") {
      const inner = parsed.trim();
      if (inner.startsWith("{") || inner.startsWith("[")) {
        parsed = JSON.parse(inner);
      }
    }
    return parsed;
  } catch {
    throw new Error("Model returned non-JSON Brain output");
  }
}

export interface InternalRouteAdapterOptions {
  modelProvider: ModelProvider;
  route: ModelRoute;
  taskKind?: TaskKind;
}

export function createInternalRoute(
  options: InternalRouteAdapterOptions,
): InternalRoute {
  const { modelProvider, route } = options;

  return {
    id: route.id,
    budgetKey: route.providerId ?? route.id,
    qualityTier: Math.max(1, Math.round(route.qualityWeight)),
    costWeight: route.costWeight,
    latencyWeight: route.latencyWeight,
    qualityWeight: route.qualityWeight,
    capabilities: route.capabilities,
    contextWindow: Number(process.env["SOFIA_" + route.id.toUpperCase() + "_CONTEXT"] ?? 32_000),
    maxOutputTokens: Number(process.env["SOFIA_" + route.id.toUpperCase() + "_MAX_OUTPUT"] ?? 4_096),
    hardOutputCap: true,

    prepare(prompt: PackedPrompt): PreparedCall {
      const phase = parsePhase(prompt);
      const kind = options.taskKind ?? taskKindForPhase(phase);
      const request: ModelRequest = {
        task: prompt.core.task,
        kind,
        step: 1,
        context: JSON.stringify({
          phase,
          instructions: prompt.core.instructions,
          acceptanceCriteria: prompt.core.acceptanceCriteria,
          state: prompt.core.state,
          evidence: prompt.evidence,
        }),
        tools: prompt.core.toolSchemas as ModelRequest["tools"],
      };

      return {
        inputTokensUpperBound: upperBoundTokens(request),
        invoke: async ({ signal, maxOutputTokens }): Promise<ProviderReply> => {
          const response = await modelProvider.generate(request, route, {
            signal,
            maxOutputTokens,
          });

          if (!response.usage) {
            throw new Error("Provider did not return token usage");
          }

          return {
            value: parseStructured(response.text),
            usage: response.usage,
            retries: response.retries ?? 0,
            finishReason: "complete",
          };
        },
      };
    },
  };
}
