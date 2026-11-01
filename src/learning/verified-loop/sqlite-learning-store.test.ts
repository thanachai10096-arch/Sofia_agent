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

test("SQLite learning store rejects an active-skill payload whose persisted scope was tampered", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-learning-tamper-"));
  const file = path.join(directory, "learning.sqlite");
  try {
    const store = await SqliteLearningTransactionStore.open(file);
    await store.transaction(scope, async tx => {
      await tx.activateSkill(activeSkill("tampered-skill"));
    });
    store.close();

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    try {
      const tampered = activeSkill("tampered-skill");
      tampered.scope = { ...scope, tenantId: "another-tenant" };
      db.prepare("UPDATE learning_active_skills SET payload=? WHERE tenant_id=? AND principal_id=? AND project_id=? AND skill_id=?")
        .run(JSON.stringify(tampered), scope.tenantId, scope.principalId, scope.projectId, tampered.id);
    } finally {
      db.close();
    }

    const reopened = await SqliteLearningTransactionStore.open(file);
    try {
      await assert.rejects(
        reopened.transaction(scope, tx => tx.listActiveSkills(scope)),
        /Cross-scope learning access rejected/,
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite learning store serializes overlapping async transactions on one connection", async () => {
  const store = await SqliteLearningTransactionStore.open(":memory:");
  try {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let secondStarted = false;

    const first = store.transaction(scope, async tx => {
      markFirstStarted();
      await firstGate;
      await tx.insertExperienceIfAbsent(experience("concurrent-first"));
    });
    await firstStarted;

    const second = store.transaction(scope, async tx => {
      secondStarted = true;
      await tx.insertExperienceIfAbsent(experience("concurrent-second"));
    });
    await Promise.resolve();
    assert.equal(secondStarted, false, "second transaction must wait for the first transaction to finish");

    releaseFirst();
    await Promise.all([first, second]);
    await store.transaction(scope, async tx => {
      assert.deepEqual(
        (await tx.listExperiences(scope, 10)).map(item => item.receiptId),
        ["concurrent-first", "concurrent-second"],
      );
    });
  } finally {
    store.close();
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
