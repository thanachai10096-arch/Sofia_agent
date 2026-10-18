import assert from "node:assert/strict";
import test from "node:test";
import { PostgresUsageStore, type SqlClient, type SqlPool, type SqlQueryResult } from "./usage-store.js";

interface Row { runs: number; tool_calls: number; started_at: number; }

function fakePool(initial?: Row): { pool: SqlPool; statements: string[]; state: { row?: Row } } {
  const state: { row?: Row } = { ...(initial ? { row: { ...initial } } : {}) };
  const statements: string[] = [];
  const pool: SqlPool = {
    async query<RowType = Record<string, unknown>>(sql: string): Promise<SqlQueryResult<RowType>> {
      statements.push(sql);
      if (sql.startsWith("SELECT runs")) {
        return { rows: (state.row ? [{ ...state.row }] : []) as RowType[] };
      }
      return { rows: [] };
    },
    async connect(): Promise<SqlClient> {
      return {
        async query<RowType = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<SqlQueryResult<RowType>> {
          statements.push(sql);
          if (sql.startsWith("INSERT INTO sofia_api_usage")) {
            if (!state.row) state.row = { runs: 0, tool_calls: 0, started_at: Number(values[1]) };
          } else if (sql.startsWith("SELECT runs")) {
            return { rows: (state.row ? [{ ...state.row }] : []) as RowType[] };
          } else if (sql.startsWith("UPDATE sofia_api_usage")) {
            state.row = { runs: Number(values[1]), tool_calls: Number(values[2]), started_at: Number(values[3]) };
          }
          return { rows: [] };
        },
        release() { statements.push("RELEASE"); },
      };
    },
  };
  return { pool, statements, state };
}

test("PostgresUsageStore uses a transaction and row lock before updating shared quota", async () => {
  const fake = fakePool();
  const store = new PostgresUsageStore(fake.pool, 2, 5);
  await store.ensureSchema();
  await store.consume("hashed-key-id", 3);

  assert.equal(fake.state.row?.runs, 1);
  assert.equal(fake.state.row?.tool_calls, 3);
  assert.ok(fake.statements.includes("BEGIN"));
  assert.ok(fake.statements.some((sql) => sql.includes("FOR UPDATE")));
  assert.ok(fake.statements.includes("COMMIT"));
  assert.ok(fake.statements.includes("RELEASE"));
});

test("PostgresUsageStore rejects over-quota usage and rolls back", async () => {
  const fake = fakePool({ runs: 1, tool_calls: 4, started_at: Date.now() });
  const store = new PostgresUsageStore(fake.pool, 2, 5);

  await assert.rejects(() => store.consume("hashed-key-id", 2), /quota exceeded/i);
  assert.ok(fake.statements.includes("ROLLBACK"));
  assert.ok(!fake.statements.includes("COMMIT"));
  assert.equal(fake.state.row?.runs, 1);
  assert.equal(fake.state.row?.tool_calls, 4);
});

test("PostgresUsageStore rejects invalid persisted values and invalid usage inputs", async () => {
  const fake = fakePool({ runs: -1, tool_calls: 0, started_at: Date.now() });
  const store = new PostgresUsageStore(fake.pool);
  await assert.rejects(() => store.consume("hashed-key-id"), /invalid shared usage record/i);
  await assert.rejects(() => store.consume("hashed-key-id", -1), /invalid tool call usage amount/i);
});

test("PostgresUsageStore fails closed when shared storage is unavailable", async () => {
  const pool: SqlPool = {
    async query() { throw new Error("database unavailable"); },
    async connect() { throw new Error("database unavailable"); },
  };
  const store = new PostgresUsageStore(pool);
  await assert.rejects(() => store.consume("hashed-key-id"), /database unavailable/);
});
