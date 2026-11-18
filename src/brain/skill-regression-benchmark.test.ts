import assert from "node:assert/strict";
import test from "node:test";
import { compareSkillRegressionBenchmark } from "./skill-regression-benchmark.js";

test("benchmark passes when baseline checks remain passing and new checks pass", () => {
  const result = compareSkillRegressionBenchmark({
    baseline: [{ name: "accuracy", passed: true }, { name: "safety", passed: true }],
    candidate: [
      { name: "accuracy", passed: true },
      { name: "safety", passed: true },
      { name: "latency-budget", passed: true },
    ],
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.regressions, []);
  assert.deepEqual(result.unchanged, ["accuracy", "safety"]);
  assert.deepEqual(result.added, ["latency-budget"]);
});

test("benchmark blocks a previously passing check that now fails", () => {
  const result = compareSkillRegressionBenchmark({
    baseline: [{ name: "accuracy", passed: true }],
    candidate: [{ name: "accuracy", passed: false }],
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.regressions, ["accuracy:failed"]);
});

test("benchmark treats dropped baseline coverage as a regression", () => {
  const result = compareSkillRegressionBenchmark({
    baseline: [{ name: "accuracy", passed: true }, { name: "safety", passed: true }],
    candidate: [{ name: "accuracy", passed: true }],
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.regressions, ["safety:missing"]);
});

test("benchmark blocks a newly introduced failing check", () => {
  const result = compareSkillRegressionBenchmark({
    baseline: [{ name: "accuracy", passed: true }],
    candidate: [{ name: "accuracy", passed: true }, { name: "safety", passed: false }],
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.regressions, ["safety:new-check-failed"]);
});

test("benchmark reports recovery of a previously failing check", () => {
  const result = compareSkillRegressionBenchmark({
    baseline: [{ name: "accuracy", passed: false }],
    candidate: [{ name: "accuracy", passed: true }],
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.improvements, ["accuracy"]);
});

test("benchmark rejects empty, malformed, and duplicate check identities", () => {
  assert.throws(() => compareSkillRegressionBenchmark({ baseline: [], candidate: [{ name: "x", passed: true }] }), /non-empty/);
  assert.throws(() => compareSkillRegressionBenchmark({
    baseline: [{ name: "x", passed: true }, { name: "x", passed: true }],
    candidate: [{ name: "x", passed: true }],
  }), /duplicate check/);
  assert.throws(() => compareSkillRegressionBenchmark({
    baseline: [{ name: "x", passed: true }],
    candidate: [{ name: " ", passed: true }],
  }), /malformed check/);
});

test("benchmark rejects a missing input envelope with a controlled error", () => {
  assert.throws(
    () => compareSkillRegressionBenchmark(null as unknown as Parameters<typeof compareSkillRegressionBenchmark>[0]),
    /Benchmark input must be an object/,
  );
});
