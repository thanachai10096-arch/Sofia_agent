import fs from "node:fs";
import path from "node:path";

export type SettlementState = "dispatched" | "settled" | "indeterminate";

export interface ModelCallIdentity {
  /** Stable across retries of the same logical provider call; never use a random retry ID here. */
  idempotencyKey: string;
  runId: string;
  phase: string;
  providerId: string;
  modelId: string;
  attempt: number;
  reservedInputTokens: number;
  reservedOutputTokens: number;
}

export interface ModelCallSettlement {
  inputTokens: number;
  outputTokens: number;
  costNanoUsd: bigint;
}

export interface ModelCallJournalEntry extends ModelCallIdentity {
  state: SettlementState;
  dispatchedAt: number;
  settledAt?: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  costNanoUsd?: string;
}

export type DispatchDecision =
  | { shouldDispatch: true; entry: ModelCallJournalEntry }
  | { shouldDispatch: false; entry: ModelCallJournalEntry };

type SqliteDatabase = import("node:sqlite").DatabaseSync;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateIdentity(value: ModelCallIdentity): void {
  if (
    !value || !nonEmpty(value.idempotencyKey) || !nonEmpty(value.runId) ||
    !nonEmpty(value.phase) || !nonEmpty(value.providerId) || !nonEmpty(value.modelId) ||
    !count(value.attempt) || value.attempt < 1 ||
    !count(value.reservedInputTokens) || !count(value.reservedOutputTokens) ||
    !Number.isSafeInteger(value.reservedInputTokens + value.reservedOutputTokens)
  ) throw new TypeError("Invalid model call journal identity");
}

function mapRow(row: Record<string, unknown>): ModelCallJournalEntry {
  return {
    idempotencyKey: String(row.idempotency_key),
    runId: String(row.run_id),
    phase: String(row.phase),
    providerId: String(row.provider_id),
    modelId: String(row.model_id),
    attempt: Number(row.attempt),
    reservedInputTokens: Number(row.reserved_input_tokens),
    reservedOutputTokens: Number(row.reserved_output_tokens),
    state: row.state as SettlementState,
    dispatchedAt: Number(row.dispatched_at),
    ...(row.settled_at === null ? {} : { settledAt: Number(row.settled_at) }),
    ...(row.actual_input_tokens === null ? {} : { actualInputTokens: Number(row.actual_input_tokens) }),
    ...(row.actual_output_tokens === null ? {} : { actualOutputTokens: Number(row.actual_output_tokens) }),
    ...(row.cost_nano_usd === null ? {} : { costNanoUsd: String(row.cost_nano_usd) }),
  };
}

/**
 * Durable, cross-process journal for provider-call dispatch and settlement.
 *
 * A row is committed as "dispatched" before network I/O. If the process dies
 * after that point, recovery must treat it as indeterminate and must not
 * automatically dispatch the same logical call again. This journal records
 * evidence; it does not itself retry providers or decide whether a retry is safe.
 */
export class SqliteModelCallJournal {
  private constructor(private readonly db: SqliteDatabase, private readonly filePath: string) {}

