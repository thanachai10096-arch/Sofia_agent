import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemorySkillFeedbackStore,
  SkillFeedbackLedger,
  type SkillFeedbackInput,
} from "./skill-feedback.js";

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
