import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileSettlementJournal } from "./settlement-journal.js";
import { GatewayError, MeteredProviderError, TokenAwareGateway, type InferenceRequest, type InternalRoute, type PreparedCall, type ProviderReply } from "./token-aware-gateway.js";
import { TokenBudget } from "./token-budget.js";

const request: InferenceRequest = {
  phase: "plan",
  minimumQualityTier: 1,
  requiredCapabilities: [],
  core: { instructions: "json", task: "plan", acceptanceCriteria: [], state: {}, toolSchemas: [] },
  evidence: [],
};

function createBudget() {
  const limit = { maxTokens: 1000, maxCostNanoUsd: 100000n, maxCalls: 5, maxInFlight: 1 };
  return new TokenBudget(limit, [{
    key: "route",
    limit,
    price: { inputNanoUsdPerToken: 1n, outputNanoUsdPerToken: 1n },
  }]);
}

function createRoute(invoke: (options: Parameters<PreparedCall["invoke"]>[0]) => Promise<ProviderReply>): InternalRoute {
  return {
    id: "private-route-name",
    budgetKey: "route",
    qualityTier: 1,
    capabilities: [],
    contextWindow: 2048,
    maxOutputTokens: 100,
    hardOutputCap: true,
    prepare: () => ({ inputTokensUpperBound: 10, invoke }),
  };
}

test("gateway persists known settlement before completing the inference", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-gateway-journal-"));
  try {
    const journal = new FileSettlementJournal("workspace", root);
    const gateway = new TokenAwareGateway(createBudget(), [createRoute(async () => ({
      value: { ok: true },
      usage: { inputTokens: 4, outputTokens: 3 },
      finishReason: "complete",
    }))], 45_000, journal);
    const result = await gateway.generateMetered(request, undefined, "run-1");
    assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 3 });
    assert.equal(await journal.hasUnresolved("run-1"), true);
    await journal.acknowledgeCheckpoint("run-1");
    assert.equal(await journal.hasUnresolved("run-1"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gateway refuses to replay a run with an unresolved provider attempt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-gateway-journal-"));
  try {
    const journal = new FileSettlementJournal("workspace", root);
    await journal.begin("run-1", { inputTokens: 10, outputTokens: 100 });
    let providerCalls = 0;
    const gateway = new TokenAwareGateway(createBudget(), [createRoute(async () => {
      providerCalls += 1;
      return { value: {}, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "complete" };
    })], 45_000, journal);

    await assert.rejects(
      gateway.generateMetered(request, undefined, "run-1"),
      (error: unknown) => error instanceof GatewayError && error.message.includes("unresolved_provider_settlement"),
    );
    assert.equal(providerCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("gateway blocks a second same-run provider call after an unknown-usage settlement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-gateway-journal-"));
  try {
    const journal = new FileSettlementJournal("workspace", root);
    let providerCalls = 0;
    const gateway = new TokenAwareGateway(createBudget(), [createRoute(async () => {
      providerCalls += 1;
      throw new Error("provider connection closed before usage was reported");
    })], 45_000, journal);

    await assert.rejects(
      gateway.generateMetered(request, undefined, "ambiguous-run"),
      (error: unknown) => error instanceof GatewayError && error.code === "model_call_failed",
    );
    assert.equal(await journal.hasUnresolved("ambiguous-run"), true);

    await assert.rejects(
      gateway.generateMetered(request, undefined, "ambiguous-run"),
      (error: unknown) => error instanceof GatewayError && error.message.includes("unresolved_provider_settlement"),
    );
    assert.equal(providerCalls, 1, "an ambiguous settlement must prevent a repeated provider charge");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("gateway blocks same-run retries when metered usage is invalid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-gateway-journal-"));
  try {
    const journal = new FileSettlementJournal("workspace", root);
    let providerCalls = 0;
    const gateway = new TokenAwareGateway(createBudget(), [createRoute(async () => {
      providerCalls += 1;
      throw new MeteredProviderError({ inputTokens: Number.NaN, outputTokens: 1 });
    })], 45_000, journal);

    await assert.rejects(
      gateway.generateMetered(request, undefined, "invalid-usage-run"),
      (error: unknown) => error instanceof GatewayError && error.code === "invalid_usage",
    );
    assert.equal(await journal.hasUnresolved("invalid-usage-run"), true);

    await assert.rejects(
      gateway.generateMetered(request, undefined, "invalid-usage-run"),
      (error: unknown) => error instanceof GatewayError && error.message.includes("unresolved_provider_settlement"),
    );
    assert.equal(providerCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
