import { test } from "node:test";
import assert from "node:assert/strict";
import { SkillBenchmarkEngine, type SkillBenchmarkCaseResult } from "./skill-benchmark.js";

function fixtures(passed: number, safetyFailureAt = -1): SkillBenchmarkCaseResult[] {
  return Array.from({ length: 4 }, (_, index) => ({
    fixtureId: `fixture-${index + 1}`,
    passed: index < passed,
    safetyPassed: index !== safetyFailureAt,
    durationMs: 100 + index * 10,
    toolCalls: 1 + (index % 2),
    retries: 0,
  }));
}

test("benchmark compares the same fixture set and reports correctness separately from efficiency", () => {
  const engine = new SkillBenchmarkEngine();
  const baseline = engine.summarize("files.inspect", "v1", fixtures(3));
  engine.setBaseline(baseline);

  const current = engine.summarize("files.inspect", "v1", fixtures(4));
  const comparison = engine.compare(current);
  assert.equal(comparison.verdict, "improved");
  assert.equal(comparison.comparableFixtures, 4);
  assert.equal(comparison.qualityDelta, 0.25);
  assert.equal(comparison.safetyFailureDelta, 0);
  assert.ok(comparison.durationRatio);
});

test("benchmark hard-blocks a safety failure even when correctness and speed improve", () => {
  const engine = new SkillBenchmarkEngine();
  engine.setBaseline(engine.summarize("workspace.write", "v2", fixtures(2)));
  const current = engine.summarize("workspace.write", "v2", fixtures(4, 2));
  const comparison = engine.compare(current);
  assert.equal(comparison.verdict, "blocked_safety");
  assert.match(comparison.reasons.join(" "), /safety gate failed/i);
});

test("benchmark flags correctness regression beyond tolerance", () => {
  const engine = new SkillBenchmarkEngine();
  engine.setBaseline(engine.summarize("browser.read", "v1", fixtures(4)));
  const current = engine.summarize("browser.read", "v1", fixtures(2));
  assert.equal(engine.compare(current).verdict, "regression");
});

test("benchmark requires an exact fixture set and exact skill version", () => {
  const engine = new SkillBenchmarkEngine();
  engine.setBaseline(engine.summarize("repo.search", "v1", fixtures(4)));
  const changedSet = fixtures(4).map((item, index) => ({
    ...item,
    fixtureId: index === 3 ? "new-fixture" : item.fixtureId,
  }));
  assert.equal(engine.compare(engine.summarize("repo.search", "v1", changedSet)).verdict, "insufficient_evidence");
  assert.equal(engine.compare(engine.summarize("repo.search", "v2", fixtures(4))).verdict, "insufficient_evidence");
});

test("benchmark refuses incomplete or unsafe baselines", () => {
  const engine = new SkillBenchmarkEngine();
  assert.throws(() => engine.summarize("skill", "v1", fixtures(2)), /At least 3/);
  assert.throws(() => engine.setBaseline(engine.summarize("skill", "v1", fixtures(4, 1))), /safety-clean/);
});

test("benchmark bounds fixture count and rejects duplicates and invalid metrics", () => {
  const engine = new SkillBenchmarkEngine();
  assert.throws(() => engine.summarize("skill", "v1", Array.from({ length: 65 }, (_, i) => ({
    fixtureId: `f-${i}`, passed: true, safetyPassed: true, durationMs: 1, toolCalls: 1, retries: 0,
  }))), /at most 64/);
  assert.throws(() => engine.summarize("skill", "v1", [
    ...fixtures(3).slice(0, 3),
    { ...fixtures(3)[0]!, fixtureId: "fixture-1" },
  ]), /Duplicate benchmark fixture/);
  assert.throws(() => engine.summarize("skill", "v1", [
    ...fixtures(3).slice(0, 3),
    { fixtureId: "bad", passed: true, safetyPassed: true, durationMs: Number.NaN, toolCalls: 1, retries: 0 },
  ]), /finite non-negative/);
});

test("benchmark reports no-baseline as insufficient evidence rather than promoting automatically", () => {
  const engine = new SkillBenchmarkEngine();
  const report = engine.summarize("new-skill", "v1", fixtures(4));
  assert.equal(engine.compare(report).verdict, "insufficient_evidence");
  assert.equal(engine.getBaseline("new-skill", "v1"), undefined);
});

test("benchmark policy rejects unsafe configuration", () => {
  assert.throws(() => new SkillBenchmarkEngine({ minFixtures: 5, maxFixtures: 4 }), /Invalid skill benchmark policy/);
  assert.throws(() => new SkillBenchmarkEngine({ maxQualityRegression: 2 }), /Invalid skill benchmark policy/);
});

test("benchmark rejects forged or internally inconsistent reports", () => {
  const engine = new SkillBenchmarkEngine();
  const report = engine.summarize("skill", "v1", fixtures(4));
  assert.throws(() => engine.setBaseline({
    ...report,
    passed: 99,
  }), /Invalid benchmark report/);
  assert.throws(() => engine.compare({
    ...report,
    fixtureIds: ["duplicate", "duplicate", "third", "fourth"],
  }), /Invalid benchmark report/);
});
