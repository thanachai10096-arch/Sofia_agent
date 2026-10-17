import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptanceCriteriaVerifier,
  changeImpactAnalyzer,
  regressionTestSelector,
  registerVerifiedQualitySkills,
  staticAnalysisCoordinator,
  testStrategyBuilder,
} from "./quality-handlers.js";
import { AdvancedSkillRegistry } from "./advanced-skill-runtime.js";

test("change impact analyzer follows reverse dependencies and selects mapped tests", () => {
  const result = changeImpactAnalyzer({
    changedFiles: ["src/core.ts"],
    dependencies: [
      { from: "src/agent.ts", to: "src/core.ts" },
      { from: "src/api.ts", to: "src/agent.ts" },
    ],
    testMappings: [
      { testPath: "tests/core.test.ts", sourcePath: "src/core.ts" },
      { testPath: "tests/agent.test.ts", sourcePath: "src/agent.ts" },
      { testPath: "tests/api.test.ts", sourcePath: "src/api.ts" },
    ],
  }) as { impactedFileCount: number; transitiveImpactCount: number; selectedTests: string[] };
  assert.equal(result.impactedFileCount, 3);
  assert.equal(result.transitiveImpactCount, 2);
  assert.deepEqual(result.selectedTests, ["tests/agent.test.ts", "tests/api.test.ts", "tests/core.test.ts"]);
});

test("change impact analyzer rejects malformed dependency edges", () => {
  assert.throws(() => changeImpactAnalyzer({ changedFiles: ["src/a.ts"], dependencies: [{ from: "", to: "src/a.ts" }] }), /from and to/);
});

test("test strategy builder proposes security-negative tests without claiming execution", () => {
  const result = testStrategyBuilder({
    changeType: "security",
    changedFiles: ["src/security/guard.ts"],
    acceptanceCriteria: ["secret never leaks"],
  }) as { recommendedLayers: Array<{ layer: string }>; executed: boolean; requiresExecutionEvidence: boolean };
  assert.ok(result.recommendedLayers.some(layer => layer.layer === "negative"));
  assert.equal(result.executed, false);
  assert.equal(result.requiresExecutionEvidence, true);
});

test("test strategy builder rejects unsupported change types", () => {
  assert.throws(() => testStrategyBuilder({ changeType: "guess" }), /changeType must be/);
});

test("regression test selector returns mapped tests and exposes unmapped files", () => {
  const result = regressionTestSelector({
    changedFiles: ["src/a.ts", "src/new.ts"],
    testMappings: [{ sourcePath: "src/a.ts", testPath: "tests/a.test.ts" }],
  }) as { selectedTests: string[]; unmappedChangedFiles: string[]; selectionComplete: boolean };
  assert.deepEqual(result.selectedTests, ["tests/a.test.ts"]);
  assert.deepEqual(result.unmappedChangedFiles, ["src/new.ts"]);
  assert.equal(result.selectionComplete, false);
});

test("acceptance criteria verifier requires evidence for each passing criterion", () => {
  const result = acceptanceCriteriaVerifier({
    criteria: [{ id: "tests", description: "Tests pass" }],
    results: [{ criterionId: "tests", passed: true, evidenceIds: ["run-9"] }],
  }) as { completed: boolean };
  assert.equal(result.completed, true);
});

test("static analysis coordinator distinguishes passed and failed checks", () => {
  const result = staticAnalysisCoordinator({
    checks: [
      { name: "typecheck", passed: true, evidenceId: "ci-1" },
      { name: "lint", passed: false, detail: "2 warnings" },
    ],
  }) as { ready: boolean; passedCount: number; failedCount: number; executedByThisSkill: boolean };
  assert.equal(result.ready, false);
  assert.equal(result.passedCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.executedByThisSkill, false);
});

test("static analysis coordinator requires evidence for passing checks", () => {
  assert.throws(() => staticAnalysisCoordinator({ checks: [{ name: "typecheck", passed: true }] }), /evidenceId/);
});

test("verified quality skills register through the guarded dispatcher", async () => {
  const registry = new AdvancedSkillRegistry();
  const ids = registerVerifiedQualitySkills(registry);
  assert.deepEqual(ids, ["coding.03", "testing.01", "testing.05", "testing.08", "testing.09"]);
  const result = await registry.execute("testing.01", { changeType: "bug" }, {
    principalId: "test-user",
    signal: new AbortController().signal,
  }) as { executed: boolean };
  assert.equal(result.executed, false);
});
