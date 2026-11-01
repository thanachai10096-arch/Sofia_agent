export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TokenPrice {
  inputNanoUsdPerToken: bigint;
  outputNanoUsdPerToken: bigint;
}

export interface BudgetLimit {
  maxTokens: number;
  maxCostNanoUsd: bigint;
  maxCalls: number;
  maxInFlight: number;
}

export interface ModelBudgetConfig {
  key: string;
  price: TokenPrice;
  limit: BudgetLimit;
}
export interface TokenBudgetAccountSnapshot {
  chargedTokens: number;
  calls: number;
  committedCostNanoUsd: string;
}
export interface TokenBudgetSnapshot {
  version: 1;
  total: TokenBudgetAccountSnapshot;
  models: Record<string, TokenBudgetAccountSnapshot>;
  unmeteredCalls: number;
  stopped: boolean;
}

export class BudgetError extends Error {
  constructor(
    readonly code:
      | "run_stopped"
      | "token_limit"
      | "cost_limit"
      | "call_limit"
      | "concurrency_limit",
  ) {
    super(code);
    this.name = "BudgetError";
  }
}

interface Account {
  limit: BudgetLimit;
  chargedTokens: number;
  heldTokens: number;
  chargedCost: bigint;
  heldCost: bigint;
  calls: number;
  inFlight: number;
}

export interface Settlement {
  readonly usageKnown: boolean;
  readonly capExceeded: boolean;
}

export interface Reservation {
  settle(actual?: TokenUsage): Settlement;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isTokenUsage(value: unknown): value is TokenUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  return (
    nonNegativeInteger(input) &&
    nonNegativeInteger(output) &&
    Number.isSafeInteger(input + output)
  );
}

function createAccount(limit: BudgetLimit): Account {
  if (
    !nonNegativeInteger(limit.maxTokens) ||
    !nonNegativeInteger(limit.maxCalls) ||
    !nonNegativeInteger(limit.maxInFlight) ||
    typeof limit.maxCostNanoUsd !== "bigint" ||
    limit.maxCostNanoUsd < 0n
  ) {
    throw new Error("Invalid budget configuration");
  }

  return {
    limit: { ...limit },
    chargedTokens: 0,
    heldTokens: 0,
    chargedCost: 0n,
    heldCost: 0n,
    calls: 0,
    inFlight: 0,
  };
}

function costOf(usage: TokenUsage, price: TokenPrice): bigint {
  return (
    BigInt(usage.inputTokens) * price.inputNanoUsdPerToken +
    BigInt(usage.outputTokens) * price.outputNanoUsdPerToken
  );
}

export class TokenBudget {
  private readonly total: Account;
  private readonly models = new Map<string, { account: Account; price: TokenPrice }>();
  private stopped = false;
  private unmeteredCalls = 0;

  constructor(runLimit: BudgetLimit, models: readonly ModelBudgetConfig[], restored?: TokenBudgetSnapshot) {
    this.total = createAccount(runLimit);

    for (const model of models) {
      if (!model.key || this.models.has(model.key)) {
        throw new Error("Missing or duplicate internal budget key");
      }

      const price = { ...model.price };
      if (
        typeof price.inputNanoUsdPerToken !== "bigint" ||
        typeof price.outputNanoUsdPerToken !== "bigint" ||
        price.inputNanoUsdPerToken < 0n ||
        price.outputNanoUsdPerToken < 0n
      ) {
        throw new Error("Invalid internal pricing");
      }

      this.models.set(model.key, {
        account: createAccount(model.limit),
        price,
      });
    }
    if (restored) this.restore(restored);
  }

