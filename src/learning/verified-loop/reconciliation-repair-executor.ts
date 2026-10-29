import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { LearningScope } from "./ports.js";
import type { LearningRepairAction, LearningRepairPlan } from "./reconciliation-repair.js";

type Db = DatabaseSyncType;
export type LearningRepairState = "running" | "succeeded" | "failed";
export interface LearningRepairJournalEntry {
  key: string;
  scope: LearningScope;
  skillId: string;
  policyRevision: string;
  state: LearningRepairState;
  attempts: number;
  updatedAt: string;
  result?: string;
  /** True only when this call atomically acquired the right to execute the repair. */
  claimed?: boolean;
  /** Opaque per-attempt fencing token; only the owner receives it. */
  claimToken?: string;
}
export interface LearningRepairAuditEvent {
  key: string;
  scope: LearningScope;
  actorId: string;
  skillId: string;
  event: "repair_started" | "repair_revalidated" | "repair_registered" | "repair_succeeded" | "repair_failed" | "repair_already_satisfied";
  at: string;
  detail?: string;
}
export interface LearningRepairJournal {
  get(key: string, scope: LearningScope): Promise<LearningRepairJournalEntry | undefined>;
  begin(entry: LearningRepairJournalEntry): Promise<LearningRepairJournalEntry>;
  finish(key: string, scope: LearningScope, state: LearningRepairState, result?: string, claimToken?: string): Promise<void>;
  audit(event: LearningRepairAuditEvent): Promise<void>;
}
export interface LearningRepairSnapshot {
  scope: LearningScope;
  exists: boolean;
  active: boolean;
  policyRevision: string;
  explicitlyApproved: boolean;
  trustedEvidenceValid: boolean;
}
export interface LearningRepairExecutorHost {
  /** Re-read authoritative learning, runtime, approval, evidence, and policy services. */
  revalidate(action: LearningRepairAction): Promise<LearningRepairSnapshot>;
  /** Must be idempotent for (scope, skillId, policyRevision); must use Sofia's existing lifecycle. */
  registerThroughLifecycle(action: LearningRepairAction): Promise<void>;
  now?: () => Date;
}
export interface LearningRepairExecutionResult {
  key: string;
  skillId: string;
  state: LearningRepairState;
  reason?: string;
}
const sameScope = (a: LearningScope, b: LearningScope) =>
  a.tenantId === b.tenantId && a.principalId === b.principalId && a.projectId === b.projectId;
const validScope = (scope: LearningScope) =>
  Boolean(scope && [scope.tenantId, scope.principalId, scope.projectId].every(v => typeof v === "string" && v.trim().length > 0));
function assertScope(scope: LearningScope): void {
  if (!validScope(scope)) throw new Error("Invalid repair scope");
}
function privateFile(file: string): void {
  if (process.platform === "win32" || file === ":memory:") return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Repair journal must be a regular file");
  const mode = stat.mode & 0o777;
  const restrictive = mode & 0o600;
  if (mode !== restrictive) fs.chmodSync(file, restrictive);
}

