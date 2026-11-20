import assert from "node:assert/strict";
import test from "node:test";
import { createBrainSkillFeedbackRecorder } from "./brain-skill-feedback-adapter.js";
import { InMemorySkillFeedbackStore, SkillFeedbackLedger } from "./skill-feedback.js";
import { ControlledSkillRegistry, InMemorySkillRegistryStore } from "./skill-registry.js";
import { digestSkillCandidate } from "./skill-evaluator.js";

async function setup() {
  const candidate = {
    name: "repair-runtime_error",
    trigger: "Runtime failure during a task",
    category: "runtime_error" as const,
    strategy: "fix-implementation" as const,
    procedure: ["inspect trusted failure evidence", "apply minimal repair"],
    verification: ["typecheck", "test", "build"],
    evidenceIds: ["evaluation-run-1"],
  };
  const digest = digestSkillCandidate(candidate);
  const registryStore = new InMemorySkillRegistryStore();
  const registry = new ControlledSkillRegistry(registryStore);
  const promoted = await registry.promote({
    identity: { actor: "owner-1", scope: "project-1" },
    candidate,
    evidence: {
      candidateDigest: digest, artifactVersion: "v1",
      testsPassed: true, adversarialTestsPassed: true, benchmarkScore: 0.97,
      safetyIncidents: 0, versionedArtifact: true, rollbackAvailable: true,
    },
    expectedActiveVersion: null,
  });
  assert.equal(promoted.ok, true);
  return { candidate, registryStore, ledger: new SkillFeedbackLedger(new InMemorySkillFeedbackStore()) };
}

test("Brain skill execution events record feedback for the active registered version", async () => {
  const { registryStore, ledger } = await setup();
  const recorder = createBrainSkillFeedbackRecorder({
    registry: registryStore,
    ledger,
    resolveScope: async (principalId) => principalId === "user-1" ? "project-1" : "",
    resolveSafetyIncidentCount: async () => 0,
  });
  const event = {
    runId: "run-1", principalId: "user-1",
    skillId: "learned:repair-runtime_error:runtime_error",
    stepId: "step-1", tool: "shell.exec", outcome: "succeeded" as const,
    evidenceId: "tool-evidence-1",
  };
  await recorder(event);
  await recorder(event);
  const summary = await ledger.summarize("project-1", "repair-runtime_error", "v1");
  assert.equal(summary?.total, 1);
  assert.equal(summary?.succeeded, 1);
  assert.deepEqual(summary?.evidenceIds, ["tool-evidence-1"]);
});

test("Brain skill feedback uses the host safety monitor count", async () => {
  const { registry, ledger } = await setup();
  const recorder = createBrainSkillFeedbackRecorder({
    registry: registry["store"] as never,
    ledger,
    resolveScope: () => "project-1",
    resolveSafetyIncidentCount: () => 1,
  });
  await recorder({
    runId: "run-2", principalId: "user-1",
    skillId: "learned:repair-runtime_error:runtime_error",
    stepId: "step-2", tool: "shell.exec", outcome: "failed",
    evidenceId: "tool-evidence-2",
  });
  const summary = await ledger.summarize("project-1", "repair-runtime_error", "v1");
  assert.equal(summary?.safetyIncidents, 1);
  assert.equal(summary?.recommendation, "disable-pending-review");
});

test("Brain skill feedback ignores built-in skills and events without a principal", async () => {
  const { registry, ledger } = await setup();
  const recorder = createBrainSkillFeedbackRecorder({
    registry: registry["store"] as never,
    ledger,
    resolveScope: () => "project-1",
    resolveSafetyIncidentCount: () => 0,
  });
  await recorder({
    runId: "run-3", principalId: "user-1", skillId: "typescript-error-repair",
    stepId: "step-3", tool: "shell.exec", outcome: "succeeded", evidenceId: "e-3",
  });
  await recorder({
    runId: "run-4", skillId: "learned:repair-runtime_error:runtime_error",
    stepId: "step-4", tool: "shell.exec", outcome: "succeeded", evidenceId: "e-4",
  });
  assert.equal(await ledger.summarize("project-1", "repair-runtime_error", "v1"), null);
});
