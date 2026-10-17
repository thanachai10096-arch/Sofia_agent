import test from "node:test";
import assert from "node:assert/strict";
import {
  completionVerifier,
  failureClassifier,
  goalDecomposer,
  intentClarifier,
  planBuilder,
  retryStrategist,
  registerVerifiedCoreSkills,
} from "./core-handlers.js";
import { ADVANCED_SKILLS, getAdvancedSkill } from "./advanced-skill-catalog.js";
import { AdvancedSkillRegistry } from "./advanced-skill-runtime.js";

test("intent clarifier reports missing information without inventing intent", () => {
  const result = intentClarifier({ goal: "Fix it" }) as { readyToPlan: boolean; missingInformation: string[] };
  assert.equal(result.readyToPlan, false);
  assert.ok(result.missingInformation.length > 0);
});

test("intent clarifier normalizes whitespace and preserves supplied constraints", () => {
  const result = intentClarifier({ goal: "  Add   a settings page  ", constraints: ["No external network"] }) as {
    normalizedGoal: string; constraints: string[];
  };
  assert.equal(result.normalizedGoal, "Add a settings page");
  assert.deepEqual(result.constraints, ["No external network"]);
});

test("intent clarifier validates structured input", () => {
  assert.throws(() => intentClarifier("do something"), /input must be an object/);
  assert.throws(() => intentClarifier({ goal: "" }), /goal must be a non-empty string/);
});

test("goal decomposer uses explicit user subtasks and de-duplicates them", () => {
  const result = goalDecomposer({ goal: "ship release", subtasks: ["Test", "Document", "Test"] }) as {
    subtasks: string[]; decompositionMethod: string;
  };
  assert.deepEqual(result.subtasks, ["Test", "Document"]);
  assert.equal(result.decompositionMethod, "user-provided");
});

test("goal decomposer only splits explicit boundaries", () => {
  const result = goalDecomposer({ goal: "Inspect the repo; run tests; summarize results" }) as { subtasks: string[] };
  assert.deepEqual(result.subtasks, ["Inspect the repo", "run tests", "summarize results"]);
});

test("plan builder creates a bounded sequential plan", () => {
  const result = planBuilder({ steps: ["Inspect", "Implement", "Verify"], acceptanceCriteria: ["tests pass"] }) as {
    steps: Array<{ id: string; dependencies: string[] }>; stepCount: number;
  };
  assert.equal(result.stepCount, 3);
  assert.deepEqual(result.steps.map(step => step.id), ["step-1", "step-2", "step-3"]);
  assert.deepEqual(result.steps.map(step => step.dependencies), [[], ["step-1"], ["step-2"]]);
});

test("plan builder rejects empty and excessive plans", () => {
  assert.throws(() => planBuilder({ steps: [] }), /at least one step/);
  assert.throws(() => planBuilder({ steps: Array.from({ length: 41 }, (_, i) => `step ${i}`) }), /at most 40/);
});

test("retry strategist stops instead of retrying permission errors", () => {
  const result = retryStrategist({ category: "permission_error", attempts: 0 }) as { retry: boolean; reason: string };
  assert.equal(result.retry, false);
  assert.match(result.reason, /Do not retry/);
});

test("retry strategist uses a bounded retry budget", () => {
  const retry = retryStrategist({ category: "network_error", attempts: 1, maxAttempts: 3 }) as { retry: boolean; strategy: string };
  const exhausted = retryStrategist({ category: "network_error", attempts: 3, maxAttempts: 3 }) as { retry: boolean };
  assert.equal(retry.retry, true);
  assert.equal(retry.strategy, "alternative-tool");
  assert.equal(exhausted.retry, false);
});

test("failure classifier prioritizes permission failures and bounds message preview", () => {
  const result = failureClassifier({ message: "Permission denied while trying network access " + "x".repeat(400) }) as {
    category: string; messagePreview: string;
  };
  assert.equal(result.category, "permission_error");
  assert.equal(result.messagePreview.length, 240);
});

test("failure classifier reports unknown rather than guessing", () => {
  const result = failureClassifier({ message: "Something unexpected happened" }) as { category: string; needsEvidenceReview: boolean };
  assert.equal(result.category, "unknown");
  assert.equal(result.needsEvidenceReview, true);
});

test("completion verifier requires passing results with evidence for every criterion", () => {
  const result = completionVerifier({
    criteria: [{ id: "tests", description: "Tests pass" }, { id: "build", description: "Build passes" }],
    results: [
      { criterionId: "tests", passed: true, evidenceIds: ["run-123"] },
      { criterionId: "build", passed: true, evidenceIds: [] },
    ],
  }) as { completed: boolean; passedCount: number; totalCriteria: number };
  assert.equal(result.completed, false);
  assert.equal(result.passedCount, 1);
  assert.equal(result.totalCriteria, 2);
});

test("completion verifier completes only when every criterion has evidence", () => {
  const result = completionVerifier({
    criteria: [{ id: "typecheck", description: "Typecheck passes" }],
    results: [{ criterionId: "typecheck", passed: true, evidenceIds: ["ci-run-42"] }],
  }) as { completed: boolean };
  assert.equal(result.completed, true);
});

test("core skill registry registers only verified handlers and executes them through the guarded dispatcher", async () => {
  const registry = new AdvancedSkillRegistry();
  const ids = registerVerifiedCoreSkills(registry);
  assert.deepEqual(ids, ["runtime.01", "runtime.02", "runtime.03", "runtime.08", "runtime.09", "runtime.10"]);
  assert.equal(ADVANCED_SKILLS.filter(skill => skill.status === "verified").length, 30);
  assert.ok(ids.every(id => registry.has(id)));

  const result = await registry.execute("runtime.09", { message: "Type error: value is not assignable" }, {
    principalId: "test-user",
    signal: new AbortController().signal,
  }) as { category: string };
  assert.equal(result.category, "type_error");
});
