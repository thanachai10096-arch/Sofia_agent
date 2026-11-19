import assert from "node:assert/strict";
import test from "node:test";
import { PostgresAutonomyJobStore, type AutonomyPgPool } from "./postgres-job-store.js";

class RecordingPool {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];

  async query<Row = Record<string, unknown>>(sql: string, values?: unknown[]) {
    this.calls.push({ sql, values });
    return { rows: [] as Row[], rowCount: 0 };
  }

  async connect() {
    return {
      query: async <Row = Record<string, unknown>>(sql: string, values?: unknown[]) => {
        this.calls.push({ sql, values });
        return { rows: [] as Row[], rowCount: 0 };
      },
      release: () => undefined,
    };
  }
}

function createStore(pool: RecordingPool): PostgresAutonomyJobStore {
  return new PostgresAutonomyJobStore(pool as unknown as AutonomyPgPool);
}

test("PostgreSQL schema setup creates the queue table and tenant/idempotency indexes", async () => {
  const pool = new RecordingPool();
  await createStore(pool).ensureSchema();

  assert.equal(pool.calls.length, 5);
  assert.match(pool.calls[0].sql, /CREATE TABLE IF NOT EXISTS sofia_autonomy_jobs/);
  assert.match(pool.calls[1].sql, /ADD COLUMN IF NOT EXISTS checkpoint/);
  assert.match(pool.calls[2].sql, /UNIQUE INDEX IF NOT EXISTS/);
  assert.match(pool.calls[2].sql, /principal_id, idempotency_key/);
  assert.match(pool.calls[3].sql, /queue_idx/);
  assert.match(pool.calls[4].sql, /principal_idx/);
});

test("PostgreSQL claim uses SKIP LOCKED and validates worker lease bounds", async () => {
  const pool = new RecordingPool();
  const store = createStore(pool);

  assert.equal(await store.claimNext("worker-a", 10_000), undefined);
  assert.match(pool.calls[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(pool.calls[0].values, ["worker-a", 10_000]);

  await assert.rejects(() => store.claimNext(" ", 10_000), /Invalid worker identity or lease duration/);
  await assert.rejects(() => store.claimNext("worker-a", 999), /Invalid worker identity or lease duration/);
  assert.equal(pool.calls.length, 1);
});

test("PostgreSQL reads always bind the authenticated principal to the query", async () => {
  const pool = new RecordingPool();
  const store = createStore(pool);

  assert.equal(await store.get("tenant-a", "job-id"), undefined);
  assert.deepEqual(pool.calls[0].values, ["tenant-a", "job-id"]);
  assert.match(pool.calls[0].sql, /principal_id=\$1 AND id=\$2/);

  assert.deepEqual(await store.list("tenant-b"), []);
  assert.deepEqual(pool.calls[1].values, ["tenant-b"]);
  assert.match(pool.calls[1].sql, /WHERE principal_id=\$1/);
});

test("PostgreSQL enqueue rejects invalid or oversized data before database writes", async () => {
  const pool = new RecordingPool();
  const store = createStore(pool);

  await assert.rejects(
    () => store.enqueue({ principalId: "  ", kind: "research", payload: {} }),
    /Authenticated principal identity is required/,
  );
  await assert.rejects(
    () => store.enqueue({ principalId: "tenant-a", kind: "research", payload: { text: "x".repeat(65 * 1024) } }),
    /no larger than 64 KiB/,
  );
  await assert.rejects(
    () => store.enqueue({ principalId: "tenant-a", kind: "research", payload: {}, maxAttempts: 11 }),
    /maxAttempts must be between 1 and 10/,
  );
  assert.equal(pool.calls.length, 0);
});
