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

  constructor(runLimit: BudgetLimit, models: readonly ModelBudgetConfig[]) {
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

  snapshot() {
    const account = this.total;
    return {
      chargedTokens: account.chargedTokens,
      reservedTokens: account.heldTokens,
      calls: account.calls,
      inFlight: account.inFlight,
      unmeteredCalls: this.unmeteredCalls,
      stopped: this.stopped,
      committedCostNanoUsd: (account.chargedCost + account.heldCost).toString(),
    };
  }
}
