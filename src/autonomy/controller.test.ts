import assert from "node:assert/strict";
import test from "node:test";
import { defaultAutonomyProfile, evaluateAutonomyRequest, evaluateSkillPromotion } from "./controller.js";

test("thinking, planning and local learning are autonomous by default", () => {
  for (const action of ["think", "plan", "read_memory", "research_local"] as const) {
    assert.equal(evaluateAutonomyRequest(action).allowed, true, action);
  }
});
test("memory writes and skill candidates are autonomous but untrusted", () => {
  assert.equal(evaluateAutonomyRequest("write_memory").allowed, true);
  assert.equal(evaluateAutonomyRequest("create_skill_candidate").allowed, true);
});
test("network research requires both policy layers", () => {
  const profile = { ...defaultAutonomyProfile, networkResearch: true };
  assert.equal(evaluateAutonomyRequest("research_network", profile).allowed, false);
  assert.equal(evaluateAutonomyRequest("research_network", profile, { networkAllowedByExecutionPolicy: true }).allowed, true);
});
test("sandbox work fails closed without isolation", () => {
  assert.equal(evaluateAutonomyRequest("edit_sandbox").allowed, false);
  const budgeted = { sandboxAvailable: true, remainingCycles: 8, remainingSteps: 40, remainingToolCalls: 8, experimentSeconds: 300, estimatedSpendUsd: 1 };
  assert.equal(evaluateAutonomyRequest("run_experiment", defaultAutonomyProfile, budgeted).allowed, true);
});
test("sandbox work respects cycle, step, tool, time and spend budgets", () => {
  const base = { sandboxAvailable: true, remainingCycles: 8, remainingSteps: 40, remainingToolCalls: 8, experimentSeconds: 300, estimatedSpendUsd: 1 };
  for (const context of [
    { ...base, remainingCycles: 0 },
    { ...base, remainingSteps: 41 },
    { ...base, remainingToolCalls: 9 },
    { ...base, experimentSeconds: 301 },
    { ...base, estimatedSpendUsd: 1.01 },
  ]) assert.equal(evaluateAutonomyRequest("run_experiment", defaultAutonomyProfile, context).allowed, false);
});
test("production, external, secret and policy actions always require approval", () => {
  for (const action of ["deploy_production", "external_side_effect", "change_security_policy", "read_secret", "destructive_production"] as const) {
    const decision = evaluateAutonomyRequest(action, { ...defaultAutonomyProfile, networkResearch: true }, { sandboxAvailable: true, networkAllowedByExecutionPolicy: true });
    assert.equal(decision.allowed, false, action);
    assert.equal(decision.mode, "approval-required", action);
  }
});
test("skill promotion requires complete evidence and rollback", () => {
  const evidence = { testsPassed: true, adversarialTestsPassed: true, benchmarkScore: 0.95, safetyIncidents: 0, versionedArtifact: true, rollbackAvailable: true };
  assert.equal(evaluateSkillPromotion(evidence).allowed, true);
  assert.equal(evaluateSkillPromotion({ ...evidence, benchmarkScore: 0.89 }).allowed, false);
  assert.equal(evaluateSkillPromotion({ ...evidence, safetyIncidents: 1 }).allowed, false);
  assert.equal(evaluateSkillPromotion({ ...evidence, rollbackAvailable: false }).allowed, false);
  assert.equal(evaluateSkillPromotion({ ...evidence, adversarialTestsPassed: false }).allowed, false);
});
test("unknown actions are denied", () => {
  assert.equal(evaluateAutonomyRequest("unknown" as never).allowed, false);
});

test("sandbox work fails closed when any budget measurement is missing or malformed", () => {
  const valid = { sandboxAvailable: true, remainingCycles: 8, remainingSteps: 40, remainingToolCalls: 8, experimentSeconds: 300, estimatedSpendUsd: 1 };
  for (const context of [
    { ...valid, remainingCycles: undefined },
    { ...valid, remainingCycles: 9 },
    { ...valid, remainingSteps: -1 },
    { ...valid, remainingToolCalls: Number.NaN },
    { ...valid, experimentSeconds: Number.POSITIVE_INFINITY },
    { ...valid, estimatedSpendUsd: -0.01 },
    { ...valid, estimatedSpendUsd: Number.NaN },
    { ...valid, estimatedSpendUsd: undefined },
  ]) assert.equal(evaluateAutonomyRequest("run_experiment", defaultAutonomyProfile, context).allowed, false);
});

test("sandbox work rejects invalid configured resource budgets", () => {
  const valid = { sandboxAvailable: true, remainingCycles: 8, remainingSteps: 40, remainingToolCalls: 8, experimentSeconds: 300, estimatedSpendUsd: 1 };
  for (const budget of [
    { ...defaultAutonomyProfile.budget, maxCycles: 0 },
    { ...defaultAutonomyProfile.budget, maxSteps: Number.NaN },
    { ...defaultAutonomyProfile.budget, maxToolCallsPerStep: -1 },
    { ...defaultAutonomyProfile.budget, maxExperimentSeconds: Number.POSITIVE_INFINITY },
    { ...defaultAutonomyProfile.budget, maxSpendUsd: -1 },
  ]) assert.equal(evaluateAutonomyRequest("run_experiment", { ...defaultAutonomyProfile, budget }, valid).allowed, false);
});
