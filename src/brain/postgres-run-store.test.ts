import assert from "node:assert/strict";
import test from "node:test";
import { PostgresRunStore } from "./postgres-run-store.js";
import type { PostgresExecutor } from "./postgres-job-state-store.js";

test("PostgresRunStore saves, loads, and deletes snapshots using parameterized queries", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let stored: unknown;
  const db: PostgresExecutor = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.startsWith("INSERT")) stored = JSON.parse(String(values[1]));
      if (sql.startsWith("SELECT")) return { rows: stored ? [{ snapshot: stored }] : [], rowCount: stored ? 1 : 0 };
      if (sql.startsWith("DELETE")) stored = undefined;
      return { rows: [], rowCount: 1 };
    },
  };
  const store = new PostgresRunStore(db);
  const snapshot = { runId: "run-1" } as never;
  await store.save(snapshot);
  assert.deepEqual(await store.load("run-1"), snapshot);
  await store.delete("run-1");
  assert.equal(await store.load("run-1"), undefined);
  assert.match(calls[0]!.sql, /ON CONFLICT \(run_id\)/);
  assert.match(calls[1]!.sql, /WHERE run_id=\$1/);
  assert.match(calls[2]!.sql, /WHERE run_id=\$1/);
});

test("PostgresRunStore fails closed when a stored snapshot is corrupt", async () => {
  const db: PostgresExecutor = {
    async query() { return { rows: [{ snapshot: "{not-json" } as never], rowCount: 1 }; },
  };
  const store = new PostgresRunStore(db);
  await assert.rejects(() => store.load("run-corrupt"), SyntaxError);
});
