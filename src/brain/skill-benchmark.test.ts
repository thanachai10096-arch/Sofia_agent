import assert from "node:assert/strict";
import test from "node:test";
import { createIsolatedSkillBenchmarkEvaluator, type SkillBenchmarkFixture, type SkillBenchmarkRun } from "./skill-benchmark.js";
import type { SkillPackage } from "../skills/platform.js";

const fixtures: SkillBenchmarkFixture[] = [
  { id: "case-1", taskType: "repair", input: "Repair a missing import", expectedOutcome: "Typecheck passes" },
  { id: "case-2", taskType: "repair", input: "Fix a regression", expectedOutcome: "Regression test passes" },
  { id: "case-3", taskType: "research", input: "Summarize project evidence", expectedOutcome: "Summary cites evidence" },
];
const candidate: SkillPackage = {
  skill: {
    id: "learned:test", name: "Test skill", description: "Benchmark test candidate",
    triggers: ["repair"], categories: ["type_error"], strategy: "inspect-evidence",
    procedure: ["inspect evidence", "verify result"], verification: ["test"],
  },
  source: "learned", version: "1.0.0",
};
function result(passed: boolean, score = passed ? 1 : 0): SkillBenchmarkRun {
  return { passed, score, durationMs: 10, tokensUsed: 20 };
}

test("benchmark evaluator requires fixture evidence and passes a successful candidate", async () => {
  const evaluator = createIsolatedSkillBenchmarkEvaluator({
    fixtures,
    runner: { run: async () => result(true) },
  });
  const evaluation = await evaluator(candidate);
  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.checks.find((check) => check.name === "candidate-pass-rate")?.passed, true);
  assert.equal(evaluation.checks.find((check) => check.name === "benchmark-evidence")?.passed, true);
});

test("benchmark evaluator rejects a candidate that fails a fixture", async () => {
  let index = 0;
  const evaluator = createIsolatedSkillBenchmarkEvaluator({
    fixtures,
    runner: { run: async () => result(index++ !== 1) },
  });
  const evaluation = await evaluator(candidate);
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.checks.find((check) => check.name === "candidate-pass-rate")?.passed, false);
});

test("benchmark evaluator rejects regressions against the active skill on identical fixtures", async () => {
  let calls = 0;
  const evaluator = createIsolatedSkillBenchmarkEvaluator({
    fixtures,
    getActiveBaseline: () => ({ ...candidate, version: "0.9.0" }),
    runner: {
      run: async ({ candidate: tested }) => {
        calls++;
        // Candidate is run first for all fixtures, then baseline; candidate fails every fixture.
        return tested.version === "1.0.0" ? result(false) : result(true);
      },
    },
  });
  const evaluation = await evaluator(candidate);
  assert.equal(calls, fixtures.length * 2);
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.checks.find((check) => check.name === "no-regression-vs-active")?.passed, false);
});

test("benchmark evaluator fails closed on malformed runner metrics", async () => {
  const evaluator = createIsolatedSkillBenchmarkEvaluator({
    fixtures,
    runner: { run: async () => ({ passed: true, score: 3, durationMs: -1 } as SkillBenchmarkRun) },
  });
  const evaluation = await evaluator(candidate);
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.checks.some((check) => check.name.startsWith("fixture:") && !check.passed), true);
});

test("benchmark evaluator rejects duplicate or insufficient fixtures at construction", () => {
  assert.throws(() => createIsolatedSkillBenchmarkEvaluator({
    fixtures: fixtures.slice(0, 2),
    runner: { run: async () => result(true) },
  }), /unique, valid fixtures/);
  assert.throws(() => createIsolatedSkillBenchmarkEvaluator({
    fixtures: [fixtures[0] as SkillBenchmarkFixture, fixtures[0] as SkillBenchmarkFixture, fixtures[2] as SkillBenchmarkFixture],
    runner: { run: async () => result(true) },
  }), /unique, valid fixtures/);
});


test("benchmark evaluator fails closed when an isolated runner exceeds its timeout", async () => {
  const evaluator = createIsolatedSkillBenchmarkEvaluator({
    fixtures,
    timeoutMs: 5,
    runner: { run: async () => new Promise<SkillBenchmarkRun>(() => undefined) },
  });
  const evaluation = await evaluator(candidate);
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.checks.filter((check) => check.name.startsWith("fixture:")).length, fixtures.length);
  assert.equal(evaluation.checks.some((check) => check.detail?.includes("timed out")), true);
});


test("benchmark evaluator rejects incomplete baseline evidence instead of treating runner failures as poor baseline scores", async () => {
  const evaluator = createIsolatedSkillBenchmarkEvaluator({
    fixtures,
    minimumPassRate: 0.5,
    getActiveBaseline: () => ({ ...candidate, version: "0.9.0" }),
    runner: {
      run: async ({ candidate: tested, fixture }) => {
        if (tested.version === "0.9.0" && fixture.id === "case-2") {
          throw new Error("baseline sandbox unavailable");
        }
        return result(true);
      },
    },
  });
  const evaluation = await evaluator(candidate);
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.checks.find((check) => check.name === "baseline-evidence")?.passed, false);
});

