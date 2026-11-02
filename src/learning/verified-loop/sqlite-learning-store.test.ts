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

async function seedSkillProvenance(tx: import("./ports.js").LearningTransaction, skill: ActiveLearningSkill): Promise<void> {
  await tx.insertExperienceIfAbsent(experience("seed-" + skill.id, skill.experienceId));
  await tx.putCandidate({
    id: skill.id, scope: skill.scope, experienceId: skill.experienceId,
    name: skill.name, trigger: skill.trigger, procedure: [...skill.procedure],
    confidence: skill.confidence,
  });
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
      const skill = activeSkill("skill-1");
      await seedSkillProvenance(tx, skill);
      await tx.activateSkill(skill);
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

test("SQLite learning store requires active skills to match persisted candidate provenance", async () => {
  const store = await SqliteLearningTransactionStore.open(":memory:");
  try {
    await store.transaction(scope, async tx => {
      const skill = activeSkill("unproven-skill");
      await assert.rejects(
        tx.activateSkill(skill),
        /Active learning skill requires a persisted candidate/,
      );

      await tx.insertExperienceIfAbsent(experience("provenance-receipt", skill.experienceId));
      await tx.putCandidate({
        id: skill.id, scope, experienceId: skill.experienceId,
        name: "different-name", trigger: skill.trigger,
        procedure: [...skill.procedure], confidence: skill.confidence,
      });
      await assert.rejects(
        tx.activateSkill(skill),
        /Active learning skill does not match its persisted candidate/,
      );
      assert.deepEqual(await tx.listActiveSkills(scope), []);
    });
  } finally {
    store.close();
  }
});

test("SQLite learning store rejects an active-skill payload whose persisted scope was tampered", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-learning-tamper-"));
  const file = path.join(directory, "learning.sqlite");
  try {
    const store = await SqliteLearningTransactionStore.open(file);
    await store.transaction(scope, async tx => {
      const skill = activeSkill("tampered-skill");
      await seedSkillProvenance(tx, skill);
      await tx.activateSkill(skill);
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

test("SQLite learning store rejects active-skill payload identity drift from indexed columns", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-learning-identity-"));
  const file = path.join(directory, "learning.sqlite");
  try {
    const store = await SqliteLearningTransactionStore.open(file);
    await store.transaction(scope, async tx => {
      const skill = activeSkill("identity-skill");
      await seedSkillProvenance(tx, skill);
      await tx.activateSkill(skill);
    });
    store.close();

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    try {
      const tampered = { ...activeSkill("identity-skill"), id: "different-skill", name: "different-name", policyRevision: "policy-2" };
      db.prepare("UPDATE learning_active_skills SET payload=? WHERE tenant_id=? AND principal_id=? AND project_id=? AND skill_id=?")
        .run(JSON.stringify(tampered), scope.tenantId, scope.principalId, scope.projectId, "identity-skill");
    } finally {
      db.close();
    }

    const reopened = await SqliteLearningTransactionStore.open(file);
    try {
      await assert.rejects(
        reopened.transaction(scope, tx => tx.listActiveSkills(scope)),
        /Corrupt persisted learning active skill identity/,
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite learning store rejects experience payload identity drift from indexed columns", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-learning-experience-identity-"));
  const file = path.join(directory, "learning.sqlite");
  try {
    const store = await SqliteLearningTransactionStore.open(file);
    await store.transaction(scope, tx => tx.insertExperienceIfAbsent(experience("identity-receipt")));
    store.close();

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    try {
      const tampered = { ...experience("identity-receipt"), id: "different-experience", receiptId: "different-receipt" };
      db.prepare("UPDATE learning_experiences SET payload=? WHERE tenant_id=? AND principal_id=? AND project_id=? AND receipt_id=?")
        .run(JSON.stringify(tampered), scope.tenantId, scope.principalId, scope.projectId, "identity-receipt");
    } finally {
      db.close();
    }

    const reopened = await SqliteLearningTransactionStore.open(file);
    try {
      await assert.rejects(
        reopened.transaction(scope, tx => tx.listExperiences(scope, 10)),
        /Corrupt persisted learning experience receipt identity/,
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite learning store rejects experience ID drift from its indexed column", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-learning-experience-id-"));
  const file = path.join(directory, "learning.sqlite");
  try {
    const store = await SqliteLearningTransactionStore.open(file);
    await store.transaction(scope, tx => tx.insertExperienceIfAbsent(experience("stable-receipt")));
    store.close();

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    try {
      const tampered = { ...experience("stable-receipt"), id: "forged-experience" };
      db.prepare("UPDATE learning_experiences SET payload=? WHERE tenant_id=? AND principal_id=? AND project_id=? AND receipt_id=?")
        .run(JSON.stringify(tampered), scope.tenantId, scope.principalId, scope.projectId, "stable-receipt");
    } finally {
      db.close();
    }

    const reopened = await SqliteLearningTransactionStore.open(file);
    try {
      await assert.rejects(
        reopened.transaction(scope, tx => tx.getExperience(scope, "experience-stable-receipt")),
        /Corrupt persisted learning experience identity/,
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite learning store rejects candidate payload identity drift from indexed columns", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-learning-candidate-identity-"));
  const file = path.join(directory, "learning.sqlite");
  try {
    const store = await SqliteLearningTransactionStore.open(file);
    await store.transaction(scope, async tx => {
      await tx.putCandidate({
        id: "candidate-original", scope, experienceId: "experience-r1",
        name: "candidate", trigger: "task", procedure: ["inspect"], confidence: 0.8,
      });
    });
    store.close();

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    try {
      const tampered = {
        id: "candidate-forged", scope, experienceId: "experience-r1",
        name: "candidate", trigger: "task", procedure: ["inspect"], confidence: 0.8,
      };
      db.prepare("UPDATE learning_candidates SET payload=? WHERE tenant_id=? AND principal_id=? AND project_id=? AND candidate_id=?")
        .run(JSON.stringify(tampered), scope.tenantId, scope.principalId, scope.projectId, "candidate-original");
    } finally {
      db.close();
    }

    const reopened = await SqliteLearningTransactionStore.open(file);
    try {
      await assert.rejects(
        reopened.transaction(scope, tx => tx.getCandidate(scope, "candidate-original")),
        /Corrupt persisted learning candidate identity/,
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite learning store refuses evaluations without a persisted candidate", async () => {
  const store = await SqliteLearningTransactionStore.open(":memory:");
  try {
    await assert.rejects(
      store.transaction(scope, tx => tx.recordEvaluation(scope, "missing-candidate", {
        regressionRunId: "regression-run", passed: false,
        checks: [{ name: "build", passed: false }],
        regressionEvidenceIds: ["regression-evidence"],
      })),
      /Learning evaluation requires a persisted candidate/,
    );
  } finally {
    store.close();
  }
});

test("SQLite learning store rejects malformed persisted evaluation fields before writing", async () => {
  const store = await SqliteLearningTransactionStore.open(":memory:");
  try {
    await store.transaction(scope, async tx => {
      await tx.putCandidate({
        id: "evaluation-candidate", scope, experienceId: "experience-r1",
        name: "candidate", trigger: "task", procedure: ["inspect"], confidence: 0.8,
      });
      await assert.rejects(
        tx.recordEvaluation(scope, "evaluation-candidate", {
          regressionRunId: "regression-run", passed: true,
          checks: [{ name: " ", passed: true }],
          regressionEvidenceIds: ["regression-evidence"],
        }),
        /Corrupt persisted learning evaluation/,
      );
      await assert.rejects(
        tx.recordEvaluation(scope, "evaluation-candidate", {
          regressionRunId: "regression-run", passed: true,
          checks: [{ name: "build", passed: true }],
          regressionEvidenceIds: [""],
        }),
        /Corrupt persisted learning evaluation/,
      );
    });
  } finally {
    store.close();
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
