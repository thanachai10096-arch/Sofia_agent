import type { ModelProvider, ModelRequest, ModelRoute, TaskKind } from "../models/types.js";
import type { InternalRoute, PackedPrompt, PreparedCall, ProviderReply } from "./token-aware-gateway.js";

/**
 * Tokenizer-independent admission estimate. UTF-8 byte length is not a token
 * count: it multiplies Thai/CJK text by roughly 3. Estimate ASCII at 1 token
 * per 3 characters and non-ASCII at 1 token per code point. Provider-reported
 * usage remains authoritative after invocation; the reservation still fails
 * closed if actual usage exceeds the reserved cap.
 */
export function estimatePromptTokensUpperBound(value: unknown): number {
  const characters = Array.from(JSON.stringify(value));
  const nonAscii = characters.filter((character) => character.codePointAt(0)! > 0x7f).length;
  const ascii = characters.length - nonAscii;
  return Math.ceil(ascii / 3) + nonAscii;
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

function extractJsonDocument(text: string): string | undefined {
  const start = text.search(/[\[{]/);
  if (start < 0) return undefined;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const opening = stack.pop();
      if ((char === "}" && opening !== "{") || (char === "]" && opening !== "[")) return undefined;
      if (stack.length === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function parseStructured(value: unknown): unknown {
  if (typeof value !== "string") return value;
  let text = value.replace(/^\uFEFF/, "").trim();
  if (text.startsWith("```") && text.endsWith("```")) {
    text = text.slice(3, -3).replace(/^json\s*/i, "").trim();
  }
  try {
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch {
      const document = extractJsonDocument(text);
      if (!document) throw new Error("No complete JSON document");
      parsed = JSON.parse(document);
    }
    if (typeof parsed === "string") {
      const inner = parsed.trim();
      if (inner.startsWith("{") || inner.startsWith("[")) parsed = JSON.parse(inner);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Brain response must be a JSON object");
    }
    return parsed;
  } catch { throw new Error("Model returned non-JSON Brain output"); }
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
        inputTokensUpperBound: estimatePromptTokensUpperBound(request),
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
