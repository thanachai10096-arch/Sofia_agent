import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresUsageStore } from "../dist/api/usage-store.js";

const connectionString = process.env.SOFIA_TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error("SOFIA_TEST_DATABASE_URL must point to a disposable PostgreSQL database.");
}

const pool = new Pool({ connectionString, max: 20 });
const keyId = `integration-${randomUUID()}`;
const quota = 7;
const attempts = 32;

try {
  const store = new PostgresUsageStore(pool, quota, 1000, 60_000);
  await store.ensureSchema();

  const results = await Promise.allSettled(
    Array.from({ length: attempts }, () => store.consume(keyId)),
  );
  const accepted = results.filter((result) => result.status === "fulfilled").length;
  const rejected = results.filter((result) => result.status === "rejected");
  const unexpected = rejected.filter(
    (result) => !(result.reason instanceof Error) || !/quota exceeded/i.test(result.reason.message),
  );

  assert.equal(unexpected.length, 0, "all rejected requests must fail specifically for quota exhaustion");
  assert.equal(accepted, quota, `exactly ${quota} of ${attempts} concurrent calls should be accepted`);

  const record = await store.get(keyId);
  assert.equal(record.runs, quota, "persisted run count must not exceed the configured quota");
  assert.equal(record.toolCalls, 0);
  console.log(`PASS: ${accepted}/${attempts} concurrent requests accepted; persisted runs=${record.runs}`);
} finally {
  await pool.query("DELETE FROM sofia_api_usage WHERE key_id = $1", [keyId]).catch(() => undefined);
  await pool.end();
}