/** SQLite-backed idempotency journal and append-only audit events. */
export class SqliteLearningRepairJournal implements LearningRepairJournal {
  private tail: Promise<void> = Promise.resolve();
  private constructor(private readonly db: Db, private readonly file: string) {}
  static async open(file: string): Promise<SqliteLearningRepairJournal> {
    if (typeof file !== "string" || !file.trim()) throw new Error("Repair journal path is required");
    const absolute = file === ":memory:" ? file : path.resolve(file);
    if (absolute !== ":memory:") {
      fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
      try { const fd = fs.openSync(absolute, "wx", 0o600); fs.closeSync(fd); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      privateFile(absolute);
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(absolute);
    try {
      db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS learning_repair_journal (repair_key TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, project_id TEXT NOT NULL, skill_id TEXT NOT NULL, policy_revision TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed')), attempts INTEGER NOT NULL, updated_at TEXT NOT NULL, result TEXT, claim_token TEXT); CREATE TABLE IF NOT EXISTS learning_repair_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, repair_key TEXT NOT NULL, tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, project_id TEXT NOT NULL, actor_id TEXT NOT NULL, skill_id TEXT NOT NULL, event TEXT NOT NULL, at TEXT NOT NULL, detail TEXT); CREATE TRIGGER IF NOT EXISTS learning_repair_audit_no_update BEFORE UPDATE ON learning_repair_audit BEGIN SELECT RAISE(ABORT, 'learning repair audit is append-only'); END; CREATE TRIGGER IF NOT EXISTS learning_repair_audit_no_delete BEFORE DELETE ON learning_repair_audit BEGIN SELECT RAISE(ABORT, 'learning repair audit is append-only'); END;");
      const columns = db.prepare("PRAGMA table_info(learning_repair_journal)").all() as Array<{ name?: unknown }>;
      if (!columns.some(column => column.name === "claim_token")) db.exec("ALTER TABLE learning_repair_journal ADD COLUMN claim_token TEXT");
      privateFile(absolute);
      return new SqliteLearningRepairJournal(db, absolute);
    } catch (error) { db.close(); throw error; }
  }
  private serial<T>(operation: () => T): Promise<T> {
    const run = this.tail.then(operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
  get(key: string, scope: LearningScope): Promise<LearningRepairJournalEntry | undefined> {
    assertScope(scope);
    return this.serial(() => {
      const row = this.db.prepare("SELECT repair_key,tenant_id,principal_id,project_id,skill_id,policy_revision,state,attempts,updated_at,result,claim_token FROM learning_repair_journal WHERE repair_key=?").get(key) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      if (row.tenant_id !== scope.tenantId || row.principal_id !== scope.principalId || row.project_id !== scope.projectId) throw new Error("Cross-scope repair journal access rejected");
      return { key: String(row.repair_key), scope: { tenantId: String(row.tenant_id), principalId: String(row.principal_id), projectId: String(row.project_id) }, skillId: String(row.skill_id), policyRevision: String(row.policy_revision), state: row.state as LearningRepairState, attempts: Number(row.attempts), updatedAt: String(row.updated_at), ...(typeof row.result === "string" ? { result: row.result } : {}) };
    });
  }
  begin(entry: LearningRepairJournalEntry): Promise<LearningRepairJournalEntry> {
    assertScope(entry.scope);
    return this.serial(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const existing = this.db.prepare("SELECT repair_key,tenant_id,principal_id,project_id,skill_id,policy_revision,state,attempts,updated_at,result FROM learning_repair_journal WHERE repair_key=?").get(entry.key) as Record<string, unknown> | undefined;
        if (existing) {
          if (existing.tenant_id !== entry.scope.tenantId || existing.principal_id !== entry.scope.principalId || existing.project_id !== entry.scope.projectId || existing.skill_id !== entry.skillId || existing.policy_revision !== entry.policyRevision) throw new Error("Repair idempotency key conflicts with a different scoped action");
          if (existing.state === "succeeded" || existing.state === "running") {
            // A running entry may belong to another live process. Do not steal it:
            // without a lease/heartbeat protocol, stale-running recovery must be manual.
            this.db.exec("COMMIT");
            return { key: String(existing.repair_key), scope: { ...entry.scope }, skillId: String(existing.skill_id), policyRevision: String(existing.policy_revision), state: existing.state as LearningRepairState, attempts: Number(existing.attempts), updatedAt: String(existing.updated_at), ...(typeof existing.result === "string" ? { result: existing.result } : {}), claimed: false };
          }
          const claimToken = randomUUID();
          this.db.prepare("UPDATE learning_repair_journal SET state='running',attempts=attempts+1,updated_at=?,result=NULL,claim_token=? WHERE repair_key=? AND state='failed'").run(entry.updatedAt, claimToken, entry.key);
          this.db.exec("COMMIT");
          return { ...entry, state: "running", attempts: Number(existing.attempts) + 1, claimed: true, claimToken };
        } else {
          const claimToken = randomUUID();
          this.db.prepare("INSERT INTO learning_repair_journal (repair_key,tenant_id,principal_id,project_id,skill_id,policy_revision,state,attempts,updated_at,result,claim_token) VALUES (?,?,?,?,?,?,'running',1,?,NULL,?)").run(entry.key, entry.scope.tenantId, entry.scope.principalId, entry.scope.projectId, entry.skillId, entry.policyRevision, entry.updatedAt, claimToken);
          this.db.exec("COMMIT");
          return { ...entry, state: "running", attempts: 1, claimed: true, claimToken };
        }
      } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
    });
  }
  finish(key: string, scope: LearningScope, state: LearningRepairState, result?: string, claimToken?: string): Promise<void> {
    assertScope(scope);
    return this.serial(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.db.prepare("SELECT tenant_id,principal_id,project_id,claim_token FROM learning_repair_journal WHERE repair_key=?").get(key) as Record<string, unknown> | undefined;
        if (!row || row.tenant_id !== scope.tenantId || row.principal_id !== scope.principalId || row.project_id !== scope.projectId) throw new Error("Repair journal entry missing or scope mismatch");
        if (claimToken !== undefined) {
          if (typeof claimToken !== "string" || !claimToken || row.claim_token !== claimToken) throw new Error("Repair claim lost; stale executor cannot finalize this attempt");
          const updated = this.db.prepare("UPDATE learning_repair_journal SET state=?,updated_at=?,result=?,claim_token=NULL WHERE repair_key=? AND claim_token=?").run(state, new Date().toISOString(), result?.slice(0, 1000) ?? null, key, claimToken);
          if (Number(updated.changes) !== 1) throw new Error("Repair claim lost; stale executor cannot finalize this attempt");
        } else {
          // Backward-compatible path for legacy non-executor callers.
          this.db.prepare("UPDATE learning_repair_journal SET state=?,updated_at=?,result=?,claim_token=NULL WHERE repair_key=?").run(state, new Date().toISOString(), result?.slice(0, 1000) ?? null, key);
        }
        this.db.exec("COMMIT");
      } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
    });
  }
  audit(event: LearningRepairAuditEvent): Promise<void> {
    // Treat journal inputs as untrusted at runtime despite the TypeScript interface.
    // Validate the event container before dereferencing scope so malformed callers fail closed.
    if (!event || typeof event !== "object" || !event.scope || typeof event.scope !== "object") {
      throw new Error("Invalid learning repair audit event");
    }
    assertScope(event.scope);
    const allowedEvents = new Set<LearningRepairAuditEvent["event"]>(["repair_started", "repair_revalidated", "repair_registered", "repair_succeeded", "repair_failed", "repair_already_satisfied"]);
    if (typeof event.key !== "string" || !event.key.trim() || event.key.length > 500 ||
        typeof event.actorId !== "string" || !event.actorId.trim() || event.actorId.length > 200 ||
        typeof event.skillId !== "string" || !event.skillId.trim() || event.skillId.length > 200 ||
        !allowedEvents.has(event.event) || typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at)) ||
        (event.detail !== undefined && typeof event.detail !== "string")) {
      throw new Error("Invalid learning repair audit event");
    }
    return this.serial(() => {
      this.db.prepare("INSERT INTO learning_repair_audit (repair_key,tenant_id,principal_id,project_id,actor_id,skill_id,event,at,detail) VALUES (?,?,?,?,?,?,?,?,?)").run(event.key, event.scope.tenantId, event.scope.principalId, event.scope.projectId, event.actorId, event.skillId, event.event, event.at, event.detail?.slice(0, 1000) ?? null);
      privateFile(this.file);
    });
  }
  close(): void { this.db.close(); }
}

