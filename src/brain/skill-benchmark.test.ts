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
    triggers: ["repair"], categories: ["testing"], strategy: "inspect-evidence",
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
    fixtures: [fixtures[0], fixtures[0], fixtures[2]],
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
