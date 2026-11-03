# PostgreSQL JobStateStore Adapter Contract

Status: implementation-ready SQL contract; no driver, adapter, or live database has been configured.

This document binds the existing JobStateStore methods to the actual additive schema in db/migrations/0001_shared_job_runtime.sql. It uses the current schema names owner_key_id and sofia_agent_jobs.

## Non-negotiable adapter rules
- Resolve owner_key_id from authenticated server-side principal context. Never accept it as authority from request JSON, query parameters, Discord message content, or a client-provided header.
- Keep the current JobStateStore interface compatible initially. Add owner-scoped query methods as a separate capability before routing public list/get/cancel/resume calls through the shared adapter.
- All SQL is parameterized.
- Every worker mutation is fenced by job ID, status, owner token, and an unexpired lease in the same SQL statement.
- Generate a new random token for every claim. Never return it in public job records.
- Use database time (now()) for lease decisions, not worker wall clocks.
- Use transactions for operations that touch multiple tables.
- Do not use a PostgreSQL adapter in production until integration tests run against the actual managed PostgreSQL provider.

## Atomic claim
Worker supplies a newly generated UUID token as $1 and positive lease duration in milliseconds as $2.

    WITH candidate AS (
      SELECT id FROM sofia_agent_jobs
      WHERE status = 'queued'
         OR (status = 'running' AND lease_expires_at <= now())
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE sofia_agent_jobs AS job
    SET status = 'running', lease_owner_token = $1::uuid,
        heartbeat_at = now(),
        lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
        updated_at = now()
    FROM candidate WHERE job.id = candidate.id
    RETURNING job.*;

No row means no claim. SKIP LOCKED lets workers poll concurrently. Expired running jobs are reclaimable; live running jobs are not.

## Heartbeat — never resurrect an expired lease
    UPDATE sofia_agent_jobs
    SET heartbeat_at = now(),
        lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
        updated_at = now()
    WHERE id = $1::uuid AND status = 'running'
      AND lease_owner_token = $2::uuid
      AND lease_expires_at > now()
    RETURNING id;

Success is exactly one returned row. Zero rows means the worker has lost authority and must abort.

## Save/checkpoint fencing
The adapter serializes the redacted record and updates only if its lease remains valid. The production adapter must map mutable fields and append checkpoint history in the same transaction when a new checkpoint is supplied.

    UPDATE sofia_agent_jobs
    SET status = $3, snapshot = $4::jsonb, result = $5::jsonb,
        error = $6, updated_at = now(),
        lease_owner_token = CASE WHEN $3 = 'running' THEN lease_owner_token ELSE NULL END,
        lease_expires_at = CASE WHEN $3 = 'running' THEN lease_expires_at ELSE NULL END
    WHERE id = $1::uuid AND status = 'running'
      AND lease_owner_token = $2::uuid
      AND lease_expires_at > now()
    RETURNING id;

For the first adapter, use narrow transition-specific statements rather than a generic save that can reopen terminal states. Running-to-terminal transitions must check the live lease before clearing lease fields. Zero rows means lost lease/cancel race; never retry the stale payload without reloading and re-authorizing.

## Owner-scoped cancel
    UPDATE sofia_agent_jobs
    SET status = 'cancelled', lease_owner_token = NULL,
        lease_expires_at = NULL,
        error = COALESCE(error, 'Job cancelled.'), updated_at = now()
    WHERE id = $1::uuid AND owner_key_id = $2
      AND status IN ('queued', 'running')
    RETURNING *;

Parameter $2 must come from authenticated identity. Zero rows is reported as not found/not cancellable without disclosing another owner's job. A local AbortController is an optimization; persisted cancellation is authoritative.

## Owner-scoped read/list
    SELECT * FROM sofia_agent_jobs WHERE id = $1::uuid AND owner_key_id = $2;

    SELECT * FROM sofia_agent_jobs WHERE owner_key_id = $1
    ORDER BY created_at DESC LIMIT $2 OFFSET $3;

Do not fetch all rows and filter in application memory. The shared adapter must not reproduce the file-backed API's current local-store behavior.

## Mark expired lease interrupted
    UPDATE sofia_agent_jobs
    SET status = 'failed', lease_owner_token = NULL,
        lease_expires_at = NULL,
        error = COALESCE(error, 'Job lease expired.'), updated_at = now()
    WHERE id = $1::uuid AND status = 'running'
      AND lease_expires_at <= now()
    RETURNING *;

For transparent automatic recovery, claim may instead take over the expired job and resume its latest snapshot. Do not mark it failed first if the intended state machine is automatic resume; match existing runtime semantics.

## Contract test requirements
- 20+ workers claim one queued job: exactly one receives it.
- Worker A expires, B claims, then A heartbeat/save/complete: all A mutations return zero rows.
- Worker A expires with no replacement claimant; A's late save still returns zero rows.
- Cancel races with save/complete: cancelled remains terminal and lease token is invalidated.
- Two owners list/get/cancel each other's IDs: no record is disclosed or mutated.
- Database connection drops during commit: retry does not duplicate submission or checkpoint sequence.
- Restart between claim and heartbeat: expired lease is reclaimable and resumes only from persisted checkpoint.
- Concurrent same idempotency key and same request hash returns one job; changed hash conflicts.

## Current blockers
- package.json has no PostgreSQL client or migration runner.
- No database vendor, connection URL, pool configuration, or Preview-only database secret has been selected/verified.
- Existing JobStateStore has unscoped get(id) and list(); an owner-scoped capability and API integration are required before public cloud usage.
- Migration allows nullable owner_key_id for internal jobs; every user-facing job must have an owner, and unowned jobs must never appear in owner-facing queries.
- SQL above is a contract sketch, not a ready-to-run implementation; use narrow transition-specific SQL and test against the selected PostgreSQL version.

Until these blockers are resolved, keep the migration unapplied and the shared adapter unconfigured.