  private restore(snapshot: TokenBudgetSnapshot): void {
    if (snapshot.version !== 1 || !nonNegativeInteger(snapshot.unmeteredCalls) ||
        typeof snapshot.stopped !== "boolean" || !snapshot.total ||
        !snapshot.models || typeof snapshot.models !== "object" || Array.isArray(snapshot.models)) {
      throw new Error("Invalid token budget snapshot");
    }
    const restoreAccount = (account: Account, saved: TokenBudgetAccountSnapshot) => {
      if (!saved || !nonNegativeInteger(saved.chargedTokens) || !nonNegativeInteger(saved.calls) ||
          typeof saved.committedCostNanoUsd !== "string" || !/^(0|[1-9][0-9]*)$/.test(saved.committedCostNanoUsd)) {
        throw new Error("Invalid token budget account snapshot");
      }
      const cost = BigInt(saved.committedCostNanoUsd);
      if (saved.chargedTokens > account.limit.maxTokens || saved.calls > account.limit.maxCalls ||
          cost > account.limit.maxCostNanoUsd) throw new Error("Restored token budget exceeds configured limits");
      account.chargedTokens = saved.chargedTokens;
      account.calls = saved.calls;
      account.chargedCost = cost;
    };
    const savedKeys = Object.keys(snapshot.models).sort();
    const configuredKeys = [...this.models.keys()].sort();
    if (savedKeys.length !== configuredKeys.length || savedKeys.some((key, i) => key !== configuredKeys[i])) {
      throw new Error("Restored token budget model set does not match configuration");
    }
    restoreAccount(this.total, snapshot.total);
    for (const [key, saved] of Object.entries(snapshot.models)) {
      const model = this.models.get(key);
      if (!model) throw new Error("Unknown model in token budget snapshot");
      restoreAccount(model.account, saved);
    }
    this.unmeteredCalls = snapshot.unmeteredCalls;
    this.stopped = snapshot.stopped;
  }

  private model(key: string) {
    const model = this.models.get(key);
    if (!model) throw new Error("Unregistered internal budget");
    return model;
  }

  estimate(key: string, usage: TokenUsage): bigint {
    if (!isTokenUsage(usage)) throw new Error("Invalid token estimate");
    return costOf(usage, this.model(key).price);
  }

  stop(): void {
    this.stopped = true;
  }

  reserve(key: string, maximum: TokenUsage): Reservation {
    if (this.stopped) throw new BudgetError("run_stopped");
    if (!isTokenUsage(maximum)) throw new Error("Invalid token reservation");

    const reserved = { ...maximum };
    const model = this.model(key);
    const accounts = [this.total, model.account];
    const tokens = reserved.inputTokens + reserved.outputTokens;
    const cost = costOf(reserved, model.price);

    for (const account of accounts) {
      const limit = account.limit;
      if (account.calls + 1 > limit.maxCalls) throw new BudgetError("call_limit");
      if (account.inFlight + 1 > limit.maxInFlight) throw new BudgetError("concurrency_limit");
      if (account.chargedTokens + account.heldTokens + tokens > limit.maxTokens) {
        throw new BudgetError("token_limit");
      }
      if (account.chargedCost + account.heldCost + cost > limit.maxCostNanoUsd) {
        throw new BudgetError("cost_limit");
      }
    }

    for (const account of accounts) {
      account.heldTokens += tokens;
      account.heldCost += cost;
      account.calls += 1;
      account.inFlight += 1;
    }

    let settlement: Settlement | undefined;

    return {
      settle: (actual?: TokenUsage): Settlement => {
        if (settlement) return settlement;

        const usageKnown = isTokenUsage(actual);
        const charged = usageKnown ? { ...actual } : reserved;
        const chargedTokens = charged.inputTokens + charged.outputTokens;
        const chargedCost = costOf(charged, model.price);
        const capExceeded =
          usageKnown &&
          charged.outputTokens > reserved.outputTokens;

        for (const account of accounts) {
          account.heldTokens -= tokens;
          account.heldCost -= cost;
          account.chargedTokens += chargedTokens;
          account.chargedCost += chargedCost;
          account.inFlight -= 1;
        }

        if (!usageKnown) this.unmeteredCalls += 1;
        if (!usageKnown || capExceeded) this.stop();

        settlement = Object.freeze({ usageKnown, capExceeded });
        return settlement;
      },
    };
  }

  snapshot(): TokenBudgetSnapshot {
    const save = (account: Account): TokenBudgetAccountSnapshot => ({
      chargedTokens: account.chargedTokens,
      calls: account.calls,
      committedCostNanoUsd: account.chargedCost.toString(),
    });
    return {
      version: 1,
      total: save(this.total),
      models: Object.fromEntries([...this.models].map(([key, model]) => [key, save(model.account)])),
      unmeteredCalls: this.unmeteredCalls,
      stopped: this.stopped,
    };
  }
}
