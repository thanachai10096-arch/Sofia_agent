import assert from "node:assert/strict";
import test from "node:test";
import {
  PostgresWorkflowExecutionLedger,
  type WorkflowLedgerSqlClient,
  type WorkflowLedgerSqlPool,
  type WorkflowLedgerQueryResult,
} from "../../../src/integrations/workflows/postgres-workflow-execution-ledger.js";

test("Postgres ledger preserves safe error code when patch omits the field", async () => {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const row = {
    execution_id: "execution-1",
    workflow_id: "daily-report",
    idempotency_key: "request-1",
    payload_hash: "sha256:payload",
    correlation_id: "correlation-1",
    status: "running" as const,
    created_at: new Date("2026-11-07T00:00:00.000Z"),
    updated_at: new Date("2026-11-07T00:00:00.000Z"),
    provider_execution_id: null,
    output_json: null,
    safe_error_code: "previous_safe_error",
  };

  const client: WorkflowLedgerSqlClient = {
    async query<RowType = Record<string, unknown>>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<WorkflowLedgerQueryResult<RowType>> {
      calls.push({ sql, values });
      if (sql.includes("SELECT") && sql.includes("FOR UPDATE")) {
        return { rows: [row as unknown as RowType], rowCount: 1 };
      }
      if (sql.includes("UPDATE sofia_workflow_executions")) {
        assert.match(sql, /safe_error_code = CASE WHEN \$7::boolean THEN \$8 ELSE safe_error_code END/);
        assert.equal(values?.[6], false);
        assert.equal(values?.[7], null);
        return {
          rows: [{ ...row, status: "succeeded" } as unknown as RowType],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool: WorkflowLedgerSqlPool = {
    async connect() { return client; },
  };

  const ledger = new PostgresWorkflowExecutionLedger(pool);
  const updated = await ledger.update("execution-1", "running", { status: "succeeded" });

  assert.equal(updated?.status, "succeeded");
  assert.equal(calls.some((call) => call.sql === "COMMIT"), true);
});

test("Postgres reconciliation query is bounded and excludes accepted work", async () => {
  let capturedSql = "";
  let capturedValues: readonly unknown[] | undefined;
  const row = {
    execution_id: "execution-2",
    workflow_id: "daily-report",
    idempotency_key: "request-2",
    payload_hash: "sha256:payload",
    correlation_id: "correlation-2",
    status: "indeterminate" as const,
    created_at: new Date("2026-11-07T00:00:00.000Z"),
    updated_at: new Date("2026-11-07T00:01:00.000Z"),
    provider_execution_id: "provider-2",
    output_json: null,
    safe_error_code: "outcome_unknown",
  };
  const client: WorkflowLedgerSqlClient = {
    async query<RowType = Record<string, unknown>>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<WorkflowLedgerQueryResult<RowType>> {
      capturedSql = sql;
      capturedValues = values;
      return { rows: [row as unknown as RowType], rowCount: 1 };
    },
    release() {},
  };
  const ledger = new PostgresWorkflowExecutionLedger({
    async connect() { return client; },
  });

  const results = await ledger.listForReconciliation("2026-11-07T00:05:00.000Z", 25);
  assert.match(capturedSql, /status IN \('running', 'indeterminate'\)/);
  assert.match(capturedSql, /ORDER BY updated_at ASC/);
  assert.match(capturedSql, /LIMIT \$2/);
  assert.deepEqual(capturedValues, ["2026-11-07T00:05:00.000Z", 25]);
  assert.equal(results[0]?.providerExecutionId, "provider-2");
  assert.equal(results[0]?.status, "indeterminate");
  await assert.rejects(
    ledger.listForReconciliation("not-a-date", 25),
    /workflow_reconciliation_cutoff_invalid/,
  );
  await assert.rejects(
    ledger.listForReconciliation("2026-11-07T00:05:00.000Z", 501),
    /workflow_reconciliation_limit_invalid/,
  );
});