  static async open(filePath: string): Promise<SqliteModelCallJournal> {
    const absolutePath = filePath === ":memory:" ? filePath : path.resolve(filePath);
    if (absolutePath !== ":memory:") {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
      try {
        const fd = fs.openSync(absolutePath, "wx", 0o600);
        fs.closeSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = fs.lstatSync(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Model call journal must be a regular file");
      // Windows relies on inherited ACLs; POSIX mode bits are tightened only.
      if (process.platform !== "win32") fs.chmodSync(absolutePath, stat.mode & 0o600);
    }

    let sqlite: typeof import("node:sqlite");
    try {
      sqlite = await import("node:sqlite");
    } catch {
      throw new Error("SQLite model call journal requires Node.js 22.5 or newer (node:sqlite)");
    }
    const db = new sqlite.DatabaseSync(absolutePath);
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      db.exec("BEGIN IMMEDIATE");
      try {
        // Re-read the schema version while holding the write lock. Two processes
        // opening a new journal concurrently must not both attempt CREATE TABLE.
        const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
        if (version > 1) throw new Error("Model call journal schema is newer than this Sofia Agent supports");
        if (version === 0) {
          db.exec(`
            CREATE TABLE model_call_journal (
              idempotency_key TEXT PRIMARY KEY NOT NULL,
              run_id TEXT NOT NULL,
              phase TEXT NOT NULL,
              provider_id TEXT NOT NULL,
              model_id TEXT NOT NULL,
              attempt INTEGER NOT NULL CHECK (attempt >= 1),
              reserved_input_tokens INTEGER NOT NULL CHECK (reserved_input_tokens >= 0),
              reserved_output_tokens INTEGER NOT NULL CHECK (reserved_output_tokens >= 0),
              state TEXT NOT NULL CHECK (state IN ('dispatched', 'settled', 'indeterminate')),
              dispatched_at INTEGER NOT NULL,
              settled_at INTEGER,
              actual_input_tokens INTEGER,
              actual_output_tokens INTEGER,
              cost_nano_usd TEXT,
              CHECK (
                (state = 'settled' AND settled_at IS NOT NULL AND actual_input_tokens IS NOT NULL
                  AND actual_output_tokens IS NOT NULL AND cost_nano_usd IS NOT NULL)
                OR
                (state <> 'settled' AND settled_at IS NULL AND actual_input_tokens IS NULL
                  AND actual_output_tokens IS NULL AND cost_nano_usd IS NULL)
              )
            );
            CREATE INDEX model_call_journal_run_idx ON model_call_journal(run_id, dispatched_at);
            PRAGMA user_version = 1;
          `);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return new SqliteModelCallJournal(db, absolutePath);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** Atomically claims the logical call and records dispatch before provider I/O. */
  beginDispatch(identity: ModelCallIdentity, now = Date.now()): DispatchDecision {
    validateIdentity(identity);
    if (!count(now)) throw new TypeError("Invalid journal timestamp");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM model_call_journal WHERE idempotency_key = ?")
        .get(identity.idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) {
        const entry = mapRow(existing);
        if (
          entry.runId !== identity.runId || entry.phase !== identity.phase ||
          entry.providerId !== identity.providerId || entry.modelId !== identity.modelId ||
          entry.attempt !== identity.attempt ||
          entry.reservedInputTokens !== identity.reservedInputTokens ||
          entry.reservedOutputTokens !== identity.reservedOutputTokens
        ) throw new Error("Idempotency key is already bound to a different model call");
        this.db.exec("COMMIT");
        return { shouldDispatch: false, entry };
      }
      this.db.prepare(`
        INSERT INTO model_call_journal (
          idempotency_key, run_id, phase, provider_id, model_id, attempt,
          reserved_input_tokens, reserved_output_tokens, state, dispatched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatched', ?)
      `).run(identity.idempotencyKey, identity.runId, identity.phase, identity.providerId,
        identity.modelId, identity.attempt, identity.reservedInputTokens,
        identity.reservedOutputTokens, now);
      const row = this.db.prepare("SELECT * FROM model_call_journal WHERE idempotency_key = ?")
        .get(identity.idempotencyKey) as Record<string, unknown>;
      this.db.exec("COMMIT");
      return { shouldDispatch: true, entry: mapRow(row) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Settlement is idempotent for identical evidence and rejects conflicting evidence. */
  settle(idempotencyKey: string, usage: ModelCallSettlement, now = Date.now()): ModelCallJournalEntry {
    if (!nonEmpty(idempotencyKey) || !count(usage?.inputTokens) || !count(usage?.outputTokens) ||
      !Number.isSafeInteger(usage.inputTokens + usage.outputTokens) ||
      typeof usage.costNanoUsd !== "bigint" || usage.costNanoUsd < 0n || !count(now)) {
      throw new TypeError("Invalid model call settlement");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM model_call_journal WHERE idempotency_key = ?")
        .get(idempotencyKey) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Unknown model call idempotency key");
      const current = mapRow(row);
      if (current.state === "settled") {
        if (current.actualInputTokens !== usage.inputTokens ||
          current.actualOutputTokens !== usage.outputTokens ||
          current.costNanoUsd !== usage.costNanoUsd.toString()) {
          throw new Error("Conflicting settlement evidence for model call");
        }
        this.db.exec("COMMIT");
        return current;
      }
      this.db.prepare(`
        UPDATE model_call_journal
        SET state = 'settled', settled_at = ?, actual_input_tokens = ?,
            actual_output_tokens = ?, cost_nano_usd = ?
        WHERE idempotency_key = ? AND state IN ('dispatched', 'indeterminate')
      `).run(now, usage.inputTokens, usage.outputTokens, usage.costNanoUsd.toString(), idempotencyKey);
      const settled = this.db.prepare("SELECT * FROM model_call_journal WHERE idempotency_key = ?")
        .get(idempotencyKey) as Record<string, unknown>;
      this.db.exec("COMMIT");
      return mapRow(settled);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Marks an unresolved dispatched call without implying that it was unbilled. */
  markIndeterminate(idempotencyKey: string): ModelCallJournalEntry {
    if (!nonEmpty(idempotencyKey)) throw new TypeError("Invalid model call idempotency key");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE model_call_journal SET state = 'indeterminate' WHERE idempotency_key = ? AND state = 'dispatched'")
        .run(idempotencyKey);
      const row = this.db.prepare("SELECT * FROM model_call_journal WHERE idempotency_key = ?")
        .get(idempotencyKey) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Unknown model call idempotency key");
      this.db.exec("COMMIT");
      return mapRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(idempotencyKey: string): ModelCallJournalEntry | undefined {
    if (!nonEmpty(idempotencyKey)) throw new TypeError("Invalid model call idempotency key");
    const row = this.db.prepare("SELECT * FROM model_call_journal WHERE idempotency_key = ?")
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : undefined;
  }

  listByRun(runId: string, limit = 100): ModelCallJournalEntry[] {
    if (!nonEmpty(runId) || !count(limit) || limit < 1 || limit > 1000) throw new TypeError("Invalid journal query");
    const rows = this.db.prepare("SELECT * FROM model_call_journal WHERE run_id = ? ORDER BY dispatched_at, idempotency_key LIMIT ?")
      .all(runId, limit) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }

  close(): void { this.db.close(); }
}
