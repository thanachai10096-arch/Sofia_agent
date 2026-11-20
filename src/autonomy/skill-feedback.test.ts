import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemorySkillFeedbackStore,
  SkillFeedbackLedger,
  type SkillFeedbackInput,
} from "./skill-feedback.js";

const input: SkillFeedbackInput = {
  scope: "tenant-project-a",
  actor: "trusted-host",
  skillName: "repair-build",
  skillVersion: "v1",
  candidateDigest: "a".repeat(64),
  outcome: "succeeded",
  evidenceIds: ["build-run-1"],
  safetyIncidentCount: 0,
  idempotencyKey: "execution-001",
};

test("skill feedback records a retry once and summarizes measured outcomes", async () => {
  const ledger = new SkillFeedbackLedger(new InMemorySkillFeedbackStore());
  const first = await ledger.record(input);
  const retry = await ledger.record({ ...input, evidenceIds: ["build-run-1", "build-run-1"] });
  assert.equal(first.recorded, true);
  assert.equal(retry.recorded, false);
  assert.equal(retry.feedback.id, first.feedback.id);

  for (let index = 2; index <= 5; index += 1) {
    await ledger.record({
      ...input,
      idempotencyKey: "execution-" + index,
      outcome: index === 5 ? "failed" : "succeeded",
      evidenceIds: ["build-run-" + index],
    });
  }
  const summary = await ledger.summarize(input.scope, input.skillName, input.skillVersion);
  assert.equal(summary?.total, 5);
  assert.equal(summary?.succeeded, 4);
  assert.equal(summary?.failed, 1);
  assert.equal(summary?.recommendation, "retain");
});

test("skill feedback rejects reuse of an idempotency key for a different outcome", async () => {
  const ledger = new SkillFeedbackLedger(new InMemorySkillFeedbackStore());
  await ledger.record(input);
  await assert.rejects(
    () => ledger.record({ ...input, outcome: "failed" }),
    /idempotency key was already used for a different execution outcome/u,
  );
});

test("safety incidents never auto-disable or mutate a skill; they only flag review", async () => {
  const ledger = new SkillFeedbackLedger(new InMemorySkillFeedbackStore());
  for (let index = 0; index < 5; index += 1) {
    await ledger.record({
      ...input,
      idempotencyKey: "incident-" + index,
      safetyIncidentCount: index === 0 ? 1 : 0,
      evidenceIds: ["evidence-" + index],
    });
  }
  const summary = await ledger.summarize(input.scope, input.skillName, input.skillVersion);
  assert.equal(summary?.recommendation, "disable-pending-review");
  assert.equal(summary?.safetyIncidents, 1);
});
