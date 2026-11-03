-- Sofia Agent shared job persistence schema (PostgreSQL).
-- Additive migration only. This schema is NOT wired to the runtime until a
-- PostgreSQL JobStateStore adapter and its integration tests are implemented.
-- Apply with a migration runner inside a transaction.

CREATE TABLE IF NOT EXISTS sofia_agent_jobs (
  id uuid PRIMARY KEY,
  owner_key_id text,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  task text NOT NULL,
  model_route_id text,
  notification_channel_id text,
  session_key text,
  session_task text,
  notification_delivered boolean NOT NULL DEFAULT false,
  lease_owner_token uuid,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  resume_reservation_token uuid,
  resume_reservation_expires_at timestamptz,
  snapshot jsonb,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sofia_agent_jobs_lease_shape CHECK (
    (status = 'running' AND lease_owner_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'running'
  )
);

-- Owner-scoped history and efficient queue/expired-lease scans.
CREATE INDEX IF NOT EXISTS sofia_agent_jobs_owner_created_idx
  ON sofia_agent_jobs (owner_key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS sofia_agent_jobs_claim_idx
  ON sofia_agent_jobs (lease_expires_at, created_at)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS sofia_agent_jobs_session_idx
  ON sofia_agent_jobs (owner_key_id, session_key, created_at DESC)
  WHERE session_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS sofia_agent_job_checkpoints (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES sofia_agent_jobs(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, sequence)
);

CREATE INDEX IF NOT EXISTS sofia_agent_job_checkpoints_latest_idx
  ON sofia_agent_job_checkpoints (job_id, sequence DESC);

CREATE TABLE IF NOT EXISTS sofia_agent_idempotency_keys (
  owner_key_id text NOT NULL,
  scope text NOT NULL,
  key_hash char(64) NOT NULL,
  request_hash char(64) NOT NULL,
  job_id uuid NOT NULL REFERENCES sofia_agent_jobs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (owner_key_id, scope, key_hash)
);

CREATE INDEX IF NOT EXISTS sofia_agent_idempotency_expiry_idx
  ON sofia_agent_idempotency_keys (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS sofia_agent_outbox (
  id uuid PRIMARY KEY,
  owner_key_id text,
  job_id uuid NOT NULL REFERENCES sofia_agent_jobs(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  destination text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (job_id, event_type, destination),
  CONSTRAINT sofia_agent_outbox_lease_shape CHECK (
    (status = 'processing' AND lease_owner_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'processing'
  )
);

CREATE INDEX IF NOT EXISTS sofia_agent_outbox_dispatch_idx
  ON sofia_agent_outbox (available_at, created_at)
  WHERE status IN ('pending', 'processing');

-- Deliberately no RLS policy is enabled by this migration: the application
-- must first establish a trusted principal/session setting and test pooled
-- connection reset behavior. Until then, every adapter query MUST include an
-- authenticated owner_key_id predicate for owner-facing reads and mutations.
-- Never expose this schema through a public database credential.
