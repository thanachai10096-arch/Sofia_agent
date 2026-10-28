import assert from "node:assert/strict";
import test from "node:test";

import { TokenBudget } from "./token-budget.js";
import {
  GatewayError,
  TokenAwareGateway,
  type InferenceRequest,
  type InternalRoute,
  type ProviderReply,
} from "./token-aware-gateway.js";

function request(): InferenceRequest {
  return {
    phase: "plan",
    minimumQualityTier: 1,
    requiredCapabilities: ["structured-output"],
    core: {
      instructions: "Return JSON only.",
      task: "Create a plan.",
      acceptanceCriteria: [],
      state: {},
      toolSchemas: [],
    },
    evidence: [],
  };
}

function route(invoke: () => Promise<ProviderReply>): InternalRoute {
  return {
    id: "test-route",
    budgetKey: "test",
    qualityTier: 1,
    capabilities: ["structured-output"],
    contextWindow: 2_000,
    maxOutputTokens: 50,
    hardOutputCap: true,
    prepare() {
      return {
        // Leave room for the measured usage used by the default route fixtures.
        inputTokensUpperBound: 20,
        invoke,
      };
    },
  };
}

function makeBudget(maxTokens = 1_000) {
  return new TokenBudget(
    {
      maxTokens,
      maxCostNanoUsd: 1_000_000n,
      maxCalls: 10,
      maxInFlight: 1,
    },
    [
      {
        key: "test",
        limit: {
          maxTokens,
          maxCostNanoUsd: 1_000_000n,
          maxCalls: 10,
          maxInFlight: 1,
        },
        price: {
          inputNanoUsdPerToken: 1n,
          outputNanoUsdPerToken: 2n,
        },
      },
    ],
  );
}

test("gateway meters actual provider usage exactly once", async () => {
  const budget = makeBudget();
  let calls = 0;

  const gateway = new TokenAwareGateway(
    budget,
    [
      route(async () => {
        calls += 1;
        return {
          value: { steps: [] },
          usage: { inputTokens: 13, outputTokens: 7 },
          finishReason: "complete",
        };
      }),
    ],
  );

  const value = await gateway.generate(request());

  assert.deepEqual(value, { steps: [] });
  assert.equal(calls, 1);
  assert.equal(budget.snapshot().chargedTokens, 20);
  assert.equal(budget.snapshot().reservedTokens, 0);
});

test("metered inference preserves successful provider retry counts", async () => {
  const gateway = new TokenAwareGateway(
    makeBudget(),
    [route(async () => ({
      value: { ok: true },
      usage: { inputTokens: 12, outputTokens: 4 },
      retries: 2,
      finishReason: "complete",
    }))],
  );

  const result = await gateway.generateMetered(request());
  assert.deepEqual(result, {
    value: { ok: true },
    usage: { inputTokens: 12, outputTokens: 4 },
    retries: 2,
  });
});

test("gateway rejects incomplete provider output without retrying", async () => {
  const budget = makeBudget();
  let calls = 0;

  const gateway = new TokenAwareGateway(
    budget,
    [
      route(async () => {
        calls += 1;
        return {
          value: { partial: true },
          usage: { inputTokens: 10, outputTokens: 5 },
          finishReason: "length",
        };
      }),
    ],
  );

  await assert.rejects(
    gateway.generate(request()),
    (error: unknown) =>
      error instanceof GatewayError && error.code === "incomplete_output",
  );

  assert.equal(calls, 1);
  assert.equal(budget.snapshot().chargedTokens, 15);
});

test("gateway stops when provider usage exceeds the reserved cap", async () => {
  const budget = makeBudget();

  const gateway = new TokenAwareGateway(
    budget,
    [
      route(async () => ({
        value: { ok: true },
        usage: { inputTokens: 10, outputTokens: 51 },
        finishReason: "complete",
      })),
    ],
  );

  await assert.rejects(
    gateway.generate(request()),
    (error: unknown) =>
      error instanceof GatewayError && error.code === "provider_cap_exceeded",
  );

  assert.equal(budget.snapshot().stopped, true);
});

test("gateway stops when actual input usage exceeds its reservation", async () => {
  const budget = makeBudget();
  const gateway = new TokenAwareGateway(
    budget,
    [route(async () => ({
      value: { shouldNotBeAccepted: true },
      usage: { inputTokens: 21, outputTokens: 1 },
      finishReason: "complete",
    }))],
  );

  await assert.rejects(
    gateway.generate(request()),
    (error: unknown) =>
      error instanceof GatewayError && error.code === "provider_cap_exceeded",
  );

  assert.equal(budget.snapshot().chargedTokens, 22);
  assert.equal(budget.snapshot().stopped, true);
});


test("gateway releases reserved budget and propagates caller cancellation", async () => {
  const budget = makeBudget();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const controller = new AbortController();
  const gateway = new TokenAwareGateway(budget, [
    route(async () => {
      started();
      return new Promise<ProviderReply>(() => undefined);
    }),
  ], 5_000);

  const pending = gateway.generate(request(), controller.signal);
  await entered;
  controller.abort();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof GatewayError && error.code === "cancelled_or_timed_out");
  assert.equal(budget.snapshot().reservedTokens, 0);
  assert.equal(budget.snapshot().inFlight, 0);
  assert.equal(budget.snapshot().stopped, true);
});

test("gateway fails closed when no route satisfies the requested capabilities", async () => {
  const budget = makeBudget();
  const incapable = route(async () => ({
    value: { shouldNotRun: true },
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "complete",
  }));
  const gateway = new TokenAwareGateway(budget, [{
    ...incapable,
    capabilities: ["text"],
  }]);

  await assert.rejects(gateway.generate(request()), (error: unknown) =>
    error instanceof GatewayError && error.code === "no_eligible_route");
  assert.equal(budget.snapshot().calls, 0);
});


