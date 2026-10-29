import assert from "node:assert/strict";
import test from "node:test";
import { createSkillRegressionEvaluator, type SkillRegressionRunRequest } from "./skill-regression-evaluator.js";
import type { SkillPackage } from "../skills/platform.js";

const skill: SkillPackage = {
  source: "learned",
  version: "1.1.0",
  skill: {
    id: "learned:regression-fixture",
    name: "Regression fixture skill",
    description: "Synthetic evaluator test",
    triggers: ["fixture"],
    categories: ["tool_error"],
    strategy: "inspect-evidence",
    procedure: ["inspect synthetic evidence", "verify result"],
    verification: ["test"],
  },
};
const fixtures = [
  { id: "fixture-1", taskType: "synthetic", input: { value: 1 } },
  { id: "fixture-2", taskType: "synthetic", input: { value: 2 } },
];

test("skill regression evaluator requires passing candidate fixtures and no quality regression", async () => {
  const evaluator = createSkillRegressionEvaluator({
    fixtures,
    runCase: async ({ mode, fixture }: SkillRegressionRunRequest) => ({
      passed: true,
      score: mode === "baseline" ? 0.7 : 0.9,
      latencyMs: mode === "baseline" ? 100 : 120,
      inputTokens: mode === "baseline" ? 100 : 110,
      outputTokens: mode === "baseline" ? 20 : 20,
      detail: fixture.id,
    }),
  });
  const result = await evaluator(skill);
  assert.equal(result.passed, true);
  assert.ok(result.checks.some((check) => check.name === "minimum-pass-rate" && check.passed));
  assert.ok(result.checks.some((check) => check.name === "quality-regression:fixture-1" && check.passed));
});


test("skill regression evaluator applies configured minimum improvement and pass-rate thresholds", async () => {
  const evaluator = createSkillRegressionEvaluator({
    fixtures,
    minimumPassRate: 0.5,
    minimumScoreDelta: 0.2,
    runCase: async ({ mode, fixture }: SkillRegressionRunRequest) => ({
      passed: mode === "baseline" || fixture.id === "fixture-1",
      score: mode === "baseline" ? 0.7 : fixture.id === "fixture-1" ? 0.8 : 0,
    }),
  });
  const result = await evaluator(skill);
  assert.equal(result.passed, false);
  assert.ok(result.checks.some((check) => check.name === "minimum-pass-rate" && check.passed));
  assert.ok(result.checks.some((check) => check.name === "quality-regression:fixture-1" && !check.passed));
  // A quality regression still fails the whole evaluation even if the aggregate pass rate meets its threshold.
});

test("skill regression evaluator rejects candidate failures and performance regressions", async () => {
  const evaluator = createSkillRegressionEvaluator({
    fixtures,
    runCase: async ({ mode, fixture }: SkillRegressionRunRequest) => ({
      passed: mode === "baseline" || fixture.id !== "fixture-2",
      score: mode === "baseline" ? 0.8 : 0.6,
      latencyMs: mode === "baseline" ? 100 : 300,
      inputTokens: mode === "baseline" ? 100 : 300,
      outputTokens: 20,
    }),
  });
  const result = await evaluator(skill);
  assert.equal(result.passed, false);
  assert.ok(result.checks.some((check) => check.name === "candidate:fixture-2" && !check.passed));
  assert.ok(result.checks.some((check) => check.name === "quality-regression:fixture-1" && !check.passed));
  assert.ok(result.checks.some((check) => check.name === "latency-regression:fixture-1" && !check.passed));
  assert.ok(result.checks.some((check) => check.name === "token-regression:fixture-1" && !check.passed));
});

test("skill regression evaluator fails closed for empty, duplicate, malformed, or crashing fixture suites", async () => {
  const empty = createSkillRegressionEvaluator({ fixtures: [], runCase: async () => ({ passed: true }) });
  assert.equal((await empty(skill)).passed, false);

  const duplicate = createSkillRegressionEvaluator({
    fixtures: [{ id: "same", taskType: "x", input: null }, { id: "same", taskType: "x", input: null }],
    runCase: async () => ({ passed: true }),
  });
  assert.equal((await duplicate(skill)).passed, false);

  const crashing = createSkillRegressionEvaluator({
    fixtures: [fixtures[0]!],
    runCase: async ({ mode }) => {
      if (mode === "baseline") return { passed: true };
      throw new Error("fixture crashed");
    },
  });
  const crashed = await crashing(skill);
  assert.equal(crashed.passed, false);
  assert.ok(crashed.checks.some((check) => check.name === "candidate:fixture-1" && !check.passed));
});

test("skill regression evaluator validates thresholds", () => {
  assert.throws(() => createSkillRegressionEvaluator({ fixtures, runCase: async () => ({ passed: true }), minimumPassRate: 0 }));
  assert.throws(() => createSkillRegressionEvaluator({ fixtures, runCase: async () => ({ passed: true }), maxLatencyRegressionRatio: 0.5 }));
});


test("skill regression evaluator caps fixture suites to bound evaluation cost", () => {
  const tooMany = Array.from({ length: 101 }, (_, index) => ({
    id: "fixture-" + index,
    taskType: "synthetic",
    input: { value: index },
  }));
  assert.throws(
    () => createSkillRegressionEvaluator({ fixtures: tooMany, runCase: async () => ({ passed: true }) }),
    /cannot exceed 100 cases/,
  );
});
