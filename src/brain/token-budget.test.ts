import assert from "node:assert/strict";
import test from "node:test";

import {
  BudgetError,
  TokenBudget,
  type BudgetLimit,
} from "./token-budget.js";

function limit(maxTokens = 10_000): BudgetLimit {
  return {
    maxTokens,
    maxCostNanoUsd: 1_000_000n,
    maxCalls: 20,
    maxInFlight: 4,
  };
}

function budget(runTokens = 10_000, modelTokens = 10_000): TokenBudget {
  return new TokenBudget(limit(runTokens), [
    {
      key: "internal-pool",
      limit: limit(modelTokens),
      price: {
        inputNanoUsdPerToken: 1n,
        outputNanoUsdPerToken: 4n,
      },
    },
  ]);
}

test("parallel reservations cannot spend the same tokens twice", () => {
  const ledger = budget(30);

  ledger.reserve("internal-pool", {
    inputTokens: 10,
    outputTokens: 10,
  });

  assert.throws(
    () =>
      ledger.reserve("internal-pool", {
        inputTokens: 10,
        outputTokens: 10,
      }),
    (error: unknown) =>
      error instanceof BudgetError && error.code === "token_limit",
  );

  assert.equal(ledger.snapshot().reservedTokens, 20);
  assert.equal(ledger.snapshot().calls, 1);
});

test("settlement refunds unused tokens and cannot charge twice", () => {
  const ledger = budget();

  const lease = ledger.reserve("internal-pool", {
    inputTokens: 10,
    outputTokens: 10,
  });

  lease.settle({ inputTokens: 4, outputTokens: 2 });
  lease.settle({ inputTokens: 4, outputTokens: 2 });

  const snapshot = ledger.snapshot();

  assert.equal(snapshot.chargedTokens, 6);
  assert.equal(snapshot.reservedTokens, 0);
  assert.equal(snapshot.inFlight, 0);
  assert.equal(snapshot.committedCostNanoUsd, "12");
});

test("unknown usage charges the reservation and stops further calls", () => {
  const ledger = budget();

  const lease = ledger.reserve("internal-pool", {
    inputTokens: 10,
    outputTokens: 10,
  });

  lease.settle();

  assert.equal(ledger.snapshot().chargedTokens, 20);
  assert.equal(ledger.snapshot().unmeteredCalls, 1);
  assert.equal(ledger.snapshot().stopped, true);

  assert.throws(
    () =>
      ledger.reserve("internal-pool", {
        inputTokens: 1,
        outputTokens: 1,
      }),
    (error: unknown) =>
      error instanceof BudgetError && error.code === "run_stopped",
  );
});

test("known output overrun is fully charged and stops the budget", () => {
  const ledger = budget();

  const lease = ledger.reserve("internal-pool", {
    inputTokens: 10,
    outputTokens: 10,
  });

  const settlement = lease.settle({
    inputTokens: 10,
    outputTokens: 11,
  });

  assert.equal(settlement.usageKnown, true);
  assert.equal(settlement.capExceeded, true);
  assert.equal(ledger.snapshot().chargedTokens, 21);
  assert.equal(ledger.snapshot().stopped, true);
});

test("call and concurrency limits are enforced before mutation", () => {
  const ledger = new TokenBudget(
    {
      maxTokens: 100,
      maxCostNanoUsd: 1_000n,
      maxCalls: 1,
      maxInFlight: 1,
    },
    [
      {
        key: "internal-pool",
        limit: {
          maxTokens: 100,
          maxCostNanoUsd: 1_000n,
          maxCalls: 1,
          maxInFlight: 1,
        },
        price: {
          inputNanoUsdPerToken: 1n,
          outputNanoUsdPerToken: 1n,
        },
      },
    ],
  );

  ledger.reserve("internal-pool", {
    inputTokens: 1,
    outputTokens: 1,
  });

  assert.throws(
    () =>
      ledger.reserve("internal-pool", {
        inputTokens: 1,
        outputTokens: 1,
      }),
    (error: unknown) =>
      error instanceof BudgetError && error.code === "call_limit",
  );

  assert.equal(ledger.snapshot().calls, 1);
  assert.equal(ledger.snapshot().inFlight, 1);
});
