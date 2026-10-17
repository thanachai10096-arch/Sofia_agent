import test from "node:test";
import assert from "node:assert/strict";
import {
  agentTaskDelegator,
  disagreementResolver,
  handoffContractManager,
  parallelWorkCoordinator,
  registerVerifiedAgentCoordinationSkills,
  specialistRouter,
} from "./agent-coordination-handlers.js";
import { AdvancedSkillRegistry } from "./advanced-skill-runtime.js";

test("task delegator requires acceptance criteria and never starts execution", () => {
  const result = agentTaskDelegator({ goal: "Prepare release notes", tasks: [
    { id: "research", description: "Gather release facts", acceptanceCriteria: ["Cite release source"], allowedCapabilities: ["web.read"] },
    { id: "draft", description: "Draft notes", acceptanceCriteria: ["No unsupported claims"], allowedCapabilities: ["workspace.write"], dependsOn: ["research"] },
  ] }) as { tasks: Array<{ id: string }>; executionStarted: boolean };
  assert.equal(result.tasks.length, 2);
  assert.equal(result.executionStarted, false);
  assert.throws(() => agentTaskDelegator({ goal: "Do work", tasks: [{ id: "a", description: "task", acceptanceCriteria: [] }] }), /acceptance criteria/);
});

test("specialist router ranks declared tags without launching agents", () => {
  const result = specialistRouter({ requiredTags: ["typescript", "testing"], specialists: [
    { id: "docs", tags: ["docs"], available: true },
    { id: "dev", tags: ["typescript", "testing"], available: true, declaredCapabilities: ["workspace.read"] },
    { id: "offline", tags: ["typescript", "testing"], available: false },
  ] }) as { recommendation: string | null; launchesAgent: boolean; grantsCapabilities: boolean };
  assert.equal(result.recommendation, "dev");
  assert.equal(result.launchesAgent, false);
  assert.equal(result.grantsCapabilities, false);
});

test("handoff contract reports missing required fields", () => {
  const result = handoffContractManager({ taskId: "task-1", goal: "Investigate" }) as { valid: boolean; missingFields: string[]; contract: unknown };
  assert.equal(result.valid, false);
  assert.ok(result.missingFields.includes("acceptanceCriteria"));
  assert.equal(result.contract, null);
});

test("handoff contract accepts a complete explicit contract", () => {
  const result = handoffContractManager({
    taskId: "task-1", goal: "Review patch", deliverable: "Findings",
    acceptanceCriteria: ["Every finding has evidence"], allowedCapabilities: ["repo.read"],
  }) as { valid: boolean; missingFields: string[]; executionStarted: boolean };
  assert.equal(result.valid, true);
  assert.deepEqual(result.missingFields, []);
  assert.equal(result.executionStarted, false);
});

test("parallel work coordinator builds deterministic batches and detects cycles", () => {
  const valid = parallelWorkCoordinator({ tasks: [
    { id: "c", dependsOn: ["a", "b"] }, { id: "b", dependsOn: [] }, { id: "a", dependsOn: [] },
  ] }) as { valid: boolean; batches: string[][]; cycleDetected: boolean };
  assert.deepEqual(valid.batches, [["a", "b"], ["c"]]);
  assert.equal(valid.valid, true);
  const cycle = parallelWorkCoordinator({ tasks: [{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }] }) as { valid: boolean; cycleDetected: boolean };
  assert.equal(cycle.valid, false);
  assert.equal(cycle.cycleDetected, true);
});

test("disagreement resolver preserves conflicting claims and requires review", () => {
  const result = disagreementResolver({ claims: [
    { topic: "runtime", agentId: "agent-a", claim: "Tests pass", evidenceIds: ["ci-1"] },
    { topic: "runtime", agentId: "agent-b", claim: "Tests fail", evidenceIds: [] },
  ] }) as { unresolvedCount: number; requiresHumanReview: boolean; autoResolved: boolean };
  assert.equal(result.unresolvedCount, 1);
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.autoResolved, false);
});

test("verified coordination skills register only after catalog verification", () => {
  const registry = new AdvancedSkillRegistry();
  assert.deepEqual(registerVerifiedAgentCoordinationSkills(registry), []);
  assert.equal(registry.has("agents.01"), false);
});
