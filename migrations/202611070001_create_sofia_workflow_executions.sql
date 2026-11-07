-- External workflow dispatch ledger.
-- Apply explicitly before enabling the optional workflow adapter.
-- No Sofia Brain job records or existing tables are modified.
CREATE TABLE IF NOT EXISTS sofia_workflow_executions (
  execution_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('accepted', 'running', 'succeeded', 'failed', 'cancelled', 'indeterminate')
  ),
  provider_execution_id TEXT,
  output_json JSONB,
  safe_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sofia_workflow_executions_idempotency_unique
    UNIQUE (workflow_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS sofia_workflow_executions_correlation_idx
  ON sofia_workflow_executions (correlation_id);

CREATE INDEX IF NOT EXISTS sofia_workflow_executions_status_updated_idx
  ON sofia_workflow_executions (status, updated_at);
