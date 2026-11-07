-- Real PostgreSQL schema/constraint smoke test for the external workflow ledger.
-- The CI database is ephemeral; all fixture rows are rolled back.
BEGIN;

INSERT INTO sofia_workflow_executions
  (execution_id, workflow_id, idempotency_key, payload_hash, correlation_id, status)
VALUES
  ('integration-a', 'ci-workflow', 'same-key', 'hash-a', 'corr-a', 'accepted');

-- A second reservation with the same workflow/idempotency key must not create
-- a second row (the adapter uses ON CONFLICT DO NOTHING against this constraint).
INSERT INTO sofia_workflow_executions
  (execution_id, workflow_id, idempotency_key, payload_hash, correlation_id, status)
VALUES
  ('integration-b', 'ci-workflow', 'same-key', 'hash-a', 'corr-a', 'accepted')
ON CONFLICT (workflow_id, idempotency_key) DO NOTHING;

DO $$
DECLARE
  total_rows integer;
  invalid_status_rejected boolean := false;
BEGIN
  SELECT COUNT(*) INTO total_rows
    FROM sofia_workflow_executions
   WHERE workflow_id = 'ci-workflow' AND idempotency_key = 'same-key';
  IF total_rows <> 1 THEN
    RAISE EXCEPTION 'idempotency unique constraint failed: expected 1 row, got %', total_rows;
  END IF;

  BEGIN
    INSERT INTO sofia_workflow_executions
      (execution_id, workflow_id, idempotency_key, payload_hash, correlation_id, status)
    VALUES
      ('integration-invalid', 'ci-workflow', 'invalid-key', 'hash', 'corr', 'queued');
  EXCEPTION WHEN check_violation THEN
    invalid_status_rejected := true;
  END;
  IF NOT invalid_status_rejected THEN
    RAISE EXCEPTION 'status CHECK constraint accepted an unsupported state';
  END IF;

  UPDATE sofia_workflow_executions
     SET status = 'running', updated_at = NOW() - INTERVAL '10 minutes'
   WHERE execution_id = 'integration-a';

  IF NOT EXISTS (
    SELECT 1 FROM sofia_workflow_executions
     WHERE status IN ('running', 'indeterminate')
       AND updated_at <= NOW() - INTERVAL '5 minutes'
     ORDER BY updated_at ASC, execution_id ASC
     LIMIT 1
  ) THEN
    RAISE EXCEPTION 'stale running execution was not queryable for reconciliation';
  END IF;
END $$;

ROLLBACK;
