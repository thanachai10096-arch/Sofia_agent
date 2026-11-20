-- Durable learned-skill registry and feedback storage.
-- Apply with a migration-capable role before starting Sofia with
-- initializeSchema: false and a least-privilege runtime role.

CREATE TABLE IF NOT EXISTS sofia_skill_registry (
  scope_id text PRIMARY KEY CHECK (length(scope_id) BETWEEN 1 AND 512),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sofia_skill_feedback (
  scope_id text PRIMARY KEY CHECK (length(scope_id) BETWEEN 1 AND 512),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Keep the row layout compatible with PostgresSkillRegistryStore and
-- PostgresSkillFeedbackStore. Each store serializes updates with SELECT FOR UPDATE.
