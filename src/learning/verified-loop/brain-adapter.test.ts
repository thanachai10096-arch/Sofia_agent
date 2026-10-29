import assert from "node:assert/strict";
import test from "node:test";
import { createVerifiedCompletionHandler, type FinalizedBrainCompletion } from "./brain-adapter.js";
import type { LearningScope } from "./ports.js";
import type { VerifiedLearningLoop } from "./loop.js";
import type { SelfImprovementCheckpointStore } from "./self-improvement.js";

const scope: LearningScope = { tenantId: "tenant-1", principalId: "principal-1", projectId: "project-1" };

function completion(overrides: Partial<FinalizedBrainCompletion> = {}): FinalizedBrainCompletion {
  return {
    runId: "run-1",
    principalId: scope.principalId,
    task: "Repair and verify the build",
    evidenceIds: ["evidence-1"],
    verification: [{
      criterionId: "build",
      passed: true,
      detail: "Build passed",
      evidenceIds: ["evidence-1"],
      workspaceRevision: "revision-1",
    }],
    ...overrides,
  };
}

function checkpointFixture() {
  let state = { lastSequence: 0, pending: [] as Array<{ sequence: number; receiptId: string; summary: string }> };
  const checkpoints: SelfImprovementCheckpointStore = {
    async read() { return structuredClone(state); },
    async write(_scope, next) { state = structuredClone(next); },
  };
  return { checkpoints, getState: () => state };
}

test("verified-completion bridge ignores incomplete/unverified callbacks before receipt persistence", async () => {
  const checkpoint = checkpointFixture();
  let persisted = false;
  const handler = createVerifiedCompletionHandler({
    loop: { async recordVerifiedCompletion() { assert.fail("unverified callback must not enter learning"); } } as unknown as VerifiedLearningLoop,
    resolveScope: async () => scope,
    persistFinalizedReceipt: async () => { persisted = true; return { receiptId: "receipt-1", sequence: 1 }; },
    checkpoints: checkpoint.checkpoints,
    redact: value => value,
  });

  await handler(completion({ verification: [{ criterionId: "build", passed: false, detail: "failed", evidenceIds: [], workspaceRevision: "revision-1" }] }));
  assert.equal(persisted, false);
  assert.equal(checkpoint.getState().lastSequence, 0);
});

test("verified-completion bridge persists an authoritative receipt before delivering scoped learning", async () => {
  const checkpoint = checkpointFixture();
  const order: string[] = [];
  const delivered: Array<{ scope: LearningScope; receiptId: string; summary: string }> = [];
  const handler = createVerifiedCompletionHandler({
    loop: {
      async recordVerifiedCompletion(receivedScope: LearningScope, receiptId: string, summary: string) {
        order.push("learn");
        delivered.push({ scope: receivedScope, receiptId, summary });
        return { recorded: true };
      },
    } as unknown as VerifiedLearningLoop,
    resolveScope: async () => scope,
    persistFinalizedReceipt: async (_input, receivedScope) => {
      order.push("persist");
      assert.deepEqual(receivedScope, scope);
      return { receiptId: "receipt-authoritative-1", sequence: 1 };
    },
    checkpoints: checkpoint.checkpoints,
    redact: value => value,
  });

  await handler(completion());
  assert.deepEqual(order, ["persist", "learn"]);
  assert.deepEqual(delivered, [{ scope, receiptId: "receipt-authoritative-1", summary: "Repair and verify the build" }]);
  assert.equal(checkpoint.getState().lastSequence, 1);
});
