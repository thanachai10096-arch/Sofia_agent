import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemorySkillFeedbackStore,
  SkillFeedbackLedger,
  proposeSkillImprovement,
  type SkillFeedbackInput,
} from "./skill-feedback.js";
import { digestSkillCandidate } from "./skill-evaluator.js";

const base: SkillFeedbackInput = {
  scope: "project-a", actor: "trusted-runtime", skillName: "repair-build",
  skillVersion: "v1", candidateDigest: "a".repeat(64), outcome: "succeeded",
  evidenceIds: ["run-1"], safetyIncidentCount: 0, idempotencyKey: "job-1:step-1",
};

test("feedback ledger records verified outcomes and is idempotent", async () => {
  const ledger = new SkillFeedbackLedger(new InMemorySkillFeedbackStore());
  const first = await ledger.record(base);
  const duplicate = await ledger.record(base);
  assert.equal(first.recorded, true);
  assert.equal(duplicate.recorded, false);
  assert.equal(duplicate.feedback.id, first.feedback.id);
});

test("feedback aggregates only the requested skill version", async () => {
  const ledger = new SkillFeedbackLedger(new InMemorySkillFeedbackStore());
  for (let i = 0; i < 4; i += 1) {
    await ledger.record({ ...base, idempotencyKey: `ok-${i}`, evidenceIds: [`e-${i}`] });
  }
  await ledger.record({ ...base, skillVersion: "v2", idempotencyKey: "other-version" });
  const summary = await ledger.summarize("project-a", "repair-build", "v1");
  assert.equal(summary?.total, 4);
  assert.equal(summary?.successRate, 1);
  assert.equal(summary?.recommendation, "insufficient-data");
  assert.equal(summary?.evidenceIds.length, 4);
});

test("feedback flags repeated failures for review", async () => {
  const ledger = new SkillFeedbackLedger(new InMemorySkillFeedbackStore());
  for (let i = 0; i < 5; i += 1) {
    await ledger.record({ ...base, outcome: i < 2 ? "succeeded" : "failed", idempotencyKey: `mix-${i}` });
  }
  const summary = await ledger.summarize("project-a", "repair-build", "v1");
  assert.equal(summary?.recommendation, "review");
  assert.equal(summary?.successRate, 0.4);
});

test("any trusted safety incident escalates to pending disable review", async () => {
  const ledger = new SkillFeedbackLedger(new InMemorySkillFeedbackStore());
  for (let i = 0; i < 5; i += 1) {
    await ledger.record({ ...base, idempotencyKey: `safe-${i}`, safetyIncidentCount: i === 0 ? 1 : 0 });
  }
  const summary = await ledger.summarize("project-a", "repair-build", "v1");
  assert.equal(summary?.recommendation, "disable-pending-review");
});

test("feedback rejects missing evidence, invalid digest and negative incidents", async () => {
  const ledger = new SkillFeedbackLedger(new InMemorySkillFeedbackStore());
  await assert.rejects(() => ledger.record({ ...base, evidenceIds: [] }), /malformed/);
  await assert.rejects(() => ledger.record({ ...base, candidateDigest: "bad" }), /malformed/);
  await assert.rejects(() => ledger.record({ ...base, safetyIncidentCount: -1 }), /malformed/);
});

test("concurrent duplicate events are recorded exactly once", async () => {
  const ledger = new SkillFeedbackLedger(new InMemorySkillFeedbackStore());
  const results = await Promise.all([ledger.record(base), ledger.record(base), ledger.record(base)]);
  assert.equal(results.filter((result) => result.recorded).length, 1);
  assert.equal((await ledger.summarize("project-a", "repair-build", "v1"))?.total, 1);
});


test("feedback proposes a new candidate for evaluation without promoting it", async () => {
  const ledger = new SkillFeedbackLedger(new InMemorySkillFeedbackStore());
  const candidate = {
    name: "repair-build", trigger: "Build fails", category: "runtime_error" as const,
    strategy: "fix-implementation" as const, procedure: ["inspect logs"],
    verification: ["run tests"], evidenceIds: ["run-1"],
  };
  const candidateDigest = digestSkillCandidate(candidate);
  for (let i = 0; i < 5; i += 1) {
    await ledger.record({
      ...base, candidateDigest, outcome: i < 2 ? "succeeded" : "failed",
      idempotencyKey: `proposal-${i}`,
    });
  }
  const summary = await ledger.summarize("project-a", "repair-build", "v1");
  assert.ok(summary);
  assert.equal(summary?.integrityValid, true);
  const proposal = await proposeSkillImprovement(
    candidate,
    summary!,
    async ({ current, feedback }) => ({
      candidate: {
        ...current,
        procedure: ["inspect logs", "reproduce failure", "apply minimal fix"],
        verification: ["run tests", "run build"],
        evidenceIds: feedback.evidenceIds,
      },
      rationale: "Failure evidence shows the existing procedure skipped reproduction.",
    }),
  );
  assert.ok(proposal);
  assert.notEqual(proposal.proposedCandidate.procedure.length, 1);
  assert.equal(proposal.feedbackEvidenceIds.length, 5);
});

test("feedback does not request revisions for insufficient or mismatched evidence", async () => {
  const ledger = new SkillFeedbackLedger(new InMemorySkillFeedbackStore());
  await ledger.record(base);
  const summary = await ledger.summarize("project-a", "repair-build", "v1");
  let called = false;
  const result = await proposeSkillImprovement(
    { name: "repair-build", trigger: "Build fails", category: "runtime_error", strategy: "fix-implementation", procedure: ["inspect"], verification: ["test"], evidenceIds: [] },
    summary!,
    async () => { called = true; throw new Error("must not run"); },
  );
  assert.equal(result, null);
  assert.equal(called, false);
});


test("feedback rejects idempotency-key reuse with altered outcome", async () => {
  const ledger = new SkillFeedbackLedger(new InMemorySkillFeedbackStore());
  await ledger.record(base);
  await assert.rejects(
    () => ledger.record({ ...base, outcome: "failed" }),
    /reused with different feedback/,
  );
});


test("feedback refuses to draft revisions when evidence digests conflict", async () => {
  const ledger = new SkillFeedbackLedger(new InMemorySkillFeedbackStore());
  await ledger.record(base);
  await ledger.record({ ...base, candidateDigest: "b".repeat(64), idempotencyKey: "different-digest" });
  const summary = await ledger.summarize("project-a", "repair-build", "v1");
  assert.equal(summary?.integrityValid, false);
  assert.equal(summary?.recommendation, "review");
  let called = false;
  const proposal = await proposeSkillImprovement(
    { name: "repair-build", trigger: "Build fails", category: "runtime_error", strategy: "fix-implementation", procedure: ["inspect"], verification: ["test"], evidenceIds: [] },
    summary!,
    async () => { called = true; throw new Error("must not run"); },
  );
  assert.equal(proposal, null);
  assert.equal(called, false);
});
