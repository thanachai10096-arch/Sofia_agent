import fs from "node:fs";
import path from "node:path";
import type {
  ActiveLearningSkill, LearningExperience, LearningScope, LearningTransaction,
  SkillCandidate, SkillEvaluation, VerifiedLearningHost,
} from "./ports.js";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

type Db = DatabaseSyncType;
function assertScope(scope: LearningScope): void {
  if (!scope || ![scope.tenantId, scope.principalId, scope.projectId].every(value => typeof value === "string" && value.trim().length > 0)) {
    throw new Error("Invalid authenticated learning scope");
  }
}
function encode(value: unknown): string { return JSON.stringify(value); }
function decode<T>(value: unknown, label: string): T {
  if (typeof value !== "string") throw new Error("Corrupt persisted learning " + label);
  try { return JSON.parse(value) as T; }
  catch { throw new Error("Corrupt persisted learning " + label); }
}
function hardenFile(file: string): void {
  if (process.platform === "win32" || file === ":memory:") return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Learning database must be a regular file");
  fs.chmodSync(file, 0o600);
}
type ScopeRow = { payload: string };

/**
 * Durable SQLite transaction adapter for the VerifiedLearningHost transaction port.
 * It intentionally does not implement receipt/evidence lookup, policy decisions, or
 * regression execution: those must be supplied by Sofia's authoritative existing services.
 */
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
      db.exec(`
        CREATE TABLE IF NOT EXISTS learning_experiences (
          tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, project_id TEXT NOT NULL,
          receipt_id TEXT NOT NULL, experience_id TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (tenant_id, principal_id, project_id, receipt_id),
          UNIQUE (tenant_id, principal_id, project_id, experience_id)
        );
        CREATE TABLE IF NOT EXISTS learning_candidates (
          tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, project_id TEXT NOT NULL,
          candidate_id TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (tenant_id, principal_id, project_id, candidate_id)
        );
        CREATE TABLE IF NOT EXISTS learning_evaluations (
          tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, project_id TEXT NOT NULL,
          candidate_id TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (tenant_id, principal_id, project_id, candidate_id)
        );
        CREATE TABLE IF NOT EXISTS learning_active_skills (
          tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, project_id TEXT NOT NULL,
          skill_id TEXT NOT NULL, skill_name TEXT NOT NULL, policy_revision TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (tenant_id, principal_id, project_id, skill_id)
        );
        CREATE INDEX IF NOT EXISTS learning_experiences_fingerprint
          ON learning_experiences(tenant_id, principal_id, project_id);
        CREATE INDEX IF NOT EXISTS learning_active_skill_name
          ON learning_active_skills(tenant_id, principal_id, project_id, skill_name, policy_revision);
      `);
      if (absolute !== ":memory:") hardenFile(absolute);
      return new SqliteLearningTransactionStore(db, absolute);
    } catch (error) { db.close(); throw error; }
  }

  /** Pass this method as VerifiedLearningHost.transaction. */
  transaction<T>(scope: LearningScope, operation: (tx: LearningTransaction) => Promise<T>): Promise<T> {
    assertScope(scope);
    const run = this.tail.then(() => this.withTransaction(scope, operation));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async withTransaction<T>(scope: LearningScope, operation: (tx: LearningTransaction) => Promise<T>): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    const values = [scope.tenantId, scope.principalId, scope.projectId] as const;
    const tx: LearningTransaction = {
      async insertExperienceIfAbsent(experience: LearningExperience) {
        assertScope(experience.scope);
        if (experience.scope.tenantId !== scope.tenantId || experience.scope.principalId !== scope.principalId ||
            experience.scope.projectId !== scope.projectId) throw new Error("Cross-scope learning write rejected");
        const result = this.db.prepare(`
          INSERT INTO learning_experiences
            (tenant_id, principal_id, project_id, receipt_id, experience_id, payload)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
        `).run(...values, experience.receiptId, experience.id, encode(experience));
        return Number(result.changes) === 1;
      }.bind(this),
      async listExperiences(requestedScope: LearningScope, limit: number) {
        assertScope(requestedScope);
        if (requestedScope.tenantId !== scope.tenantId || requestedScope.principalId !== scope.principalId ||
            requestedScope.projectId !== scope.projectId) throw new Error("Cross-scope learning read rejected");
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid learning history limit");
        const rows = this.db.prepare(`
          SELECT payload FROM learning_experiences
          WHERE tenant_id = ? AND principal_id = ? AND project_id = ?
          ORDER BY rowid DESC LIMIT ?
        `).all(...values, limit) as ScopeRow[];
        return rows.reverse().map(row => decode<LearningExperience>(row.payload, "experience"));
      }.bind(this),
      async getExperience(requestedScope: LearningScope, id: string) {
        assertScope(requestedScope);
        if (requestedScope.tenantId !== scope.tenantId || requestedScope.principalId !== scope.principalId ||
            requestedScope.projectId !== scope.projectId) throw new Error("Cross-scope learning read rejected");
        const row = this.db.prepare(`
          SELECT payload FROM learning_experiences WHERE tenant_id=? AND principal_id=? AND project_id=? AND experience_id=?
        `).get(...values, id) as ScopeRow | undefined;
        return row ? decode<LearningExperience>(row.payload, "experience") : undefined;
      }.bind(this),
      async putCandidate(candidate: SkillCandidate) {
        assertScope(candidate.scope);
        if (candidate.scope.tenantId !== scope.tenantId || candidate.scope.principalId !== scope.principalId ||
            candidate.scope.projectId !== scope.projectId) throw new Error("Cross-scope learning write rejected");
        this.db.prepare(`
          INSERT INTO learning_candidates VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, principal_id, project_id, candidate_id) DO UPDATE SET payload=excluded.payload
        `).run(...values, candidate.id, encode(candidate));
      }.bind(this),
      async getCandidate(requestedScope: LearningScope, id: string) {
        assertScope(requestedScope);
        if (requestedScope.tenantId !== scope.tenantId || requestedScope.principalId !== scope.principalId ||
            requestedScope.projectId !== scope.projectId) throw new Error("Cross-scope learning read rejected");
        const row = this.db.prepare(`
          SELECT payload FROM learning_candidates WHERE tenant_id=? AND principal_id=? AND project_id=? AND candidate_id=?
        `).get(...values, id) as ScopeRow | undefined;
        return row ? decode<SkillCandidate>(row.payload, "candidate") : undefined;
      }.bind(this),
      async recordEvaluation(requestedScope: LearningScope, candidateId: string, evaluation: SkillEvaluation) {
        assertScope(requestedScope);
        if (requestedScope.tenantId !== scope.tenantId || requestedScope.principalId !== scope.principalId ||
            requestedScope.projectId !== scope.projectId) throw new Error("Cross-scope learning write rejected");
        this.db.prepare(`
          INSERT INTO learning_evaluations VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, principal_id, project_id, candidate_id) DO UPDATE SET payload=excluded.payload
        `).run(...values, candidateId, encode(evaluation));
      }.bind(this),
      async activateSkill(skill: ActiveLearningSkill) {
        assertScope(skill.scope);
        if (skill.scope.tenantId !== scope.tenantId || skill.scope.principalId !== scope.principalId ||
            skill.scope.projectId !== scope.projectId || skill.status !== "active" || !skill.policyRevision) {
          throw new Error("Invalid or cross-scope active learning skill");
        }
        this.db.prepare(`
          INSERT INTO learning_active_skills VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, principal_id, project_id, skill_id) DO UPDATE SET
            skill_name=excluded.skill_name, policy_revision=excluded.policy_revision, payload=excluded.payload
        `).run(...values, skill.id, skill.name, skill.policyRevision, encode(skill));
      }.bind(this),
      async listActiveSkills(requestedScope: LearningScope) {
        assertScope(requestedScope);
        if (requestedScope.tenantId !== scope.tenantId || requestedScope.principalId !== scope.principalId ||
            requestedScope.projectId !== scope.projectId) throw new Error("Cross-scope learning read rejected");
        const rows = this.db.prepare(`
          SELECT payload FROM learning_active_skills WHERE tenant_id=? AND principal_id=? AND project_id=?
        `).all(...values) as ScopeRow[];
        return rows.map(row => decode<ActiveLearningSkill>(row.payload, "active skill"));
      }.bind(this),
    };
    try {
      const result = await operation(tx);
      this.db.exec("COMMIT");
      if (this.file !== ":memory:") hardenFile(this.file);
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  close(): void { this.db.close(); }
}

/** Compose the durable transaction port into a host without replacing other Sofia services. */
export function withSqliteLearningTransactions<T extends Omit<VerifiedLearningHost, "transaction">>(
  services: T,
  store: SqliteLearningTransactionStore,
): VerifiedLearningHost {
  return { ...services, transaction: store.transaction.bind(store) };
}
