import assert from "node:assert/strict";
import test from "node:test";
import { SofiaAutonomyRuntime } from "./runtime.js";
import type { ResearchLoopAdapters } from "./research-loop.js";

function adapters(overrides: Partial<ResearchLoopAdapters> = {}): ResearchLoopAdapters {
  return {
    observe: async () => ({ signal: "verification regression", sourceIds: ["run-1"] }),
    identifyGaps: async () => ["What caused the regression?"],
    researchLocally: async () => ({ summary: "A flaky test is implicated.", sourceIds: ["run-1"], confidence: 0.9 }),
    formulateHypothesis: async () => ({ statement: "The setup races.", successMetric: "pass rate >= 0.9" }),
    experiment: async () => ({ passed: true, summary: "sandbox experiment passed", benchmarkBefore: 0.8, benchmarkAfter: 0.95, safetyIncidents: 0, artifactVersion: "exp-1", rollbackAvailable: true }),
    recordLearning: async () => undefined,
    ...overrides,
  };
}

test("runtime research is explicit, principal-scoped and emits audit lifecycle", async () => {
  const audit: string[] = [];
  const runtime = new SofiaAutonomyRuntime({ audit: (event) => { audit.push(event.type); } });
  const report = await runtime.runResearch({
    principalId: "tenant-user-1",
    signal: new AbortController().signal,
    adapters: adapters(),
    sandboxAvailable: false,
    budgetContext: () => ({}),
    maxCycles: 1,
  });
  assert.equal(report.cycles[0]?.status, "experiment-denied");
  assert.deepEqual(audit, ["autonomy.research.started", "autonomy.research.completed"]);
});

test("runtime refuses missing principal before invoking adapters", async () => {
  let observed = false;
  const runtime = new SofiaAutonomyRuntime();
  await assert.rejects(() => runtime.runResearch({
    principalId: " ",
    signal: new AbortController().signal,
    adapters: adapters({ observe: async () => { observed = true; return { signal: "x", sourceIds: [] }; } }),
    sandboxAvailable: false,
    budgetContext: () => ({}),
  }), /principal identity/i);
  assert.equal(observed, false);
});

test("runtime propagates adapter failure and audits it", async () => {
  const audit: string[] = [];
  const runtime = new SofiaAutonomyRuntime({ audit: (event) => { audit.push(event.type); } });
  await assert.rejects(() => runtime.runResearch({
    principalId: "tenant-user-1",
    signal: new AbortController().signal,
    adapters: adapters({ observe: async () => { throw new Error("adapter unavailable"); } }),
    sandboxAvailable: false,
    budgetContext: () => ({}),
    maxCycles: 1,
  }), /adapter unavailable/);
  assert.deepEqual(audit, ["autonomy.research.started", "autonomy.research.failed"]);
});

test("runtime rejects cycle budgets above the configured profile", async () => {
  const runtime = new SofiaAutonomyRuntime();
  await assert.rejects(() => runtime.runResearch({
    principalId: "tenant-user-1",
    signal: new AbortController().signal,
    adapters: adapters(),
    sandboxAvailable: false,
    budgetContext: () => ({}),
    maxCycles: 9,
  }), /cycle limit/i);
});
