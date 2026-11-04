import assert from "node:assert/strict";
import test from "node:test";

import { TokenBudget } from "./token-budget.js";
import {
  GatewayError,
  MeteredProviderError,
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

test("gateway explains safe aggregate route rejection reasons", async () => {
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

  await assert.rejects(gateway.generate(request()), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.code, "no_eligible_route");
    assert.equal(error.message, "no_eligible_route: route_rejections:capabilities=1");
    return true;
  });
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

test("gateway preserves bounded allowlisted provider type/code diagnostics only", async () => {
  const budget = makeBudget();
  const gateway = new TokenAwareGateway(budget, [route(async () => {
    throw new Error("Model gateway request failed (400): type=invalid_request_error code=json_mode_requires_json");
  })]);
  await assert.rejects(gateway.generate(request()), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.message, "model_call_failed: provider_http_400_bad_request_type=invalid_request_error_code=json_mode_requires_json");
    assert.ok(error.message.length <= 300);
    assert.doesNotMatch(error.message, /Authorization|api.?key|user message/i);
    return true;
  });
});


for (const [message, expected] of [
  ["Model gateway returned no usable content (finish_reason=end_turn).", "provider_empty_content_finish_end_turn"],
  ["Model gateway returned no usable content (finish_reason=STOP).", "provider_empty_content"],
  ["Model gateway returned a refusal response.", "provider_refusal"],
  ["Provider did not return token usage", "provider_missing_usage"],
  ["Model provider fast temporarily unavailable.", "provider_circuit_open"],
  ["Model provider fast recovery probe already in progress.", "provider_circuit_open"],
  ["invalid arguments for tool call workspace.write_file.", "provider_bad_tool_args"],
  ["provider_thinking_only_output", "provider_thinking_only_output"],
] as const) {
  test(`gateway safely classifies ${expected}`, async () => {
    const gateway = new TokenAwareGateway(makeBudget(), [route(async () => { throw new Error(message); })]);
    await assert.rejects(gateway.generate(request()), (error: unknown) =>
      error instanceof GatewayError && error.message === `model_call_failed: ${expected}`);
  });
}


test("gateway retries a route after its temporary failure cooldown", async () => {
  const budget = makeBudget();
  let calls = 0;
  let shouldFail = true;
  const gateway = new TokenAwareGateway(
    budget,
    [route(async () => {
      calls += 1;
      if (shouldFail) throw new MeteredProviderError({ inputTokens: 2, outputTokens: 1 });
      return {
        value: { recovered: true },
        usage: { inputTokens: 2, outputTokens: 2 },
        finishReason: "complete",
      };
    })],
    5_000,
    5,
  );

  await assert.rejects(gateway.generate(request()));
  await assert.rejects(gateway.generate(request()));
  await assert.rejects(
    gateway.generate(request()),
    (error: unknown) => error instanceof GatewayError && error.code === "no_eligible_route",
  );
  assert.equal(calls, 2);

  await new Promise((resolve) => setTimeout(resolve, 15));
  shouldFail = false;
  assert.deepEqual(await gateway.generate(request()), { recovered: true });
  assert.equal(calls, 3);
});
