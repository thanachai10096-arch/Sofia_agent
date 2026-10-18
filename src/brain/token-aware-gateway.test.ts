import assert from "node:assert/strict";
import test from "node:test";

import { TokenBudget } from "./token-budget.js";
import {
  classifyProviderFailure,
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
        inputTokensUpperBound: 10,
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

test("classifyProviderFailure distinguishes previously generic provider errors", () => {
  assert.equal(
    classifyProviderFailure(new Error("Model returned non-JSON Brain output: x")),
    "provider_non_json_output",
  );
  assert.equal(
    classifyProviderFailure(new Error("Provider did not return token usage")),
    "provider_usage_missing",
  );
  assert.equal(
    classifyProviderFailure(new Error("invalid arguments for tool call read_file.")),
    "provider_invalid_tool_arguments",
  );
  assert.equal(
    classifyProviderFailure(new Error("Model provider gemini temporarily unavailable.")),
    "provider_circuit_open",
  );
  assert.equal(
    classifyProviderFailure(new Error("something unexpected")),
    "provider_error",
  );
  assert.equal(
    classifyProviderFailure(new Error("Model gateway request failed (400): bad request")),
    "provider_http_400_request_rejected",
  );
});

test("gateway logs a redacted provider failure preview without secrets", async () => {
  const key = "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(...args);
  };

  try {
    const gateway = new TokenAwareGateway(makeBudget(), [
      route(async () => {
        throw new Error(`Model gateway request failed (400): key ${key}`);
      }),
    ]);

    await assert.rejects(
      gateway.generate(request()),
      (error: unknown) =>
        error instanceof GatewayError && error.code === "model_call_failed",
    );
  } finally {
    console.error = original;
  }

  assert.equal(logged.length, 1);
  const line = String(logged[0]);
  assert.ok(!line.includes(key));
  const entry = JSON.parse(line) as Record<string, unknown>;
  assert.equal(entry.event, "model_provider_failure");
  assert.equal(entry.classification, "provider_http_400_request_rejected");
  assert.equal(entry.upstreamStatus, "400");
});
