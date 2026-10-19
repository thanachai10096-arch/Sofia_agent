import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresJobStateStore } from "../dist/brain/postgres-job-state-store.js";

const connectionString = process.env.SOFIA_TEST_DATABASE_URL;
if (!connectionString) throw new Error("SOFIA_TEST_DATABASE_URL must point to a disposable PostgreSQL database.");

const poolA = new Pool({ connectionString, max: 10 });
const poolB = new Pool({ connectionString, max: 10 });
const storeA = new PostgresJobStateStore(poolA);
const storeB = new PostgresJobStateStore(poolB);
const ids = [randomUUID(), randomUUID()];
const now = new Date().toISOString();
const record = (id) => ({
  id, status: "queued", createdAt: now, updatedAt: now, task: "integration job task",
  notificationDelivered: false,
});

try {
  await storeA.ensureSchema();
  assert.equal(await storeA.save(record(ids[0])), true, "initial queued job must persist");

  // Independent pools represent workers in separate processes. A row lock must
  // allow only one of them to acquire the live lease.
  const contenders = await Promise.all([
    storeA.claim(ids[0], "worker-a-" + randomUUID(), 15_000),
    storeB.claim(ids[0], "worker-b-" + randomUUID(), 15_000),
  ]);
  const winners = contenders.filter(Boolean);
  assert.equal(winners.length, 1, "exactly one concurrent worker may claim a job");
  const winner = winners[0];
  assert.equal(winner?.status, "running");

  const winnerToken = winner?.leaseOwnerToken;
  assert.ok(winnerToken);
  assert.equal(await storeA.heartbeat(ids[0], winnerToken, 15_000) || await storeB.heartbeat(ids[0], winnerToken, 15_000), true,
    "current lease owner can heartbeat");

  // Simulate lease expiry atomically in the disposable integration database.
  const expiredAt = new Date(Date.now() - 5_000).toISOString();
  const current = await storeA.get(ids[0]);
  assert.ok(current);
  current.leaseExpiresAt = expiredAt;
  current.heartbeatAt = expiredAt;
  await poolA.query(
    "UPDATE sofia_durable_jobs SET lease_expires_at=$2, record=jsonb_set(jsonb_set(record, '{leaseExpiresAt}', to_jsonb($3::text)), '{heartbeatAt}', to_jsonb($3::text)) WHERE id=$1",
    [ids[0], Date.parse(expiredAt), expiredAt],
  );
  const recovered = await storeB.claim(ids[0], "recovery-worker-" + randomUUID(), 15_000);
  assert.ok(recovered, "expired lease should be claimable by a replacement worker");
  assert.notEqual(recovered?.leaseOwnerToken, winnerToken, "recovery must issue a new fencing token");
  assert.equal(await storeA.save({ ...winner!, status: "completed", updatedAt: new Date().toISOString() }), false,
    "stale worker must not overwrite state after a replacement claim");

  const cancelled = await storeB.cancel(ids[0]);
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(await storeA.heartbeat(ids[0], recovered!.leaseOwnerToken!, 15_000), false,
    "cancelled job must reject subsequent heartbeats");
  assert.equal(await storeA.save({ ...recovered!, status: "completed", updatedAt: new Date().toISOString() }), false,
    "a worker must not overwrite terminal cancellation");

  const loaded = await storeA.get(ids[0]);
  assert.equal(loaded?.status, "cancelled", "terminal cancellation must persist");
  console.log("PASS: PostgreSQL multi-pool claim exclusivity, lease recovery, fencing, and cancellation");

} finally {
  await poolA.query("DELETE FROM sofia_durable_jobs WHERE id = ANY($1::text[])", [ids]).catch(() => undefined);
  await Promise.all([poolA.end(), poolB.end()]);
}
