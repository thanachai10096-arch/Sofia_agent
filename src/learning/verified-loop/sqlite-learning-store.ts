import fs from "node:fs";
import path from "node:path";
import type { ActiveLearningSkill, LearningExperience, LearningScope, LearningTransaction, SkillCandidate, SkillEvaluation, VerifiedLearningHost } from "./ports.js";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
type Db = DatabaseSyncType;
type ExperienceRow = { receipt_id: string; experience_id: string; payload: string };
type CandidateRow = { candidate_id: string; payload: string };
type ActiveSkillRow = { skill_id: string; skill_name: string; policy_revision: string; payload: string };
function assertPersistedIdentity(actual: unknown, expected: string, label: string): void {
  if (actual !== expected) throw new Error("Corrupt persisted learning " + label + " identity");
}
function assertScope(scope: LearningScope): void {
  if (!scope || ![scope.tenantId, scope.principalId, scope.projectId].every(value => typeof value === "string" && value.trim().length > 0)) throw new Error("Invalid authenticated learning scope");
}
function assertSameScope(a: LearningScope, b: LearningScope): void {
  assertScope(a);
  if (a.tenantId !== b.tenantId || a.principalId !== b.principalId || a.projectId !== b.projectId) throw new Error("Cross-scope learning access rejected");
}
function encode(value: unknown): string { return JSON.stringify(value); }
function decode<T>(value: unknown, label: string): T {
  if (typeof value !== "string") throw new Error("Corrupt persisted learning " + label);
  try { return JSON.parse(value) as T; } catch { throw new Error("Corrupt persisted learning " + label); }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function persistedScope(value: unknown, scope: LearningScope, label: string): void {
  if (!isRecord(value) || !isRecord(value.scope)) throw new Error("Corrupt persisted learning " + label);
  assertSameScope(value.scope as unknown as LearningScope, scope);
}
function decodeExperience(value: unknown, scope: LearningScope): LearningExperience {
  const item = decode<unknown>(value, "experience");
  persistedScope(item, scope, "experience");
  if (!isRecord(item) || typeof item.id !== "string" || !item.id ||
      typeof item.receiptId !== "string" || !item.receiptId ||
      typeof item.runId !== "string" || !item.runId ||
      !Array.isArray(item.evidenceIds) || !item.evidenceIds.every(id => typeof id === "string" && id.length > 0) ||
      typeof item.summary !== "string" || typeof item.taskFingerprint !== "string" || !item.taskFingerprint ||
      typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) {
    throw new Error("Corrupt persisted learning experience");
  }
  return item as unknown as LearningExperience;
}
function decodeCandidate(value: unknown, scope: LearningScope): SkillCandidate {
  const item = decode<unknown>(value, "candidate");
  persistedScope(item, scope, "candidate");
  if (!isRecord(item) || typeof item.id !== "string" || !item.id ||
      typeof item.experienceId !== "string" || !item.experienceId ||
      typeof item.name !== "string" || !item.name ||
      typeof item.trigger !== "string" ||
      !Array.isArray(item.procedure) || !item.procedure.every(step => typeof step === "string") ||
      typeof item.confidence !== "number" || !Number.isFinite(item.confidence) ||
      item.confidence < 0 || item.confidence > 1) {
    throw new Error("Corrupt persisted learning candidate");
  }
  return item as unknown as SkillCandidate;
}
function decodeEvaluation(value: unknown): SkillEvaluation {
  const item = decode<unknown>(value, "evaluation");
  if (!isRecord(item) || typeof item.regressionRunId !== "string" || !item.regressionRunId ||
      typeof item.passed !== "boolean" || !Array.isArray(item.regressionEvidenceIds) ||
      !item.regressionEvidenceIds.every(id => typeof id === "string" && id.length > 0) ||
      !Array.isArray(item.checks) || !item.checks.every(check =>
        isRecord(check) && typeof check.name === "string" && check.name.trim().length > 0 &&
        typeof check.passed === "boolean" &&
        (check.detail === undefined || typeof check.detail === "string"))) {
    throw new Error("Corrupt persisted learning evaluation");
  }
  return item as unknown as SkillEvaluation;
}
function decodeActiveSkill(value: unknown, scope: LearningScope): ActiveLearningSkill {
  const item = decode<unknown>(value, "active skill");
  const candidate = decodeCandidate(encode(item), scope);
  if (!isRecord(item) || item.status !== "active" ||
      typeof item.activatedAt !== "string" || !Number.isFinite(Date.parse(item.activatedAt)) ||
      typeof item.policyRevision !== "string" || !item.policyRevision) {
    throw new Error("Corrupt persisted active learning skill");
  }
  return { ...candidate, status: "active", activatedAt: item.activatedAt, policyRevision: item.policyRevision };
}
function hardenFile(file: string): void {
  if (process.platform === "win32" || file === ":memory:") return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Learning database must be a regular file");
  // Tighten permissions only; never grant owner permissions that were absent.
  const currentMode = stat.mode & 0o777;
  const privateMode = currentMode & 0o600;
  if (privateMode !== currentMode) fs.chmodSync(file, privateMode);
}
function hardenSqliteFiles(file: string): void {
  if (file === ":memory:" || process.platform === "win32") return;
  for (const candidate of [file, file + "-wal", file + "-shm"]) {
    try { hardenFile(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Durable SQLite transaction adapter for the VerifiedLearningHost transaction port.
 * Receipt/evidence lookup, policy decisions, and real regression execution remain owned by authoritative Sofia services. */
export class SqliteLearningTransactionStore {
  private tail: Promise<void> = Promise.resolve();
  private constructor(private readonly db: Db, private readonly file: string) {}

  static async open(file: string): Promise<SqliteLearningTransactionStore> {
    if (typeof file !== "string" || !file.trim()) throw new Error("Learning database path is required");
    const absolute = file === ":memory:" ? file : path.resolve(file);
    if (absolute !== ":memory:") {
      fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
      try { const fd = fs.openSync(absolute, "wx", 0o600); fs.closeSync(fd); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      hardenFile(absolute);
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(absolute);
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      db.exec("CREATE TABLE IF NOT EXISTS learning_experiences (tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, project_id TEXT NOT NULL, receipt_id TEXT NOT NULL, experience_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (tenant_id, principal_id, project_id, receipt_id), UNIQUE (tenant_id, principal_id, project_id, experience_id)); CREATE TABLE IF NOT EXISTS learning_candidates (tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, project_id TEXT NOT NULL, candidate_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (tenant_id, principal_id, project_id, candidate_id)); CREATE TABLE IF NOT EXISTS learning_evaluations (tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, project_id TEXT NOT NULL, candidate_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (tenant_id, principal_id, project_id, candidate_id)); CREATE TABLE IF NOT EXISTS learning_active_skills (tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, project_id TEXT NOT NULL, skill_id TEXT NOT NULL, skill_name TEXT NOT NULL, policy_revision TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (tenant_id, principal_id, project_id, skill_id)); CREATE INDEX IF NOT EXISTS learning_active_skill_name ON learning_active_skills(tenant_id, principal_id, project_id, skill_name, policy_revision);");
      hardenSqliteFiles(absolute);
      return new SqliteLearningTransactionStore(db, absolute);
    } catch (error) { db.close(); throw error; }
  }

  transaction<T>(scope: LearningScope, operation: (tx: LearningTransaction) => Promise<T>): Promise<T> {
    assertScope(scope);
    const run = this.tail.then(() => this.withTransaction(scope, operation));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async withTransaction<T>(scope: LearningScope, operation: (tx: LearningTransaction) => Promise<T>): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    const values = [scope.tenantId, scope.principalId, scope.projectId] as const;
    const db = this.db;
    const tx: LearningTransaction = {
      insertExperienceIfAbsent: async experience => {
        const safeExperience = decodeExperience(encode(experience), scope);
        const result = db.prepare("INSERT INTO learning_experiences (tenant_id, principal_id, project_id, receipt_id, experience_id, payload) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").run(...values, safeExperience.receiptId, safeExperience.id, encode(safeExperience));
        return Number(result.changes) === 1;
      },
      listExperiences: async (requestedScope, limit) => {
        assertSameScope(requestedScope, scope);
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid learning history limit");
        const rows = db.prepare("SELECT receipt_id, experience_id, payload FROM learning_experiences WHERE tenant_id=? AND principal_id=? AND project_id=? ORDER BY rowid DESC LIMIT ?").all(...values, limit) as ExperienceRow[];
        return rows.reverse().map(row => {
          const item = decodeExperience(row.payload, requestedScope);
          assertPersistedIdentity(item.receiptId, row.receipt_id, "experience receipt");
          assertPersistedIdentity(item.id, row.experience_id, "experience");
          return item;
        });
      },
      getExperience: async (requestedScope, id) => {
        assertSameScope(requestedScope, scope);
        const row = db.prepare("SELECT receipt_id, experience_id, payload FROM learning_experiences WHERE tenant_id=? AND principal_id=? AND project_id=? AND experience_id=?").get(...values, id) as ExperienceRow | undefined;
        if (!row) return undefined;
        const item = decodeExperience(row.payload, requestedScope);
        assertPersistedIdentity(item.receiptId, row.receipt_id, "experience receipt");
        assertPersistedIdentity(item.id, row.experience_id, "experience");
        return item;
      },
      getExperienceByReceipt: async (requestedScope, receiptId) => {
        assertSameScope(requestedScope, scope);
        const row = db.prepare("SELECT receipt_id, experience_id, payload FROM learning_experiences WHERE tenant_id=? AND principal_id=? AND project_id=? AND receipt_id=?").get(...values, receiptId) as ExperienceRow | undefined;
        if (!row) return undefined;
        const item = decodeExperience(row.payload, requestedScope);
        assertPersistedIdentity(item.receiptId, row.receipt_id, "experience receipt");
        assertPersistedIdentity(item.id, row.experience_id, "experience");
        return item;
      },
      putCandidate: async candidate => {
        const safeCandidate = decodeCandidate(encode(candidate), scope);
        db.prepare("INSERT INTO learning_candidates VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id, principal_id, project_id, candidate_id) DO UPDATE SET payload=excluded.payload").run(...values, safeCandidate.id, encode(safeCandidate));
      },
      getCandidate: async (requestedScope, id) => {
        assertSameScope(requestedScope, scope);
        const row = db.prepare("SELECT candidate_id, payload FROM learning_candidates WHERE tenant_id=? AND principal_id=? AND project_id=? AND candidate_id=?").get(...values, id) as CandidateRow | undefined;
        if (!row) return undefined;
        const item = decodeCandidate(row.payload, requestedScope);
        assertPersistedIdentity(item.id, row.candidate_id, "candidate");
        return item;
      },
      recordEvaluation: async (requestedScope, candidateId, evaluation) => {
        assertSameScope(requestedScope, scope);
        if (typeof candidateId !== "string" || !candidateId.trim()) throw new Error("Invalid learning evaluation candidate ID");
        const candidateRow = db.prepare("SELECT candidate_id, payload FROM learning_candidates WHERE tenant_id=? AND principal_id=? AND project_id=? AND candidate_id=?").get(...values, candidateId) as CandidateRow | undefined;
        if (!candidateRow) throw new Error("Learning evaluation requires a persisted candidate");
        const candidate = decodeCandidate(candidateRow.payload, requestedScope);
        assertPersistedIdentity(candidate.id, candidateRow.candidate_id, "candidate");
        const safeEvaluation = decodeEvaluation(encode(evaluation));
        db.prepare("INSERT INTO learning_evaluations VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id, principal_id, project_id, candidate_id) DO UPDATE SET payload=excluded.payload").run(...values, candidateId, encode(safeEvaluation));
      },
      activateSkill: async skill => {
        const safeSkill = decodeActiveSkill(encode(skill), scope);
        // The durable active record must be traceable to the exact candidate
        // and verified experience already persisted in this same scope.
        const candidateRow = db.prepare("SELECT candidate_id, payload FROM learning_candidates WHERE tenant_id=? AND principal_id=? AND project_id=? AND candidate_id=?").get(...values, safeSkill.id) as CandidateRow | undefined;
        if (!candidateRow) throw new Error("Active learning skill requires a persisted candidate");
        const candidate = decodeCandidate(candidateRow.payload, scope);
        assertPersistedIdentity(candidate.id, candidateRow.candidate_id, "candidate");
        if (candidate.experienceId !== safeSkill.experienceId ||
            candidate.name !== safeSkill.name || candidate.trigger !== safeSkill.trigger ||
            candidate.confidence !== safeSkill.confidence ||
            JSON.stringify(candidate.procedure) !== JSON.stringify(safeSkill.procedure)) {
          throw new Error("Active learning skill does not match its persisted candidate");
        }
        const experienceRow = db.prepare("SELECT receipt_id, experience_id, payload FROM learning_experiences WHERE tenant_id=? AND principal_id=? AND project_id=? AND experience_id=?").get(...values, safeSkill.experienceId) as ExperienceRow | undefined;
        if (!experienceRow) throw new Error("Active learning skill requires a persisted experience");
        const persistedExperience = decodeExperience(experienceRow.payload, scope);
        assertPersistedIdentity(persistedExperience.id, experienceRow.experience_id, "experience");
        assertPersistedIdentity(persistedExperience.receiptId, experienceRow.receipt_id, "experience receipt");
        db.prepare("INSERT INTO learning_active_skills VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, principal_id, project_id, skill_id) DO UPDATE SET skill_name=excluded.skill_name, policy_revision=excluded.policy_revision, payload=excluded.payload").run(...values, safeSkill.id, safeSkill.name, safeSkill.policyRevision, encode(safeSkill));
      },
      listActiveSkills: async requestedScope => {
        assertSameScope(requestedScope, scope);
        const rows = db.prepare("SELECT skill_id, skill_name, policy_revision, payload FROM learning_active_skills WHERE tenant_id=? AND principal_id=? AND project_id=?").all(...values) as ActiveSkillRow[];
        return rows.map(row => {
          const item = decodeActiveSkill(row.payload, requestedScope);
          assertPersistedIdentity(item.id, row.skill_id, "active skill");
          assertPersistedIdentity(item.name, row.skill_name, "active skill name");
          assertPersistedIdentity(item.policyRevision, row.policy_revision, "active skill policy");
          return item;
        });
      },
    };
    let result: T;
    try {
      result = await operation(tx);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }

    // COMMIT is irreversible. A later permission-hardening failure must not
    // enter the rollback path or imply that the transaction was undone.
    try {
      hardenSqliteFiles(this.file);
    } catch (cause) {
      const error = new Error("Learning transaction committed, but SQLite file hardening failed");
      Object.assign(error, { committed: true, cause });
      throw error;
    }
    return result;
  }

  close(): void { this.db.close(); }
}

/** Compose durable transactions into a host without replacing other Sofia services. */
export function withSqliteLearningTransactions<T extends Omit<VerifiedLearningHost, "transaction">>(services: T, store: SqliteLearningTransactionStore): VerifiedLearningHost {
  return { ...services, transaction: store.transaction.bind(store) };
}