test("benchmark evaluator emits explicit fixture evidence for a valid but failed run", async () => {
  const evaluator = createIsolatedSkillBenchmarkEvaluator({
    fixtures,
    minimumPassRate: 0.5,
    runner: { run: async ({ fixture }) => result(fixture.id !== "case-1") },
  });
  const evaluation = await evaluator(candidate);
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.checks.find((check) => check.name === "fixture:case-1")?.passed, false);
});


test("benchmark evaluator rejects an active baseline for a different skill identity", async () => {
  let calls = 0;
  const evaluator = createIsolatedSkillBenchmarkEvaluator({
    fixtures,
    getActiveBaseline: () => ({
      ...candidate,
      skill: { ...candidate.skill, id: "learned:unrelated" },
      version: "0.9.0",
    }),
    runner: { run: async () => { calls++; return result(true); } },
  });
  const evaluation = await evaluator(candidate);
  assert.equal(evaluation.passed, false);
  assert.equal(calls, 0);
  assert.equal(evaluation.checks.find((check) => check.name === "baseline-identity")?.passed, false);
});


test("benchmark evaluator fails closed when active baseline lookup throws", async () => {
  let calls = 0;
  const evaluator = createIsolatedSkillBenchmarkEvaluator({
    fixtures,
    getActiveBaseline: () => { throw new Error("lifecycle store unavailable"); },
    runner: { run: async () => { calls++; return result(true); } },
  });
  const evaluation = await evaluator(candidate);
  assert.equal(evaluation.passed, false);
  assert.equal(calls, 0);
  assert.equal(evaluation.checks.find((check) => check.name === "baseline-evidence")?.passed, false);
  assert.match(evaluation.checks[0]?.detail ?? "", /lifecycle store unavailable/);
});

test("benchmark runner receives isolated candidate and fixture copies", async () => {
  const originalProcedure = [...candidate.skill.procedure];
  const originalInput = fixtures[0]!.input;
  const evaluator = createIsolatedSkillBenchmarkEvaluator({
    fixtures,
    runner: {
      run: async ({ candidate: tested, fixture }) => {
        (tested.skill.procedure as string[]).push("runner mutation");
        (fixture as { input: string }).input = "runner mutation";
        return result(true);
      },
    },
  });
  const evaluation = await evaluator(candidate);
  assert.equal(evaluation.passed, true);
  assert.deepEqual(candidate.skill.procedure, originalProcedure);
  assert.equal(fixtures[0]!.input, originalInput);
});

test("benchmark timeout aborts the isolated runner signal", async () => {
  let signal: AbortSignal | undefined;
  const evaluator = createIsolatedSkillBenchmarkEvaluator({
    fixtures,
    timeoutMs: 5,
    runner: {
      run: async ({ signal: runSignal }) => {
        signal = runSignal;
        return new Promise<SkillBenchmarkRun>(() => undefined);
      },
    },
  });
  const evaluation = await evaluator(candidate);
  assert.equal(evaluation.passed, false);
  assert.equal(signal?.aborted, true);
});

test("benchmark evidence reports measured duration and token usage", async () => {
  const evaluator = createIsolatedSkillBenchmarkEvaluator({
    fixtures,
    getActiveBaseline: () => ({ ...candidate, version: "0.9.0" }),
    runner: {
      run: async ({ candidate: tested }) => ({
        passed: true,
        score: 1,
        durationMs: tested.version === "0.9.0" ? 7 : 11,
        tokensUsed: tested.version === "0.9.0" ? 13 : 17,
      }),
    },
  });
  const evaluation = await evaluator(candidate);
  const evidence = evaluation.checks.find((check) => check.name === "benchmark-evidence");
  assert.match(evidence?.detail ?? "", /candidateDurationMs=33/);
  assert.match(evidence?.detail ?? "", /candidateTokens=51/);
  assert.match(evidence?.detail ?? "", /baselineDurationMs=21/);
  assert.match(evidence?.detail ?? "", /baselineTokens=39/);
});

test("benchmark evaluator enforces a total wall-clock budget across fixtures", async () => {
  let calls = 0;
  const evaluator = createIsolatedSkillBenchmarkEvaluator({
    fixtures,
    timeoutMs: 100,
    maxTotalDurationMs: 1,
    runner: {
      run: async () => {
        calls++;
        return new Promise<SkillBenchmarkRun>((resolve) => setTimeout(() => resolve(result(true)), 10));
      },
    },
  });
  const evaluation = await evaluator(candidate);
  assert.equal(evaluation.passed, false);
  assert.ok(calls < fixtures.length);
  assert.equal(evaluation.checks.filter((check) => check.name.startsWith("fixture:") && !check.passed).length, fixtures.length);
});

test("benchmark evaluator validates the total wall-clock budget", () => {
  assert.throws(() => createIsolatedSkillBenchmarkEvaluator({
    fixtures,
    maxTotalDurationMs: 0,
    runner: { run: async () => result(true) },
  }), /maxTotalDurationMs/);
});
