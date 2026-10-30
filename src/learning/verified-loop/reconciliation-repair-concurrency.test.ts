import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteLearningRepairJournal, executeLearningRepairPlan } from "./reconciliation-repair-executor.js";
import type { LearningRepairSnapshot, LearningRepairExecutorHost } from "./reconciliation-repair-executor.js";
import type { LearningRepairAction, LearningRepairPlan } from "./reconciliation-repair.js";
import type { LearningScope } from "./ports.js";

const scope: LearningScope = { tenantId: "tenant-concurrent", principalId: "operator-concurrent", projectId: "project-concurrent" };
const action: LearningRepairAction = {
  kind: "register-missing-runtime-skill",
  skillId: "skill-concurrent",
  expectedPolicyRevision: "policy-concurrent",
  scope,
  actorId: "operator-concurrent",
  idempotencyKey: JSON.stringify(["plan-concurrent", "skill-concurrent"]),
};
const plan: LearningRepairPlan = {
  planId: "plan-concurrent",
  scope,
  actions: [action],
  blocked: [],
  eligibleForExecutor: true,
};
const snapshot = (exists: boolean, active: boolean): LearningRepairSnapshot => ({
  scope, exists, active, policyRevision: "policy-concurrent",
  explicitlyApproved: true, trustedEvidenceValid: true,
});

test("two concurrent executors cannot register the same skill twice", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofia-repair-concurrent-"));
  const journal = await SqliteLearningRepairJournal.open(path.join(dir, "repair.sqlite"));
  let active = false;
  let registrations = 0;
  let initialChecks = 0;
  let releaseInitialChecks!: () => void;
  const initialChecksReady = new Promise<void>(resolve => { releaseInitialChecks = resolve; });

  const host: LearningRepairExecutorHost = {
    async revalidate() {
      // Force both executors to observe the same initially-missing runtime state
      // before either can claim the journal entry.
      if (initialChecks < 2) {
        const observedActive = active;
        initialChecks++;
        if (initialChecks === 2) releaseInitialChecks();
        await initialChecksReady;
        return snapshot(observedActive, observedActive);
      }
      return snapshot(active, active);
    },
    async registerThroughLifecycle() {
      registrations++;
      await Promise.resolve();
      active = true;
    },
    now: () => new Date("2026-10-29T06:00:00.000Z"),
  };

  try {
    const results = await Promise.all([
      executeLearningRepairPlan(plan, journal, host),
      executeLearningRepairPlan(plan, journal, host),
    ]);
    assert.equal(registrations, 1, "exactly one executor may call the lifecycle adapter");
    assert.equal(active, true);
    assert.equal(results.flat().filter(result => result.state === "succeeded").length, 1);
    assert.equal(results.flat().filter(result => result.state === "failed").length, 1);
    assert.equal((await journal.get(action.idempotencyKey, scope))?.state, "succeeded");
  } finally {
    journal.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
