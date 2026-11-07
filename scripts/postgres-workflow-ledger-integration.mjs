import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { PostgresWorkflowExecutionLedger } from "../dist/integrations/workflows/postgres-workflow-execution-ledger.js";

const connectionString = process.env.SOFIA_TEST_DATABASE_URL;
if (!connectionString) throw new Error("SOFIA_TEST_DATABASE_URL_required");

const admin = new pg.Pool({ connectionString, max: 4 });
const schema = `sofia_ledger_test_${randomUUID().replaceAll("-", "")}`;
let pool;
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  pool = new pg.Pool({
    connectionString,
    max: 8,
    options: `-c search_path=${schema}`,
  });

  const migration = await readFile(
    new URL("../migrations/202611070001_create_sofia_workflow_executions.sql", import.meta.url),
    "utf8",
  );
  await pool.query(migration);

  const ledger = new PostgresWorkflowExecutionLedger(pool);
  const request = {
    workflowId: "integration-test",
    idempotencyKey: "same-request",
    payloadHash: "sha256:payload-a",
    correlationId: "correlation-a",
  };

  // Two independent database connections race to reserve one idempotency key.
  const reservations = await Promise.all([
    ledger.reserve(request),
    ledger.reserve(request),
  ]);
  assert.equal(reservations.filter((item) => item.kind === "created").length, 1);
  assert.equal(reservations.filter((item) => item.kind === "existing").length, 1);
  const executionId = reservations[0].record.executionId;
  assert.equal(reservations[1].record.executionId, executionId);

  await assert.rejects(
    ledger.reserve({ ...request, payloadHash: "sha256:different" }),
    /workflow_idempotency_conflict/,
  );

  // Compare-and-set must allow exactly one worker to claim accepted -> running.
  const claims = await Promise.all([
    ledger.update(executionId, "accepted", { status: "running" }),
    ledger.update(executionId, "accepted", { status: "running" }),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal((await ledger.get(executionId))?.status, "running");

  await ledger.update(executionId, "running", {
    status: "indeterminate",
    safeErrorCode: "dispatch_outcome_unknown",
  });

  // A newly constructed adapter sees persisted state (restart/reconnect proof).
  const restartedLedger = new PostgresWorkflowExecutionLedger(pool);
  const recovered = await restartedLedger.findByIdempotency(
    request.workflowId,
    request.idempotencyKey,
  );
  assert.equal(recovered?.executionId, executionId);
  assert.equal(recovered?.status, "indeterminate");
  assert.equal(recovered?.safeErrorCode, "dispatch_outcome_unknown");

  const candidates = await restartedLedger.listForReconciliation(
    new Date(Date.now() + 60_000).toISOString(),
    10,
  );
  assert.equal(candidates.some((item) => item.executionId === executionId), true);

  await assert.rejects(
    restartedLedger.update(executionId, "indeterminate", { status: "accepted" }),
    /workflow_execution_invalid_transition/,
  );

  console.log("PostgreSQL workflow ledger integration passed:", {
    reservationRace: "one created, one existing",
    conflictingPayload: "rejected",
    compareAndSet: "exactly one winner",
    restartRecovery: "persisted state recovered",
    reconciliation: "indeterminate execution found",
    unsafeReplay: "rejected",
  });
} finally {
  if (pool) await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
}
