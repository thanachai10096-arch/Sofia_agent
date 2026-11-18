import assert from "node:assert/strict";
import test from "node:test";
import { defaultAutonomyProfile } from "./controller.js";
import { runIndependentResearchLoop, type ResearchLoopAdapters } from "./research-loop.js";

function adapters(overrides: Partial<ResearchLoopAdapters> = {}): ResearchLoopAdapters {
  return {
    observe: async () => ({ signal: "quality regression", sourceIds: ["run-1"] }),
    identifyGaps: async () => ["Why did verification regress?"],
    researchLocally: async () => ({ summary: "Recent runs show a flaky integration test.", sourceIds: ["run-1"], confidence: 0.95 }),
    formulateHypothesis: async () => ({ statement: "A race in test setup causes the regression.", successMetric: "pass rate >= 0.95" }),
    experiment: async () => ({ passed: true, summary: "Isolated test confirms hypothesis.", benchmarkBefore: 0.8, benchmarkAfter: 0.96, safetyIncidents: 0, artifactVersion: "exp-1", rollbackAvailable: true }),
    recordLearning: async () => undefined,
    ...overrides,
  };
}
const validBudget = () => ({
  remainingCycles: 8,
  remainingSteps: 40,
  remainingToolCalls: 8,
  experimentSeconds: 300,
  estimatedSpendUsd: 1,
});

test("research loop autonomously researches, experiments in sandbox and records evidence", async () => {
  let experiments = 0;
  let notes = 0;
  const report = await runIndependentResearchLoop({
    adapters: adapters({
      experiment: async () => { experiments += 1; return { passed: true, summary: "pass", benchmarkBefore: 0.8, benchmarkAfter: 0.96, safetyIncidents: 0, artifactVersion: "v1", rollbackAvailable: true }; },
      recordLearning: async () => { notes += 1; },
    }),
    signal: new AbortController().signal,
    principalId: "tenant-user-1",
    sandboxAvailable: true,
    budgetContext: validBudget,
    maxCycles: 1,
  });
  assert.equal(report.completed, true);
  assert.equal(report.cycles[0]?.status, "learned");
  assert.equal(experiments, 1);
  assert.equal(notes, 1);
});

test("missing sandbox or budget attestation never runs experiment but still records research", async () => {
  let experiments = 0;
  let notes = 0;
  const report = await runIndependentResearchLoop({
    adapters: adapters({
      experiment: async () => { experiments += 1; throw new Error("must not run"); },
      recordLearning: async () => { notes += 1; },
    }),
    signal: new AbortController().signal,
    principalId: "tenant-user-1",
    sandboxAvailable: false,
    budgetContext: () => ({}),
    maxCycles: 1,
  });
  assert.equal(report.cycles[0]?.status, "experiment-denied");
  assert.equal(experiments, 0);
  assert.equal(notes, 1);
});

test("loop stops when no knowledge gaps remain", async () => {
  const report = await runIndependentResearchLoop({
    adapters: adapters({ identifyGaps: async () => [] }),
    signal: new AbortController().signal,
    principalId: "tenant-user-1",
    sandboxAvailable: true,
    budgetContext: validBudget,
  });
  assert.equal(report.stoppedBy, "no-knowledge-gap");
  assert.equal(report.cycles.length, 0);
});

test("cycle limit cannot exceed profile budget", async () => {
  await assert.rejects(() => runIndependentResearchLoop({
    profile: defaultAutonomyProfile,
    adapters: adapters(),
    signal: new AbortController().signal,
    principalId: "tenant-user-1",
    sandboxAvailable: true,
    budgetContext: validBudget,
    maxCycles: defaultAutonomyProfile.budget.maxCycles + 1,
  }), /cycle limit/i);
});

test("learning requires principal identity", async () => {
  await assert.rejects(() => runIndependentResearchLoop({
    adapters: adapters(),
    signal: new AbortController().signal,
    principalId: " ",
    sandboxAvailable: true,
    budgetContext: validBudget,
  }), /principal identity/i);
});

test("research loop resumes after a persisted cycle without replaying earlier cycles", async () => {
  const keys: string[] = [];
  const saved: number[] = [];
  const prior = {
    cycle: 1,
    question: "Earlier question",
    finding: { summary: "Earlier finding", sourceIds: ["prior"], confidence: 0.9 },
    hypothesis: { statement: "Earlier hypothesis", successMetric: "earlier metric" },
    status: "learned" as const,
  };
  const report = await runIndependentResearchLoop({
    adapters: adapters({
      recordLearning: async (input) => { keys.push(input.idempotencyKey); },
    }),
    signal: new AbortController().signal,
    principalId: "tenant-user-1",
    sandboxAvailable: false,
    budgetContext: () => ({}),
    maxCycles: 2,
    idempotencyPrefix: "autonomy-job:job-123",
    startCycle: 2,
    previousCycles: [prior],
    onCycle: async (cycle, nextCycle) => { saved.push(cycle.cycle, nextCycle); },
  });
  assert.deepEqual(report.cycles.map((cycle) => cycle.cycle), [1, 2]);
  assert.deepEqual(keys, ["autonomy-job:job-123:2"]);
  assert.deepEqual(saved, [2, 3]);
});

test("checkpoint must contain exactly the completed cycle prefix", async () => {
  await assert.rejects(() => runIndependentResearchLoop({
    adapters: adapters(),
    signal: new AbortController().signal,
    principalId: "tenant-user-1",
    sandboxAvailable: false,
    budgetContext: () => ({}),
    maxCycles: 2,
    startCycle: 2,
    previousCycles: [],
  }), /checkpoint history/i);
});

test("cancellation after an adapter returns prevents subsequent research side effects", async () => {
  const controller = new AbortController();
  let gapDiscoveryCalls = 0;
  await assert.rejects(() => runIndependentResearchLoop({
    adapters: adapters({
      observe: async () => {
        controller.abort(new Error("host shutdown"));
        return { signal: "x", sourceIds: [] };
      },
      identifyGaps: async () => { gapDiscoveryCalls += 1; return ["should not continue"]; },
    }),
    signal: controller.signal,
    principalId: "tenant-user-1",
    sandboxAvailable: false,
    budgetContext: () => ({}),
    maxCycles: 1,
  }), /host shutdown/);
  assert.equal(gapDiscoveryCalls, 0);
});
