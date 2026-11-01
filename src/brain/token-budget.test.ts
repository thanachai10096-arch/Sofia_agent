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


test("settled token budget snapshots restore cumulative run and per-model limits", () => {
  const original = budget();
  original.reserve("internal-pool", { inputTokens: 7, outputTokens: 3 }).settle({
    inputTokens: 5,
    outputTokens: 2,
  });
  const saved = original.snapshot();
  const restored = new TokenBudget(limit(), [{
    key: "internal-pool",
    limit: limit(),
    price: { inputNanoUsdPerToken: 1n, outputNanoUsdPerToken: 4n },
  }], saved);

  assert.deepEqual(restored.snapshot(), saved);
  assert.throws(() => {
    const constrained = new TokenBudget(limit(6), [{
      key: "internal-pool",
      limit: limit(6),
      price: { inputNanoUsdPerToken: 1n, outputNanoUsdPerToken: 4n },
    }], saved);
    constrained.reserve("internal-pool", { inputTokens: 1, outputTokens: 1 });
  }, /exceeds configured limits/);
});

test("restored stopped budget remains stopped and model set mismatches fail closed", () => {
  const original = budget();
  original.reserve("internal-pool", { inputTokens: 1, outputTokens: 1 }).settle();
  const saved = original.snapshot();

  const restored = new TokenBudget(limit(), [{
    key: "internal-pool",
    limit: limit(),
    price: { inputNanoUsdPerToken: 1n, outputNanoUsdPerToken: 4n },
  }], saved);
  assert.equal(restored.snapshot().stopped, true);
  assert.throws(() => restored.reserve("internal-pool", { inputTokens: 1, outputTokens: 1 }),
    (error: unknown) => error instanceof BudgetError && error.code === "run_stopped");

  assert.throws(() => new TokenBudget(limit(), [{
    key: "different-route",
    limit: limit(),
    price: { inputNanoUsdPerToken: 1n, outputNanoUsdPerToken: 4n },
  }], saved), /model set does not match/);
});


test("persisted budget snapshots do not disclose configured route identifiers", () => {
  const saved = budget().snapshot();
  assert.equal(saved.version, 2);
  assert.equal(Object.keys(saved.models).length, 1);
  assert.match(Object.keys(saved.models)[0]!, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(saved).includes("internal-pool"), false);

  const restored = new TokenBudget(limit(), [{
    key: "internal-pool",
    limit: limit(),
    price: { inputNanoUsdPerToken: 1n, outputNanoUsdPerToken: 4n },
  }], saved);
  assert.deepEqual(restored.snapshot(), saved);
});

test("legacy version-one budget snapshots remain readable", () => {
  const legacy = {
    version: 1 as const,
    total: { chargedTokens: 3, calls: 1, committedCostNanoUsd: "7" },
    models: {
      "internal-pool": { chargedTokens: 3, calls: 1, committedCostNanoUsd: "7" },
    },
    unmeteredCalls: 0,
    stopped: false,
  };
  const restored = new TokenBudget(limit(), [{
    key: "internal-pool",
    limit: limit(),
    price: { inputNanoUsdPerToken: 1n, outputNanoUsdPerToken: 4n },
  }], legacy);
  assert.equal(restored.snapshot().total.chargedTokens, 3);
});
