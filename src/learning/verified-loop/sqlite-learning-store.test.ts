import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteLearningTransactionStore } from "./sqlite-learning-store.js";
import type { ActiveLearningSkill, LearningExperience, LearningScope } from "./ports.js";

const scope: LearningScope = { tenantId: "tenant", principalId: "user", projectId: "project" };
function experience(receiptId: string, id = "experience-" + receiptId): LearningExperience {
  return { id, scope, receiptId, runId: "run-" + receiptId, evidenceIds: ["evidence-" + receiptId], summary: "verified task", taskFingerprint: "fingerprint", createdAt: new Date().toISOString() };
}
function activeSkill(id: string): ActiveLearningSkill {
  return { id, scope, experienceId: "experience-r1", name: "learned-task", trigger: "task", procedure: ["inspect", "verify"], confidence: 0.9, status: "active", activatedAt: new Date().toISOString(), policyRevision: "policy-1" };
}

test("SQLite learning transactions persist experiences and skills across reopen", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-learning-store-"));
  const file = path.join(directory, "learning.sqlite");
  try {
    const store = await SqliteLearningTransactionStore.open(file);
    await store.transaction(scope, async tx => {
      assert.equal(await tx.insertExperienceIfAbsent(experience("r1")), true);
      assert.equal(await tx.insertExperienceIfAbsent(experience("r1", "duplicate")), false);
      assert.equal((await tx.getExperienceByReceipt(scope, "r1"))?.id, "experience-r1");
      assert.equal(await tx.getExperienceByReceipt(scope, "missing"), undefined);
      await tx.activateSkill(activeSkill("skill-1"));
    });
    store.close();

    const reopened = await SqliteLearningTransactionStore.open(file);
    await reopened.transaction(scope, async tx => {
      assert.equal((await tx.listExperiences(scope, 10)).length, 1);
      assert.equal((await tx.listActiveSkills(scope)).length, 1);
      let isolated = false;
      try { await tx.listExperiences({ ...scope, projectId: "other" }, 10); } catch { isolated = true; }
      assert.equal(isolated, true);
    });
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite learning transaction rolls back all writes when the operation fails", async () => {
  const store = await SqliteLearningTransactionStore.open(":memory:");
  try {
    await assert.rejects(store.transaction(scope, async tx => {
      await tx.insertExperienceIfAbsent(experience("rollback"));
      throw new Error("simulated failure");
    }), /simulated failure/);
    await store.transaction(scope, async tx => {
      assert.equal((await tx.listExperiences(scope, 10)).length, 0);
    });
  } finally {
    store.close();
  }
});

test("SQLite learning transactions reject cross-scope writes", async () => {
  const store = await SqliteLearningTransactionStore.open(":memory:");
  try {
    await assert.rejects(store.transaction(scope, tx => tx.insertExperienceIfAbsent({
      ...experience("cross"), scope: { ...scope, tenantId: "other-tenant" },
    })), /Cross-scope learning access rejected/);
  } finally {
    store.close();
  }
});
