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
    diagnostic?: string,
  ) {
    super(diagnostic ? `${code}: ${diagnostic}` : code);
    this.name = "GatewayError";
  }
}

// Log only a coarse, allowlisted provider failure classification. Never propagate
// provider response bodies, URLs, request payloads, or credentials into run logs.
export function classifyProviderFailure(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_provider_error";
  const message = error.message;
  const status = message.match(/Model gateway request failed \((\d{3})\)/i)?.[1];
  if (status) {
    const code = Number(status);
    if (code === 401 || code === 403) return `provider_http_${code}_auth_or_access`;
    if (code === 404) {
      // Use only allowlisted classifications from provider text. Never emit the
      // provider body, URL, request payload, or credentials into run logs.
      if (/model[^\n]{0,160}(not found|does not exist|not available)|not found[^\n]{0,160}model/i.test(message)) {
        return "provider_http_404_model_not_found";
      }
      if (/(endpoint|route|path)[^\n]{0,160}(not found|does not exist)|not found[^\n]{0,160}(endpoint|route|path)/i.test(message)) {
        return "provider_http_404_endpoint_not_found";
      }
      return "provider_http_404_endpoint_or_model";
    }
    if (code === 402) {
      if (/free[-_ ]models?[-_ ]per[-_ ]day|free[-_ ]model.*daily|daily.*free[-_ ]model/i.test(message)) {
        return "provider_http_402_free_model_daily_limit";
      }
      if (/in_flight_budget_exhausted|in.flight.{0,40}budget/i.test(message)) {
        return "provider_http_402_in_flight_budget";
      }
      if (/negative balance|insufficient credits|limit_source.{0,80}openrouter_credits|credit.{0,80}(exhaust|insufficient|limit)/i.test(message)) {
        return "provider_http_402_insufficient_credits";
      }
      return "provider_http_402_payment_or_credit_required";
    }
    if (code === 429) return "provider_http_429_rate_or_quota_limit";
    if (code >= 500) return `provider_http_${code}_server_error`;
    return `provider_http_${code}_request_rejected`;
  }
  if (/timed? ?out|timeout|abort/i.test(message)) return "provider_timeout";
  if (/fetch failed|network|econn|enotfound|eai_again/i.test(message)) return "provider_network_error";
  if (/invalid json/i.test(message)) return "provider_invalid_json";
  if (/no message|empty response/i.test(message)) return "provider_empty_response";
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
        throw new GatewayError("model_call_failed", classifyProviderFailure(error));
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
