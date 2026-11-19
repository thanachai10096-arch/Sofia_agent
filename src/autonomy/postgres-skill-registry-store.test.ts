import assert from "node:assert/strict";
import test from "node:test";
import type { SkillRegistryState } from "./skill-registry.js";
import { PostgresSkillRegistryStore } from "./postgres-skill-registry-store.js";
import type { AutonomyPgPool } from "./postgres-job-store.js";

class RegistryPool {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  readonly rows = new Map<string, SkillRegistryState>();
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
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] as Row[] };
        if (sql.includes("INSERT INTO sofia_skill_registry")) {
          const scope = String(values?.[0]);
          if (!this.rows.has(scope)) this.rows.set(scope, JSON.parse(String(values?.[1])) as SkillRegistryState);
          return { rows: [] as Row[] };
        }
        if (sql.includes("SELECT state FROM sofia_skill_registry")) {
          const state = this.rows.get(String(values?.[0]));
          return { rows: state ? [{ state } as Row] : [] };
        }
        if (sql.includes("UPDATE sofia_skill_registry")) {
          if (this.failUpdate) throw new Error("simulated persistence failure");
          this.rows.set(String(values?.[0]), JSON.parse(String(values?.[1])) as SkillRegistryState);
          return { rows: [] as Row[] };
        }
        throw new Error("Unexpected SQL: " + sql);
      },
      release: () => { this.released = true; },
    };
  }
}

function createStore(pool: RegistryPool): PostgresSkillRegistryStore {
  return new PostgresSkillRegistryStore(pool as unknown as AutonomyPgPool);
}

test("PostgreSQL skill registry creates a tenant-scoped state table", async () => {
  const pool = new RegistryPool();
  await createStore(pool).ensureSchema();
  assert.match(pool.calls[0].sql, /CREATE TABLE IF NOT EXISTS sofia_skill_registry/);
  assert.match(pool.calls[0].sql, /scope_id text PRIMARY KEY/);
  assert.match(pool.calls[0].sql, /state jsonb NOT NULL/);
});

test("registry transactions lock and persist one isolated project scope", async () => {
  const pool = new RegistryPool();
  const store = createStore(pool);
  await store.transact("project-a", (state) => { state.active["skill-a"] = "v1"; });
  await store.transact("project-b", (state) => { state.active["skill-b"] = "v2"; });
  const a = await store.transact("project-a", (state) => state.active["skill-a"]);
  const b = await store.transact("project-b", (state) => state.active["skill-b"]);
  assert.equal(a, "v1");
  assert.equal(b, "v2");
  assert.equal(pool.rows.size, 2);
  assert.ok(pool.calls.some((call) => /FOR UPDATE/.test(call.sql)));
});

test("registry rejects invalid scope before acquiring a database connection", async () => {
  const pool = new RegistryPool();
  await assert.rejects(() => createStore(pool).transact("  ", () => undefined), /scope is required/);
  assert.equal(pool.calls.length, 0);
});

test("registry rolls back failed persistence and always releases the client", async () => {
  const pool = new RegistryPool();
  pool.failUpdate = true;
  await assert.rejects(
    () => createStore(pool).transact("project-a", (state) => { state.active["skill-a"] = "v1"; }),
    /simulated persistence failure/,
  );
  assert.ok(pool.calls.some((call) => call.sql === "ROLLBACK"));
  assert.equal(pool.calls.at(-1)?.sql, "ROLLBACK");
  assert.equal(pool.released, true);
});
