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

test("gateway fails closed after a worker crash leaves a durable run claim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-gateway-crash-claim-"));
  try {
    const crashedWorkerJournal = new FileSettlementJournal("workspace", root);
    const abandonedClaim = await crashedWorkerJournal.claimRun("crashed-run");
    await crashedWorkerJournal.begin("crashed-run", { inputTokens: 10, outputTokens: 100 }, abandonedClaim);
    // Deliberately do not release the claim: this represents process death before
    // provider settlement or checkpoint acknowledgement.

    const restartedWorkerJournal = new FileSettlementJournal("workspace", root);
    let providerCalls = 0;
    const gateway = new TokenAwareGateway(createBudget(), [createRoute(async () => {
      providerCalls += 1;
      return { value: {}, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "complete" };
    })], 45_000, restartedWorkerJournal);

    await assert.rejects(
      gateway.generateMetered(request, undefined, "crashed-run"),
      (error: unknown) => error instanceof GatewayError && error.message.includes("settlement_run_claimed"),
    );
    assert.equal(providerCalls, 0, "a restarted worker must not replay a possibly billed provider request");
    assert.equal(await restartedWorkerJournal.hasUnresolved("crashed-run"), true);
    // The abandoned claim is intentionally retained for operator reconciliation.
    await assert.rejects(restartedWorkerJournal.claimRun("crashed-run"), /already claimed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gateway refuses to replay a run with an unresolved provider attempt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-gateway-journal-"));
  try {
    const journal = new FileSettlementJournal("workspace", root);
    const unresolvedClaim = await journal.claimRun("run-1");
    await journal.begin("run-1", { inputTokens: 10, outputTokens: 100 }, unresolvedClaim);
    await unresolvedClaim.release();
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


test("gateway rejects concurrent provider calls for the same run identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-gateway-journal-"));
  try {
    const journal = new FileSettlementJournal("workspace", root);
    let providerCalls = 0;
    let markProviderStarted!: () => void;
    let releaseProvider!: () => void;
    const providerStarted = new Promise<void>(resolve => { markProviderStarted = resolve; });
    const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
    const gateway = new TokenAwareGateway(createBudget(), [createRoute(async () => {
      providerCalls += 1;
      markProviderStarted();
      await providerGate;
      return { value: { ok: true }, usage: { inputTokens: 2, outputTokens: 2 }, finishReason: "complete" };
    })], 45_000, journal);

    const first = gateway.generateMetered(request, undefined, "concurrent-run");
    await providerStarted;
    await assert.rejects(
      gateway.generateMetered(request, undefined, "concurrent-run"),
      (error: unknown) => error instanceof GatewayError && error.message.includes("concurrent_provider_call_same_run"),
    );
    assert.equal(providerCalls, 1);
    releaseProvider();
    await first;
    assert.equal(providerCalls, 1);
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


test("independent gateways sharing a journal cannot invoke the same run concurrently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-gateway-journal-workers-"));
  try {
    let providerCalls = 0;
    let markProviderStarted!: () => void;
    let releaseProvider!: () => void;
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const firstJournal = new FileSettlementJournal("workspace", root);
    const secondJournal = new FileSettlementJournal("workspace", root);
    const firstGateway = new TokenAwareGateway(createBudget(), [createRoute(async () => {
      providerCalls += 1;
      markProviderStarted();
      await providerGate;
      return { value: { ok: true }, usage: { inputTokens: 2, outputTokens: 2 }, finishReason: "complete" };
    })], 45_000, firstJournal);
    const secondGateway = new TokenAwareGateway(createBudget(), [createRoute(async () => {
      providerCalls += 1;
      return { value: { duplicate: true }, usage: { inputTokens: 2, outputTokens: 2 }, finishReason: "complete" };
    })], 45_000, secondJournal);

    const first = firstGateway.generateMetered(request, undefined, "shared-run");
    await providerStarted;
    await assert.rejects(
      secondGateway.generateMetered(request, undefined, "shared-run"),
      (error: unknown) => error instanceof GatewayError && error.code === "settlement_run_claimed",
    );
    assert.equal(providerCalls, 1, "the competing gateway must not invoke a second provider");
    releaseProvider();
    await first;
    assert.equal(providerCalls, 1);
    assert.equal(await firstJournal.hasUnresolved("shared-run"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gateway never replays after provider success when durable settlement recording fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-gateway-settlement-write-failure-"));
  try {
    class FailingSettlementJournal extends FileSettlementJournal {
      override async settle(
        _runId: string,
        _attempt: { id: string },
        _usage: { inputTokens: number; outputTokens: number } | undefined,
        _claim: import("./settlement-journal.js").SettlementRunClaim,
      ): Promise<void> {
        throw new Error("injected durable settlement write failure");
      }
    }

    const failingJournal = new FailingSettlementJournal("workspace", root);
    let providerCalls = 0;
    const firstGateway = new TokenAwareGateway(createBudget(), [createRoute(async () => {
      providerCalls += 1;
      return {
        value: { accepted: true },
        usage: { inputTokens: 5, outputTokens: 2 },
        finishReason: "complete",
      };
    })], 45_000, failingJournal);

    await assert.rejects(
      firstGateway.generateMetered(request, undefined, "settlement-write-failure"),
      /injected durable settlement write failure/,
    );
    assert.equal(providerCalls, 1);
    assert.equal(await failingJournal.hasUnresolved("settlement-write-failure"), true,
      "the durable started event must remain unresolved when settlement persistence fails");

    const restartedJournal = new FileSettlementJournal("workspace", root);
    const restartedGateway = new TokenAwareGateway(createBudget(), [createRoute(async () => {
      providerCalls += 1;
      return {
        value: { duplicate: true },
        usage: { inputTokens: 5, outputTokens: 2 },
        finishReason: "complete",
      };
    })], 45_000, restartedJournal);

    await assert.rejects(
      restartedGateway.generateMetered(request, undefined, "settlement-write-failure"),
      (error: unknown) => error instanceof GatewayError &&
        error.message.includes("unresolved_provider_settlement"),
    );
    assert.equal(providerCalls, 1,
      "a restarted worker must not repeat a provider call whose response could not be durably settled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
