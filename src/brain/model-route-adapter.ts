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
      return "reasoning";
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
  const text = value.trim();

  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/^\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`$/i);
    if (fenced) return JSON.parse(fenced[1]);
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
            finishReason: "complete",
          };
        },
      };
    },
  };
}