/**
 * Executes only planner-approved actions. It revalidates immediately before mutation,
 * journals before calling the lifecycle adapter, then verifies the postcondition. A
 * crash after registration is recovered by revalidation on replay. The lifecycle
 * adapter must itself be idempotent and must retain Sofia's explicit approval gate.
 */
export async function executeLearningRepairPlan(
  plan: LearningRepairPlan,
  journal: LearningRepairJournal,
  host: LearningRepairExecutorHost,
): Promise<LearningRepairExecutionResult[]> {
  if (!plan || !validScope(plan.scope) || !Array.isArray(plan.actions) || !Array.isArray(plan.blocked) ||
      plan.eligibleForExecutor !== true || plan.blocked.length !== 0 || plan.actions.length === 0) {
    throw new Error("Repair plan is not eligible for execution");
  }
  const results: LearningRepairExecutionResult[] = [];
  for (const action of plan.actions) {
    assertScope(action.scope);
    if (!sameScope(action.scope, plan.scope) || action.kind !== "register-missing-runtime-skill" ||
        typeof action.skillId !== "string" || !action.skillId.trim() || action.skillId.length > 200 ||
        typeof action.expectedPolicyRevision !== "string" || !action.expectedPolicyRevision.trim() || action.expectedPolicyRevision.length > 200 ||
        typeof action.actorId !== "string" || !action.actorId.trim() || action.actorId.length > 200 ||
        typeof action.idempotencyKey !== "string" || !action.idempotencyKey.trim() || action.idempotencyKey.length > 500 ||
        typeof plan.planId !== "string" || !plan.planId.trim() ||
        action.idempotencyKey !== JSON.stringify([plan.planId, action.skillId])) {
      throw new Error("Invalid, unbound, or cross-scope repair action");
    }
    const now = () => (host.now?.() ?? new Date()).toISOString();
    const existing = await journal.get(action.idempotencyKey, action.scope);
    const snapshot = await host.revalidate(action);
    if (!snapshot || !validScope(snapshot.scope) || !sameScope(snapshot.scope, action.scope) ||
        typeof snapshot.exists !== "boolean" || typeof snapshot.active !== "boolean" ||
        typeof snapshot.explicitlyApproved !== "boolean" || typeof snapshot.trustedEvidenceValid !== "boolean" ||
        typeof snapshot.policyRevision !== "string" || !snapshot.policyRevision.trim()) {
      throw new Error("Authoritative repair revalidation returned invalid state");
    }
    if (existing?.state === "succeeded") {
      if (snapshot.exists && snapshot.active && snapshot.policyRevision === action.expectedPolicyRevision && snapshot.explicitlyApproved && snapshot.trustedEvidenceValid) {
        results.push({ key: action.idempotencyKey, skillId: action.skillId, state: "succeeded", reason: "journal and authoritative state agree" });
      } else {
        results.push({ key: action.idempotencyKey, skillId: action.skillId, state: "failed", reason: "journal says succeeded but authoritative state drifted; manual reconciliation required" });
      }
      continue;
    }
    if (snapshot.policyRevision !== action.expectedPolicyRevision || !snapshot.explicitlyApproved || !snapshot.trustedEvidenceValid) {
      const reason = "scope/policy/approval/evidence revalidation failed";
      const entry = existing ?? { key: action.idempotencyKey, scope: { ...action.scope }, skillId: action.skillId, policyRevision: action.expectedPolicyRevision, state: "running" as const, attempts: 0, updatedAt: now() };
      const claim = await journal.begin(entry);
      if (claim.claimed !== true || typeof claim.claimToken !== "string" || !claim.claimToken) {
        results.push({ key: action.idempotencyKey, skillId: action.skillId, state: "failed", reason: "repair already running or completed by another executor; manual reconciliation required" });
        continue;
      }
      await journal.audit({ key: action.idempotencyKey, scope: action.scope, actorId: action.actorId, skillId: action.skillId, event: "repair_failed", at: now(), detail: reason });
      await journal.finish(action.idempotencyKey, action.scope, "failed", reason, claim.claimToken);
      results.push({ key: action.idempotencyKey, skillId: action.skillId, state: "failed", reason });
      continue;
    }
    if (snapshot.exists && snapshot.active) {
      const entry = existing ?? { key: action.idempotencyKey, scope: { ...action.scope }, skillId: action.skillId, policyRevision: action.expectedPolicyRevision, state: "running" as const, attempts: 0, updatedAt: now() };
      const claim = await journal.begin(entry);
      if (claim.claimed !== true || typeof claim.claimToken !== "string" || !claim.claimToken) {
        results.push({ key: action.idempotencyKey, skillId: action.skillId, state: "failed", reason: "repair already running or completed by another executor; manual reconciliation required" });
        continue;
      }
      await journal.audit({ key: action.idempotencyKey, scope: action.scope, actorId: action.actorId, skillId: action.skillId, event: "repair_already_satisfied", at: now() });
      await journal.finish(action.idempotencyKey, action.scope, "succeeded", "Runtime registration already satisfied", claim.claimToken);
      results.push({ key: action.idempotencyKey, skillId: action.skillId, state: "succeeded", reason: "already satisfied" });
      continue;
    }
    if (snapshot.exists && !snapshot.active) {
      const reason = "existing inactive runtime entry requires manual review";
      const entry = existing ?? { key: action.idempotencyKey, scope: { ...action.scope }, skillId: action.skillId, policyRevision: action.expectedPolicyRevision, state: "running" as const, attempts: 0, updatedAt: now() };
      const claim = await journal.begin(entry);
      if (claim.claimed !== true || typeof claim.claimToken !== "string" || !claim.claimToken) {
        results.push({ key: action.idempotencyKey, skillId: action.skillId, state: "failed", reason: "repair already running or completed by another executor; manual reconciliation required" });
        continue;
      }
      await journal.audit({ key: action.idempotencyKey, scope: action.scope, actorId: action.actorId, skillId: action.skillId, event: "repair_failed", at: now(), detail: reason });
      await journal.finish(action.idempotencyKey, action.scope, "failed", reason, claim.claimToken);
      results.push({ key: action.idempotencyKey, skillId: action.skillId, state: "failed", reason });
      continue;
    }
    const entry = await journal.begin({ key: action.idempotencyKey, scope: { ...action.scope }, skillId: action.skillId, policyRevision: action.expectedPolicyRevision, state: "running", attempts: 0, updatedAt: now() });
    if (entry.state === "succeeded") {
      // Another executor may have completed between our initial read and begin().
      // Never trust the journal alone: the snapshot above must still prove the postcondition.
      if (snapshot.exists && snapshot.active && snapshot.policyRevision === action.expectedPolicyRevision &&
          snapshot.explicitlyApproved && snapshot.trustedEvidenceValid) {
        results.push({ key: action.idempotencyKey, skillId: action.skillId, state: "succeeded", reason: "journal and authoritative state agree" });
      } else {
        results.push({ key: action.idempotencyKey, skillId: action.skillId, state: "failed", reason: "journal says succeeded but authoritative state is not active; manual reconciliation required" });
      }
      continue;
    }
    if (entry.claimed !== true || typeof entry.claimToken !== "string" || !entry.claimToken) {
      // Another process owns this running repair, or the journal cannot fence finalization.
      results.push({ key: action.idempotencyKey, skillId: action.skillId, state: "failed", reason: "repair already running or journal does not support safe claim fencing; manual reconciliation required" });
      continue;
    }
    await journal.audit({ key: action.idempotencyKey, scope: action.scope, actorId: action.actorId, skillId: action.skillId, event: "repair_started", at: now(), detail: "attempt=" + entry.attempts });
    try {
      await host.registerThroughLifecycle(action);
      await journal.audit({ key: action.idempotencyKey, scope: action.scope, actorId: action.actorId, skillId: action.skillId, event: "repair_registered", at: now() });
      const after = await host.revalidate(action);
      if (!after || !validScope(after.scope) || !sameScope(after.scope, action.scope) ||
          !after.exists || !after.active || after.policyRevision !== action.expectedPolicyRevision ||
          !after.explicitlyApproved || !after.trustedEvidenceValid) {
        throw new Error("Post-repair authoritative verification failed");
      }
      await journal.audit({ key: action.idempotencyKey, scope: action.scope, actorId: action.actorId, skillId: action.skillId, event: "repair_succeeded", at: now() });
      await journal.finish(action.idempotencyKey, action.scope, "succeeded", "Postcondition verified", entry.claimToken);
      results.push({ key: action.idempotencyKey, skillId: action.skillId, state: "succeeded" });
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      await journal.audit({ key: action.idempotencyKey, scope: action.scope, actorId: action.actorId, skillId: action.skillId, event: "repair_failed", at: now(), detail: reason });
      await journal.finish(action.idempotencyKey, action.scope, "failed", reason, entry.claimToken);
      results.push({ key: action.idempotencyKey, skillId: action.skillId, state: "failed", reason });
    }
  }
  return results;
}
