import test from "node:test";
import assert from "node:assert/strict";
import { ScopedSelfImprovement, type SelfImprovementCheckpointStore } from "./self-improvement.js";
import type { LearningScope } from "./ports.js";

const scope: LearningScope = { tenantId: "t", principalId: "p", projectId: "proj" };
function makeStore(): SelfImprovementCheckpointStore {
  const states = new Map<string, { lastSequence: number; pending: Array<{ sequence: number; receiptId: string; summary: string }> }>();
  const key = (s: LearningScope) => [s.tenantId, s.principalId, s.projectId].join(":");
  return {
    async read(s) { return structuredClone(states.get(key(s)) ?? { lastSequence: 0, pending: [] }); },
    async write(s, state) { states.set(key(s), structuredClone(state)); },
  };
}
function makeLoop(calls: string[]) {
  return { async recordVerifiedCompletion(_scope: LearningScope, receiptId: string, summary: string) {
    calls.push(`${receiptId}:${summary}`);
    return { recorded: true };
  } } as never;
}
test("serializes events, buffers out-of-order notifications, and drains the gap", async () => {
  const calls: string[] = [];
  const checkpoints = makeStore();
  const worker = new ScopedSelfImprovement({ scope, loop: makeLoop(calls), checkpoints, redact: value => value.replace(/secret/gi, "[redacted]") });
  await worker.onVerifiedExecution({ sequence: 2, receiptId: "r2", summary: "secret second" });
  assert.deepEqual(calls, []);
  await worker.onVerifiedExecution({ sequence: 1, receiptId: "r1", summary: "first" });
  await worker.recoverPending();
  assert.deepEqual(calls, ["r1:first", "r2:[redacted] second"]);
  assert.deepEqual(await checkpoints.read(scope), { lastSequence: 2, pending: [] });
});
test("ignores duplicate or already-consumed notifications", async () => {
  const calls: string[] = [];
  const worker = new ScopedSelfImprovement({ scope, loop: makeLoop(calls), checkpoints: makeStore(), redact: value => value });
  await worker.onVerifiedExecution({ sequence: 1, receiptId: "r1", summary: "one" });
  await worker.onVerifiedExecution({ sequence: 1, receiptId: "r1", summary: "one" });
  assert.deepEqual(calls, ["r1:one"]);
});
test("rejects invalid sequence numbers", async () => {
  const worker = new ScopedSelfImprovement({ scope, loop: makeLoop([]), checkpoints: makeStore(), redact: value => value });
  await assert.rejects(worker.onVerifiedExecution({ sequence: 0, receiptId: "r", summary: "x" }), /Invalid verified execution notification/);
});

test("rejects a different receipt ID for an already-pending sequence without replacing it", async () => {
  const calls: string[] = [];
  const checkpoints = makeStore();
  const worker = new ScopedSelfImprovement({ scope, loop: makeLoop(calls), checkpoints, redact: value => value });
  await worker.onVerifiedExecution({ sequence: 2, receiptId: "r2-original", summary: "original" });
  await assert.rejects(
    worker.onVerifiedExecution({ sequence: 2, receiptId: "r2-conflict", summary: "conflict" }),
    /Conflicting receipt IDs for the same pending sequence/,
  );
  assert.deepEqual(await checkpoints.read(scope), {
    lastSequence: 0,
    pending: [{ sequence: 2, receiptId: "r2-original", summary: "original" }],
  });
  assert.deepEqual(calls, []);
});

test("rejects reuse of a pending receipt ID at a different sequence", async () => {
  const calls: string[] = [];
  const checkpoints = makeStore();
  const worker = new ScopedSelfImprovement({ scope, loop: makeLoop(calls), checkpoints, redact: value => value });
  await worker.onVerifiedExecution({ sequence: 2, receiptId: "same-receipt", summary: "buffered" });
  await assert.rejects(
    worker.onVerifiedExecution({ sequence: 3, receiptId: "same-receipt", summary: "duplicate identity" }),
    /Receipt ID is already assigned to a different pending sequence/,
  );
  assert.deepEqual(await checkpoints.read(scope), {
    lastSequence: 0,
    pending: [{ sequence: 2, receiptId: "same-receipt", summary: "buffered" }],
  });
  assert.deepEqual(calls, []);
});
