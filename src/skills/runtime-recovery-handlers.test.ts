import test from "node:test";
import assert from "node:assert/strict";
import { AdvancedSkillRegistry } from "./advanced-skill-runtime.js";
import { dependencyScheduler, executionTraceAnalyzer, crashRecoveryAdvisor, registerVerifiedRuntimeRecoverySkills } from "./runtime-recovery-handlers.js";

test("dependency scheduler returns stable topological order and parallel batches", () => {
  const result = dependencyScheduler({ tasks: [
    { id: "deploy", dependencies: ["test", "docs"] },
    { id: "docs", dependencies: ["inspect"] },
    { id: "test", dependencies: ["inspect"] },
    { id: "inspect", dependencies: [] },
  ] }) as { order: string[]; batches: string[][]; executesTasks: boolean };
  assert.deepEqual(result.order, ["inspect", "docs", "test", "deploy"]);
  assert.deepEqual(result.batches[0], ["inspect"]);
  assert.equal(result.executesTasks, false);
});

test("dependency scheduler rejects duplicate IDs, unknown edges, and cycles", () => {
  assert.throws(() => dependencyScheduler({ tasks: [{ id: "x" }, { id: "x" }] }), /unique/);
  assert.throws(() => dependencyScheduler({ tasks: [{ id: "x", dependencies: ["missing"] }] }), /unknown dependency/);
  assert.throws(() => dependencyScheduler({ tasks: [{ id: "x", dependencies: ["y"] }, { id: "y", dependencies: ["x"] }] }), /cycle/);
});

test("trace analyzer counts failures and derives duration without mutating events", () => {
  const events = [
    { id: "finish", status: "failed", timestamp: 50 },
    { id: "start", status: "started", timestamp: 10 },
  ];
  const result = executionTraceAnalyzer({ events }) as { eventCount: number; durationMs: number; failedEventIds: string[]; needsRecoveryReview: boolean };
  assert.equal(result.eventCount, 2);
  assert.equal(result.durationMs, 40);
  assert.deepEqual(result.failedEventIds, ["finish"]);
  assert.equal(result.needsRecoveryReview, true);
  assert.equal(events[0]?.id, "finish");
});

test("trace analyzer rejects malformed and excessive event data", () => {
  assert.throws(() => executionTraceAnalyzer({ events: [{ id: "x", status: "unknown", timestamp: 0 }] }), /status is invalid/);
  assert.throws(() => executionTraceAnalyzer({ events: [{ id: "x", status: "started", timestamp: Infinity }] }), /timestamp/);
});

test("crash recovery requires review and never resumes automatically", () => {
  const checkpoint = crashRecoveryAdvisor({ state: "checkpointed", hasCheckpoint: true, idempotent: true, sideEffectsStarted: true }) as { recommendation: string; automaticResume: boolean; requiresHumanReview: boolean };
  assert.equal(checkpoint.recommendation, "resume-from-checkpoint-review");
  assert.equal(checkpoint.automaticResume, false);
  assert.equal(checkpoint.requiresHumanReview, true);
  const unsafe = crashRecoveryAdvisor({ state: "failed", hasCheckpoint: false, idempotent: false, sideEffectsStarted: true }) as { recommendation: string };
  assert.equal(unsafe.recommendation, "manual-investigation");
});

test("verified runtime recovery handlers register through the guarded registry", () => {
  const registry = new AdvancedSkillRegistry();
  assert.deepEqual(registerVerifiedRuntimeRecoverySkills(registry), ["runtime.04", "runtime.05", "runtime.07"]);
  assert.equal(registry.has("runtime.04"), true);
  assert.equal(registry.has("runtime.05"), true);
  assert.equal(registry.has("runtime.07"), true);
});