test("gateway preserves a safe provider status category without leaking response details", async () => {
  const budget = makeBudget();
  const gateway = new TokenAwareGateway(
    budget,
    [route(async () => {
      throw new Error("Model gateway request failed (402): private response with api_key=secret-value");
    })],
  );

  await assert.rejects(gateway.generate(request()), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.code, "model_call_failed");
    assert.equal(error.message, "model_call_failed: provider_http_402_billing_or_credits");
    assert.doesNotMatch(error.message, /secret-value|private response/);
    return true;
  });
});

test("gateway classifies unknown provider errors without exposing their messages", async () => {
  const budget = makeBudget();
  const gateway = new TokenAwareGateway(
    budget,
    [route(async () => {
      throw new Error("Authorization header contained private-token");
    })],
  );

  await assert.rejects(gateway.generate(request()), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.message, "model_call_failed: provider_error");
    assert.doesNotMatch(error.message, /private-token/);
    return true;
  });
});

test("context packing prefers compact relevant evidence when the token budget is tight", async () => {
  const budget = makeBudget();
  let packedIds: string[] = [];
  const compactRoute: InternalRoute = {
    ...route(async () => ({
      value: { ok: true },
      usage: { inputTokens: 10, outputTokens: 1 },
      finishReason: "complete",
    })),
    contextWindow: 90,
    prepare(prompt) {
      const evidenceIds = prompt.evidence.map((chunk) => chunk.id);
      return {
        inputTokensUpperBound: 10 + prompt.evidence.reduce((sum, chunk) => sum + chunk.text.length, 0),
        invoke: async () => {
          packedIds = evidenceIds;
          return {
            value: { ok: true },
            usage: { inputTokens: 10, outputTokens: 1 },
            finishReason: "complete",
          };
        },
      };
    },
  };
  const gateway = new TokenAwareGateway(budget, [compactRoute]);
  const input = request();
  input.evidence = [
    { id: "verbose", relevance: 0.9, text: "v".repeat(30) },
    { id: "compact", relevance: 0.6, text: "short" },
  ];

  await gateway.generate(input);

  assert.deepEqual(packedIds, ["compact"]);
});

test("context packing deduplicates identical evidence text across different IDs", async () => {
  const budget = makeBudget();
  let packedIds: string[] = [];
  const deduplicatingRoute: InternalRoute = {
    ...route(async () => ({
      value: { ok: true },
      usage: { inputTokens: 10, outputTokens: 1 },
      finishReason: "complete",
    })),
    prepare(prompt) {
      const evidenceIds = prompt.evidence.map((chunk) => chunk.id);
      return {
        inputTokensUpperBound: 10 + prompt.evidence.reduce((sum, chunk) => sum + chunk.text.length, 0),
        invoke: async () => {
          packedIds = evidenceIds;
          return {
            value: { ok: true },
            usage: { inputTokens: 10, outputTokens: 1 },
            finishReason: "complete",
          };
        },
      };
    },
  };
  const gateway = new TokenAwareGateway(budget, [deduplicatingRoute]);
  const input = request();
  input.evidence = [
    { id: "first-copy", relevance: 0.8, text: "same evidence" },
    { id: "second-copy", relevance: 0.7, text: "same evidence" },
  ];

  await gateway.generate(input);

  assert.deepEqual(packedIds, ["first-copy"]);
});

test("equal estimated costs use configured route weights instead of array order", async () => {
  const budget = makeBudget();
  let selected = "";
  const expensiveRoute: InternalRoute = {
    ...route(async () => {
      selected = "expensive";
      return {
        value: { ok: true },
        usage: { inputTokens: 10, outputTokens: 1 },
        finishReason: "complete",
      };
    }),
    id: "a-expensive",
    costWeight: 3,
    latencyWeight: 2,
    qualityWeight: 8,
  };
  const economicalRoute: InternalRoute = {
    ...route(async () => {
      selected = "economical";
      return {
        value: { ok: true },
        usage: { inputTokens: 10, outputTokens: 1 },
        finishReason: "complete",
      };
    }),
    id: "z-economical",
    costWeight: 1,
    latencyWeight: 1,
    qualityWeight: 5,
  };
  const gateway = new TokenAwareGateway(budget, [expensiveRoute, economicalRoute]);

  await gateway.generate(request());

  assert.equal(selected, "economical");
});


test("gateway rejects duplicate route IDs before routing", () => {
  const budget = makeBudget();
  const duplicate = route(async () => ({
    value: { ok: true },
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "complete",
  }));
  assert.throws(
    () => new TokenAwareGateway(budget, [duplicate, { ...duplicate }]),
    /Missing or duplicate model route ID/,
  );
});

test("gateway rejects non-finite or negative route weights", () => {
  const budget = makeBudget();
  const valid = route(async () => ({
    value: { ok: true },
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "complete",
  }));

  assert.throws(
    () => new TokenAwareGateway(budget, [{ ...valid, costWeight: Number.NaN }]),
    /Invalid model route costWeight/,
  );
  assert.throws(
    () => new TokenAwareGateway(budget, [{ ...valid, latencyWeight: -1 }]),
    /Invalid model route latencyWeight/,
  );
  assert.throws(
    () => new TokenAwareGateway(budget, [{ ...valid, qualityWeight: Number.POSITIVE_INFINITY }]),
    /Invalid model route qualityWeight/,
  );
});
