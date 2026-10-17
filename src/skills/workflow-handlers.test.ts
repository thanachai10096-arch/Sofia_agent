import test from "node:test";
import assert from "node:assert/strict";
import {
  businessProcessMapper,
  rateLimitManager,
  registerVerifiedWorkflowSkills,
  stableWorkflowFingerprint,
  toolResultNormalizer,
  workflowBuilder,
  workflowReplayTester,
} from "./workflow-handlers.js";
import { AdvancedSkillRegistry } from "./advanced-skill-runtime.js";

test("workflow builder topologically orders dependencies", () => {
  const result = workflowBuilder({
    steps: [
      { id: "deploy", action: "Deploy", dependsOn: ["test"] },
      { id: "test", action: "Run tests", dependsOn: ["build"] },
      { id: "build", action: "Build" },
    ],
  }) as { steps: Array<{ id: string }>; topologicallyOrdered: boolean; executesActions: boolean };
  assert.deepEqual(result.steps.map(step => step.id), ["build", "test", "deploy"]);
  assert.equal(result.topologicallyOrdered, true);
  assert.equal(result.executesActions, false);
});

test("workflow builder rejects unknown dependencies, duplicate IDs, and cycles", () => {
  assert.throws(() => workflowBuilder({ steps: [{ id: "a", action: "A", dependsOn: ["missing"] }] }), /Unknown dependency/);
  assert.throws(() => workflowBuilder({ steps: [{ id: "a", action: "A" }, { id: "a", action: "Again" }] }), /Duplicate/);
  assert.throws(() => workflowBuilder({ steps: [
    { id: "a", action: "A", dependsOn: ["b"] }, { id: "b", action: "B", dependsOn: ["a"] },
  ] }), /cycle detected/);
});

test("rate limit manager evaluates a quota snapshot without changing state", () => {
  const allowed = rateLimitManager({ used: 4, limit: 5, now: "2026-10-17T00:00:00Z", resetAt: "2026-10-17T00:01:00Z" }) as {
    allowed: boolean; remaining: number; stateful: boolean;
  };
  const denied = rateLimitManager({ used: 5, limit: 5, now: "2026-10-17T00:00:00Z", resetAt: "2026-10-17T00:01:00Z" }) as {
    allowed: boolean; retryAfterSeconds: number;
  };
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.remaining, 1);
  assert.equal(allowed.stateful, false);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSeconds, 60);
});

test("business process mapper identifies system handoffs and missing ownership", () => {
  const result = businessProcessMapper({
    steps: [
      { id: "a", name: "Submit request", system: "Portal", owner: "User", durationMinutes: 5 },
      { id: "b", name: "Review request", system: "CRM", durationMinutes: 15 },
      { id: "c", name: "Approve request", system: "ERP", owner: "Manager", durationMinutes: 10 },
    ],
  }) as { handoffs: Array<{ fromSystem: string; toSystem: string }>; stepsMissingOwner: string[]; totalKnownDurationMinutes: number };
  assert.deepEqual(result.handoffs.map(item => [item.fromSystem, item.toSystem]), [["Portal", "CRM"], ["CRM", "ERP"]]);
  assert.deepEqual(result.stepsMissingOwner, ["b"]);
  assert.equal(result.totalKnownDurationMinutes, 30);
});

test("workflow replay tester compares recorded outcomes without replaying actions", () => {
  const result = workflowReplayTester({
    expectedSteps: [{ id: "build", status: "success", outputHash: "abc" }, { id: "test", status: "success" }],
    actualSteps: [{ id: "build", status: "success", outputHash: "wrong" }, { id: "deploy", status: "success" }],
  }) as { passed: boolean; differences: Array<{ kind: string }>; executedByThisSkill: boolean };
  assert.equal(result.passed, false);
  assert.ok(result.differences.some(item => item.kind === "output-mismatch"));
  assert.ok(result.differences.some(item => item.kind === "missing-step"));
  assert.ok(result.differences.some(item => item.kind === "unexpected-step"));
  assert.equal(result.executedByThisSkill, false);
});

test("tool result normalizer redacts secrets and bounds output", () => {
  const result = toolResultNormalizer({
    toolName: "terminal.run",
    result: { ok: false, api_key: "supersecret", message: "password=hunter2", payload: "x".repeat(200) },
    maxChars: 100,
  }) as { output: string; truncated: boolean; isError: boolean; toolName: string };
  assert.equal(result.truncated, true);
  assert.equal(result.isError, true);
  assert.equal(result.toolName, "terminal.run");
  assert.doesNotMatch(result.output, /supersecret|hunter2/);
});

test("stable workflow fingerprint is independent of object key order", () => {
  assert.equal(stableWorkflowFingerprint({ a: 1, b: { c: 2, d: 3 } }), stableWorkflowFingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  assert.equal(stableWorkflowFingerprint({ api_key: "one" }), stableWorkflowFingerprint({ api_key: "two" }));
});

test("verified workflow and tool result handlers register through the guarded dispatcher", async () => {
  const registry = new AdvancedSkillRegistry();
  const ids = registerVerifiedWorkflowSkills(registry);
  assert.deepEqual(ids, ["workflow.01", "workflow.06", "workflow.09", "workflow.10", "tools.03"]);
  const result = await registry.execute("workflow.01", { steps: [{ id: "one", action: "inspect" }] }, {
    principalId: "test-user",
    signal: new AbortController().signal,
  }) as { stepCount: number };
  assert.equal(result.stepCount, 1);
});
