import test from "node:test";
import assert from "node:assert/strict";
import { executeLearningRepairPlan } from "./reconciliation-repair-executor.js";
import type { LearningRepairJournal, LearningRepairJournalEntry, LearningRepairAuditEvent, LearningRepairExecutorHost, LearningRepairSnapshot } from "./reconciliation-repair-executor.js";
import type { LearningRepairAction, LearningRepairPlan } from "./reconciliation-repair.js";
import type { LearningScope } from "./ports.js";

const scope: LearningScope = { tenantId: "tenant-a", principalId: "user-a", projectId: "project-a" };
const action: LearningRepairAction = { kind: "register-missing-runtime-skill", skillId: "skill-a", expectedPolicyRevision: "policy-4", scope, actorId: "operator-a", idempotencyKey: JSON.stringify(["repair-key-a", "skill-a"]) };
const plan: LearningRepairPlan = { planId: "repair-key-a", scope, actions: [action], blocked: [], eligibleForExecutor: true };
function snapshot(overrides: Partial<LearningRepairSnapshot> = {}): LearningRepairSnapshot {
  return { scope, exists: false, active: false, policyRevision: "policy-4", explicitlyApproved: true, trustedEvidenceValid: true, ...overrides };
}
class MemoryJournal implements LearningRepairJournal {
  entries = new Map<string, LearningRepairJournalEntry>();
  events: LearningRepairAuditEvent[] = [];
  async get(key: string, requested: LearningScope) {
    const entry = this.entries.get(key);
    if (entry && (entry.scope.tenantId !== requested.tenantId || entry.scope.principalId !== requested.principalId || entry.scope.projectId !== requested.projectId)) throw new Error("Cross-scope");
    return entry;
  }
  async begin(entry: LearningRepairJournalEntry) {
    const prior = this.entries.get(entry.key);
    if (prior && (prior.scope.tenantId !== entry.scope.tenantId || prior.scope.principalId !== entry.scope.principalId || prior.scope.projectId !== entry.scope.projectId || prior.skillId !== entry.skillId || prior.policyRevision !== entry.policyRevision)) throw new Error("Key conflict");
    if (prior?.state === "succeeded" || prior?.state === "running") {
      return { ...prior, claimed: false };
    }
    const next = { ...entry, state: "running" as const, attempts: (prior?.attempts ?? 0) + 1, claimed: true };
    this.entries.set(entry.key, next);
    return next;
  }
  async finish(key: string, requested: LearningScope, state: "running" | "succeeded" | "failed", result?: string) {
    const prior = this.entries.get(key);
    if (!prior || prior.scope.tenantId !== requested.tenantId || prior.scope.principalId !== requested.principalId || prior.scope.projectId !== requested.projectId) throw new Error("Missing entry");
    this.entries.set(key, { ...prior, state, result, updatedAt: new Date().toISOString() });
  }
  async audit(event: LearningRepairAuditEvent) { this.events.push(event); }
}
function hostWith(current: () => LearningRepairSnapshot, register: () => Promise<void>): LearningRepairExecutorHost {
  return { revalidate: async () => current(), registerThroughLifecycle: register, now: () => new Date("2026-10-29T05:00:00.000Z") };
}

test("executes only after fresh checks and confirms the postcondition", async () => {
  const journal = new MemoryJournal();
  let active = false;
  let registrations = 0;
  const host = hostWith(() => snapshot({ exists: active, active }), async () => { registrations++; active = true; });
  const result = await executeLearningRepairPlan(plan, journal, host);
  assert.equal(result[0]?.state, "succeeded");
  assert.equal(registrations, 1);
  assert.equal(journal.entries.get(action.idempotencyKey)?.state, "succeeded");
  assert.ok(journal.events.some(e => e.event === "repair_started"));
  assert.ok(journal.events.some(e => e.event === "repair_succeeded"));
});

test("refuses stale policy or missing trusted evidence before registration", async () => {
  const journal = new MemoryJournal();
  let registrations = 0;
  const host = hostWith(() => snapshot({ policyRevision: "policy-stale", trustedEvidenceValid: false }), async () => { registrations++; });
  const result = await executeLearningRepairPlan(plan, journal, host);
  assert.equal(result[0]?.state, "failed");
  assert.equal(registrations, 0);
  assert.equal(journal.entries.get(action.idempotencyKey)?.state, "failed");
});

test("does not steal an existing running claim from another executor", async () => {
  const journal = new MemoryJournal();
  await journal.begin({ key: action.idempotencyKey, scope, skillId: action.skillId, policyRevision: action.expectedPolicyRevision, state: "running", attempts: 0, updatedAt: new Date().toISOString() });
  let registrations = 0;
  const host = hostWith(() => snapshot(), async () => { registrations++; });
  const result = await executeLearningRepairPlan(plan, journal, host);
  assert.equal(result[0]?.state, "failed");
  assert.match(result[0]?.reason ?? "", /already running/);
  assert.equal(registrations, 0);
  assert.equal(journal.entries.get(action.idempotencyKey)?.state, "running");
});

test("refuses ineligible plans and cross-scope actions", async () => {
  const journal = new MemoryJournal();
  const host = hostWith(() => snapshot(), async () => {});
  await assert.rejects(() => executeLearningRepairPlan({ ...plan, eligibleForExecutor: false }, journal, host), /not eligible/);
  await assert.rejects(() => executeLearningRepairPlan({ ...plan, actions: [{ ...action, scope: { ...scope, tenantId: "tenant-b" } }] }, journal, host), /cross-scope/);
});

test("rejects an action whose idempotency key is not bound to the plan and skill", async () => {
  const journal = new MemoryJournal();
  let registrations = 0;
  const host = hostWith(() => snapshot(), async () => { registrations++; });
  await assert.rejects(
    () => executeLearningRepairPlan({ ...plan, actions: [{ ...action, idempotencyKey: "unrelated-key" }] }, journal, host),
    /unbound/,
  );
  assert.equal(registrations, 0);
});

test("detects drift after a journaled success instead of silently claiming healthy state", async () => {
  const journal = new MemoryJournal();
  await journal.begin({ key: action.idempotencyKey, scope, skillId: action.skillId, policyRevision: action.expectedPolicyRevision, state: "running", attempts: 0, updatedAt: new Date().toISOString() });
  await journal.finish(action.idempotencyKey, scope, "succeeded", "previously verified");
  let registrations = 0;
  const host = hostWith(() => snapshot({ exists: false, active: false }), async () => { registrations++; });
  const result = await executeLearningRepairPlan(plan, journal, host);
  assert.equal(result[0]?.state, "failed");
  assert.match(result[0]?.reason ?? "", /state drifted/);
  assert.equal(registrations, 0);
});


test("does not trust a raced journal success when authoritative runtime is still missing", async () => {
  const journal = new MemoryJournal();
  journal.begin = async (entry) => ({ ...entry, state: "succeeded", attempts: 2, result: "another worker completed" });
  let registrations = 0;
  const host = hostWith(() => snapshot({ exists: false, active: false }), async () => { registrations++; });
  const result = await executeLearningRepairPlan(plan, journal, host);
  assert.equal(result[0]?.state, "failed");
  assert.match(result[0]?.reason ?? "", /authoritative state is not active/);
  assert.equal(registrations, 0);
});
