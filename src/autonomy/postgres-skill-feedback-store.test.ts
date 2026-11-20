import assert from "node:assert/strict";
import test from "node:test";
import type { SkillFeedbackState } from "./skill-feedback.js";
import { PostgresSkillFeedbackStore } from "./postgres-skill-feedback-store.js";
import type { AutonomyPgPool } from "./postgres-job-store.js";

class FeedbackPool {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  readonly rows = new Map<string, SkillFeedbackState>();
  released = false;
  failUpdate = false;

  async query<Row = Record<string, unknown>>(sql: string, values?: unknown[]) {
    this.calls.push({ sql, values });
    return { rows: [] as Row[], rowCount: 0 };
  }

  async connect() {
    return {
      query: async <Row = Record<string, unknown>>(sql: string, values?: unknown[]) => {
        this.calls.push({ sql, values });
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] as Row[] };
        if (sql.includes("INSERT INTO sofia_skill_feedback")) {
          const scope = String(values?.[0]);
          if (!this.rows.has(scope)) this.rows.set(scope, JSON.parse(String(values?.[1])) as SkillFeedbackState);
          return { rows: [] as Row[] };
        }
        if (sql.includes("SELECT state FROM sofia_skill_feedback")) {
          const state = this.rows.get(String(values?.[0]));
          return { rows: state ? [{ state } as Row] : [] };
        }
        if (sql.includes("UPDATE sofia_skill_feedback")) {
          if (this.failUpdate) throw new Error("simulated feedback persistence failure");
          this.rows.set(String(values?.[0]), JSON.parse(String(values?.[1])) as SkillFeedbackState);
          return { rows: [] as Row[] };
        }
        throw new Error("Unexpected SQL: " + sql);
      },
      release: () => { this.released = true; },
    };
  }
}

const store = (pool: FeedbackPool) => new PostgresSkillFeedbackStore(pool as unknown as AutonomyPgPool);

test("PostgreSQL feedback store creates a scoped JSONB table", async () => {
  const pool = new FeedbackPool();
  await store(pool).ensureSchema();
  assert.match(pool.calls[0]!.sql, /CREATE TABLE IF NOT EXISTS sofia_skill_feedback/);
  assert.match(pool.calls[0]!.sql, /scope_id text PRIMARY KEY/);
  assert.match(pool.calls[0]!.sql, /state jsonb NOT NULL/);
});

test("feedback transactions isolate scopes and persist changes under row lock", async () => {
  const pool = new FeedbackPool();
  const db = store(pool);
  await db.transact("tenant-a", (state) => { state.idempotency["one"] = "id-a"; });
  await db.transact("tenant-b", (state) => { state.idempotency["two"] = "id-b"; });
  assert.equal((await db.transact("tenant-a", (state) => state.idempotency["one"])), "id-a");
  assert.equal((await db.transact("tenant-b", (state) => state.idempotency["two"])), "id-b");
  assert.equal(pool.rows.size, 2);
  assert.ok(pool.calls.some((call) => /FOR UPDATE/.test(call.sql)));
});

test("feedback store rejects invalid scope before connecting", async () => {
  const pool = new FeedbackPool();
  await assert.rejects(() => store(pool).transact(" ", () => undefined), /scope is required/);
  assert.equal(pool.calls.length, 0);
});

test("feedback store rolls back failed persistence and releases its client", async () => {
  const pool = new FeedbackPool();
  pool.failUpdate = true;
  await assert.rejects(
    () => store(pool).transact("tenant-a", (state) => { state.entries.push({} as SkillFeedbackState["entries"][number]); }),
    /simulated feedback persistence failure/,
  );
  assert.ok(pool.calls.some((call) => call.sql === "ROLLBACK"));
  assert.equal(pool.released, true);
});
