import assert from "node:assert/strict";
import test from "node:test";
import { PostgresJobStateStore, type PostgresExecutor } from "./postgres-job-state-store.js";

test("PostgresJobStateStore uses conditional SQL for fenced claims and owner-scoped resume reservations", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db: PostgresExecutor = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
  };
  const store = new PostgresJobStateStore(db);

  assert.equal(await store.claim("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", 15000), undefined);
  assert.equal(await store.heartbeat("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", 15000), false);
  assert.equal(await store.reserveResumeForOwner(
    "00000000-0000-4000-8000-000000000001",
    "principal-a",
    "00000000-0000-4000-8000-000000000003",
    30000,
  ), undefined);
  assert.equal(await store.getForOwner("00000000-0000-4000-8000-000000000001", "principal-a"), undefined);
  assert.deepEqual(await store.listForOwner("principal-a", 50), []);

  assert.match(calls[0]!.sql, /lease_expires_at <= now\(\)/);
  assert.match(calls[0]!.sql, /resume_reservation_token/);
  assert.match(calls[1]!.sql, /lease_owner_token=\$2::uuid/);
  assert.match(calls[1]!.sql, /lease_expires_at > now\(\)/);
  assert.match(calls[2]!.sql, /owner_key_id=\$2/);
  assert.match(calls[2]!.sql, /snapshot IS NOT NULL/);
  assert.match(calls[2]!.sql, /resume_reservation_expires_at <= now\(\)/);
  assert.match(calls[3]!.sql, /owner_key_id=\$2/);
  assert.match(calls[4]!.sql, /owner_key_id=\$1/);
});

test("PostgresJobStateStore fails closed when a save is rejected by lease or owner fencing", async () => {
  const db: PostgresExecutor = {
    async query() { return { rows: [], rowCount: 0 }; },
  };
  const store = new PostgresJobStateStore(db);
  const accepted = await store.save({
    id: "00000000-0000-4000-8000-000000000001",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    task: "test",
    ownerKeyId: "principal-a",
    leaseOwnerToken: "00000000-0000-4000-8000-000000000002",
    leaseExpiresAt: new Date(Date.now() + 15000).toISOString(),
  });
  assert.equal(accepted, false);
});

test("PostgresJobStateStore rejects corrupt persisted JSON instead of treating it as a missing snapshot", async () => {
  const db: PostgresExecutor = {
    async query() {
      return {
        rows: [{
          id: "00000000-0000-4000-8000-000000000001",
          status: "failed",
          created_at: new Date(),
          updated_at: new Date(),
          task: "test",
          model_route_id: null,
          owner_key_id: "principal-a",
          notification_channel_id: null,
          session_key: null,
          session_task: null,
          notification_delivered: false,
          lease_owner_token: null,
          lease_expires_at: null,
          heartbeat_at: null,
          resume_reservation_token: null,
          resume_reservation_expires_at: null,
          snapshot: "{broken",
          result: null,
          error: null,
        } as never],
        rowCount: 1,
      };
    },
  };
  const store = new PostgresJobStateStore(db);
  await assert.rejects(() => store.get("00000000-0000-4000-8000-000000000001"), SyntaxError);
});


test("terminal persistence atomically updates the job and inserts an owner-scoped outbox event", async () => {
  let capturedSql = "";
  let capturedValues: unknown[] = [];
  const db: PostgresExecutor = {
    async query(sql, values = []) {
      capturedSql = sql;
      capturedValues = values;
      return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }], rowCount: 1 };
    },
  };
  const store = new PostgresJobStateStore(db);
  const record = {
    id: "00000000-0000-4000-8000-000000000001",
    status: "completed" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    task: "private task",
    ownerKeyId: "principal-a",
    notificationChannelId: "discord-channel-a",
    leaseOwnerToken: "00000000-0000-4000-8000-000000000002",
    leaseExpiresAt: new Date(Date.now() + 10000).toISOString(),
    result: { completed: true, text: "done" },
  };
  assert.equal(await store.saveTerminalWithOutbox(record, "job.completed", {
    jobId: record.id, status: "completed",
  }), true);
  assert.match(capturedSql, /WITH updated AS/);
  assert.match(capturedSql, /UPDATE sofia_agent_jobs/);
  assert.match(capturedSql, /INSERT INTO sofia_agent_outbox/);
  assert.match(capturedSql, /FROM updated u/);
  assert.match(capturedSql, /lease_owner_token IS NOT DISTINCT FROM \$12::uuid/);
  assert.match(capturedSql, /lease_expires_at > now\(\)/);
  assert.match(capturedSql, /ON CONFLICT \(job_id,event_type,destination\) DO NOTHING/);
  assert.equal(capturedValues[6], "principal-a");
  assert.equal(capturedValues[7], "discord-channel-a");
  assert.equal(capturedValues[17], "job.completed");
  assert.deepEqual(JSON.parse(String(capturedValues[18])), {
    jobId: record.id, status: "completed",
  });
});

test("terminal outbox persistence rejects non-terminal records before querying", async () => {
  let queried = false;
  const db: PostgresExecutor = {
    async query() { queried = true; return { rows: [], rowCount: 0 }; },
  };
  const store = new PostgresJobStateStore(db);
  await assert.rejects(() => store.saveTerminalWithOutbox({
    id: "00000000-0000-4000-8000-000000000001",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    task: "test",
  }, "job.running", {}), /terminal job status/);
  assert.equal(queried, false);
});
