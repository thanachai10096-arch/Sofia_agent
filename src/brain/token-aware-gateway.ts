import { randomUUID } from "node:crypto";

import {
  BudgetError,
  TokenBudget,
  type Reservation,
  type TokenUsage,
} from "./token-budget.js";

export type BrainPhase =
  | "understand"
  | "plan"
  | "replan"
  | "implement"
  | "diagnose"
  | "review"
  | "finalize"
  | "subagent";

export interface PromptCore {
  instructions: string;
  task: string;
  acceptanceCriteria: readonly string[];
  state: unknown;
  toolSchemas: readonly unknown[];
}

export interface EvidenceChunk {
  id: string;
  relevance: number;
  text: string;
}

export interface PackedPrompt {
  core: PromptCore;
  evidence: readonly EvidenceChunk[];
}

export interface ProviderReply {
  value: unknown;
  usage: TokenUsage;
  finishReason: "complete" | "length";
}

export interface PreparedCall {
  inputTokensUpperBound: number;
  invoke(options: {
    signal: AbortSignal;
    maxOutputTokens: number;
    requestId: string;
    maxAttempts: 1;
  }): Promise<ProviderReply>;
}

export interface InternalRoute {
  id: string;
  budgetKey: string;
  qualityTier: number;
  capabilities: readonly string[];
  contextWindow: number;
  maxOutputTokens: number;
  hardOutputCap: boolean;
  prepare(prompt: PackedPrompt): PreparedCall;
}

export interface InferenceRequest {
  phase: BrainPhase;
  minimumQualityTier: number;
  requiredCapabilities: readonly string[];
  core: PromptCore;
  evidence: readonly EvidenceChunk[];
}

export class MeteredProviderError extends Error {
  constructor(readonly usage: TokenUsage) {
    super("Provider request failed with known usage");
    this.name = "MeteredProviderError";
  }
}

export class GatewayError extends Error {
  constructor(
    readonly code:
      | "no_eligible_route"
      | "no_available_budget"
      | "cancelled_or_timed_out"
      | "invalid_usage"
      | "provider_cap_exceeded"
      | "incomplete_output"
      | "model_call_failed",
    readonly reason?: string,
  ) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = "GatewayError";
  }
}

function safeProviderFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const status = message.match(/Model gateway request failed \((\d{3})\)/i)?.[1];
  if (status) {
    const reasons: Record<string, string> = {
      "400": "provider_http_400_bad_request",
      "401": "provider_http_401_authentication_failed",
      "402": "provider_http_402_billing_or_credits",
      "403": "provider_http_403_access_denied",
      "404": "provider_http_404_model_or_endpoint_not_found",
      "408": "provider_http_408_request_timeout",
      "409": "provider_http_409_conflict",
      "413": "provider_http_413_request_too_large",
      "422": "provider_http_422_invalid_request",
      "429": "provider_http_429_rate_or_quota_limit",
      "500": "provider_http_500_server_error",
      "502": "provider_http_502_bad_gateway",
      "503": "provider_http_503_unavailable",
      "504": "provider_http_504_gateway_timeout",
    };
    return reasons[status] ?? `provider_http_${status}`;
  }
  if (/timed? ?out|timeout|aborted/i.test(message)) return "provider_timeout";
  if (/fetch failed|network|econnreset|enotfound|eai_again/i.test(message)) return "provider_network_error";
  const missingMessage = message.match(/Model gateway returned no message \\[shape=([a-zA-Z0-9_,:-]{1,180})\\]/i);
  if (missingMessage) return "provider_response_missing_message:" + missingMessage[1];
  if (/invalid json|empty response|non-json/i.test(message)) return "provider_invalid_response";
  return "provider_error";
}

class ContextTooLarge extends Error {}

interface PhaseCap {
  input: number;
  output: number;
}

const PHASE_CAPS: Record<BrainPhase, PhaseCap> = {
  understand: { input: 5_000, output: 700 },
  plan: { input: 8_000, output: 1_400 },
  replan: { input: 9_000, output: 1_800 },
  implement: { input: 14_000, output: 4_000 },
  diagnose: { input: 7_000, output: 900 },
  review: { input: 10_000, output: 1_100 },
  finalize: { input: 4_000, output: 600 },
  subagent: { input: 12_000, output: 1_200 },
};

function validateCount(prepared: PreparedCall): PreparedCall {
  if (
    !Number.isSafeInteger(prepared.inputTokensUpperBound) ||
    prepared.inputTokensUpperBound < 0
  ) {
    throw new Error("Invalid tokenizer result");
  }
  return prepared;
}

function packContext(
  route: InternalRoute,
  request: InferenceRequest,
  maxOutputTokens: number,
): PreparedCall {
  const inputLimit = Math.min(
    PHASE_CAPS[request.phase].input,
    route.contextWindow - maxOutputTokens,
  );

  if (inputLimit < 1) throw new ContextTooLarge();

  const selected: EvidenceChunk[] = [];
  const prepare = (evidence: readonly EvidenceChunk[]) =>
    validateCount(route.prepare({ core: request.core, evidence: [...evidence] }));

  let prepared = prepare(selected);
  if (prepared.inputTokensUpperBound > inputLimit) throw new ContextTooLarge();

  const seen = new Set<string>();
  const candidates = request.evidence
    .filter(
      (chunk) =>
        chunk.id.length > 0 &&
        Number.isFinite(chunk.relevance) &&
        chunk.relevance > 0 &&
        chunk.relevance <= 1 &&
        chunk.text.length <= 12_000,
    )
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 64);

  for (const chunk of candidates) {
    if (seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    const candidate = prepare([...selected, chunk]);
    if (candidate.inputTokensUpperBound <= inputLimit) {
      selected.push(chunk);
      prepared = candidate;
    }
  }

  return prepared;
}

function observeWithAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
  onAbort: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = () => signal.removeEventListener("abort", aborted);

    const aborted = () => {
      if (settled) return;
      settled = true;
      cleanup();
      onAbort();
      reject(new GatewayError("cancelled_or_timed_out"));
    };

    work.then(
      (value) => {
        if (settled) return;
        cleanup();
        if (signal.aborted) aborted();
        else {
          settled = true;
          resolve(value);
        }
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );

    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}

export class TokenAwareGateway {
  private readonly routeFailures = new Map<string, number>();

  constructor(
    private readonly budget: TokenBudget,
    private readonly routes: readonly InternalRoute[],
    private readonly timeoutMs = 45_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new Error("Invalid model timeout");
    }
  }

  async generate(
    request: InferenceRequest,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const result = await this.generateMetered(request, callerSignal);
    return result.value;
  }

  async generateMetered(
    request: InferenceRequest,
    callerSignal?: AbortSignal,
  ): Promise<{ value: unknown; usage: TokenUsage }> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeout])
      : timeout;

    signal.throwIfAborted();
    const input = structuredClone(request);

    const candidates: Array<{
      route: InternalRoute;
      prepared: PreparedCall;
      maxOutputTokens: number;
      score: bigint;
    }> = [];

    for (const route of this.routes) {
      const failures = this.routeFailures.get(route.id) ?? 0;

      if (
        !route.hardOutputCap ||
        failures >= 2 ||
        route.qualityTier < input.minimumQualityTier ||
        !input.requiredCapabilities.every((capability) =>
          route.capabilities.includes(capability),
        )
      ) {
        continue;
      }

      const maxOutputTokens = Math.min(
        PHASE_CAPS[input.phase].output,
        route.maxOutputTokens,
      );
      if (maxOutputTokens < 1) continue;

      try {
        const prepared = packContext(route, input, maxOutputTokens);
        const estimatedCost = this.budget.estimate(route.budgetKey, {
          inputTokens: prepared.inputTokensUpperBound,
          outputTokens: maxOutputTokens,
        });

        candidates.push({
          route,
          prepared,
          maxOutputTokens,
          score: estimatedCost * BigInt(1 + failures * 4),
        });
      } catch (error: unknown) {
        if (!(error instanceof ContextTooLarge)) throw error;
      }
    }

    candidates.sort((a, b) =>
      a.score < b.score ? -1 : a.score > b.score ? 1 : 0,
    );

    if (candidates.length === 0) throw new GatewayError("no_eligible_route");

    let chosen: (typeof candidates)[number] | undefined;
    let reservation: Reservation | undefined;

    for (const candidate of candidates) {
      try {
        signal.throwIfAborted();
        reservation = this.budget.reserve(candidate.route.budgetKey, {
          inputTokens: candidate.prepared.inputTokensUpperBound,
          outputTokens: candidate.maxOutputTokens,
        });
        chosen = candidate;
        break;
      } catch (error: unknown) {
        if (!(error instanceof BudgetError)) throw error;
        if (error.code === "run_stopped") throw error;
      }
    }

    if (!chosen || !reservation) throw new GatewayError("no_available_budget");

    const selection = chosen;
    const lease = reservation;

    const work = (async (): Promise<{ value: unknown; usage: TokenUsage }> => {
      if (signal.aborted) {
        lease.settle({ inputTokens: 0, outputTokens: 0 });
        throw new GatewayError("cancelled_or_timed_out");
      }

      try {
        const reply = await selection.prepared.invoke({
          signal,
          maxOutputTokens: selection.maxOutputTokens,
          requestId: randomUUID(),
          maxAttempts: 1,
        });

        const settled = lease.settle(reply.usage);
        if (!settled.usageKnown) throw new GatewayError("invalid_usage");
        if (settled.capExceeded) throw new GatewayError("provider_cap_exceeded");
        if (reply.finishReason !== "complete") throw new GatewayError("incomplete_output");

        return { value: reply.value, usage: reply.usage };
      } catch (error: unknown) {
        lease.settle(error instanceof MeteredProviderError ? error.usage : undefined);

        if (!signal.aborted) {
          const id = selection.route.id;
          this.routeFailures.set(id, (this.routeFailures.get(id) ?? 0) + 1);
        }

        if (error instanceof GatewayError) throw error;
        // Preserve only a bounded, allowlisted diagnostic category. Never forward
        // provider response bodies because they can contain secrets or user data.
        throw new GatewayError("model_call_failed", safeProviderFailureReason(error));
      }
    })();

    return observeWithAbort(work, signal, () => {
      // Settle the outstanding reservation at its full reserved amount when provider
      // usage is unknown. This releases in-flight capacity without undercounting cost.
      lease.settle();
      this.budget.stop();
    });
  }
}
