# Sofia Agent — Shared Runtime Storage Design

Status: implementation specification, not a production deployment approval.

This design preserves the existing Brain, Executor, `DurableJobRuntime`, and local file adapters. It adds a shared persistence boundary for multi-instance hosting. The first cloud adapter target is PostgreSQL; local development continues to use the current file stores.

## Goals

- Make accepted jobs visible to every API Function and worker instance.
- Ensure only the current lease owner can heartbeat or commit job state.
- Recover jobs after process or host restart.
- Persist checkpoints, idempotency, and notification intent across instances.
- Keep every record scoped to a stable Sofia principal.
- Avoid claiming exactly-once execution for external side effects; use idempotency and an outbox.

## Non-goals

- Replacing Brain/Executor or introducing a second agent runtime.
- Moving provider secrets into the database.
- Storing raw API keys, Discord tokens, or Telegram bot tokens.
- Treating a lease as a guarantee that an external side effect happened exactly once.

## Logical schema

Use UUID primary keys where the application already generates UUIDs. All timestamps are UTC `timestamptz`. Store structured snapshots/results as `jsonb`; redact secrets before persistence as the current runtime does.

### `agent_jobs`

| Column | Type | Purpose |
|---|---|---|
| id | uuid PK | Existing job ID |
| principal_id | text NOT NULL | Stable owner/principal, never raw API key |
| status | text NOT NULL | queued/running/completed/failed/cancelled |
| task | text NOT NULL | Redacted task |
| model_route_id | text | Selected route |
| notification_channel_id | text | Opaque delivery target, access-controlled |
| session_key | text | Opaque owner-scoped session reference |
| session_task | text | Original user task, redacted |
| lease_owner_token | uuid | Current fencing token; never returned publicly |
| lease_expires_at | timestamptz | Lease deadline |
| heartbeat_at | timestamptz | Last successful heartbeat |
| snapshot | jsonb | Embedded recovery checkpoint |
| result | jsonb | Redacted terminal result |
| error | text | Redacted error |
| notification_delivered | boolean NOT NULL DEFAULT false | Compatibility/status projection |
| version | bigint NOT NULL DEFAULT 0 | Optimistic concurrency/audit sequence |
| created_at / updated_at | timestamptz | Lifecycle timestamps |

Indexes:
- `(principal_id, created_at DESC)` for owner-scoped history.
- Partial index on `(status, lease_expires_at)` for queued/expired work.
- Partial index on `(principal_id, id)` for owner-scoped lookup.

Every read, cancel, resume, and list query must include `principal_id` from authenticated server context. Never trust a principal ID supplied in the request body.

### `agent_job_checkpoints`

- `job_id` FK to `agent_jobs(id)`
- `checkpoint_id`, `run_id`, `sequence`, `snapshot jsonb`, `created_at`
- Unique `(job_id, sequence)`
- Optional unique `(run_id, checkpoint_id)`

Keep the latest recoverable snapshot embedded in `agent_jobs.snapshot` for atomic claim/recovery. The checkpoint table provides history/debugging and can be retained with a bounded retention policy.

### `agent_idempotency_keys`

- `principal_id`, `scope`, `idempotency_key`, `request_hash`, `job_id`, `created_at`, `expires_at`
- Unique `(principal_id, scope, idempotency_key)`

On reuse, compare request hashes. Same key + same request returns the existing job; same key + different request returns conflict. Enforce retention and size limits. Never use a message body as an idempotency key.

### `agent_outbox`

- `id` UUID PK
- `principal_id`, `job_id`, `event_type`, `destination`, `payload jsonb`
- `status` pending/processing/delivered/failed
- `attempts`, `available_at`, `lease_owner_token`, `lease_expires_at`
- `created_at`, `delivered_at`, `last_error`

Unique key should identify the logical notification, e.g. `(job_id, event_type, destination)`. Do not include secrets in payload. Destination access must be verified against the job's principal and configured channel binding.

## Required transaction semantics

### Submit

1. Authenticate request and resolve stable `principal_id`.
2. Validate task, model route, session ownership, and destination.
3. In one transaction: insert idempotency record (if supplied), insert queued job, and return the job ID.
4. A duplicate idempotency key with matching request hash returns the existing job; mismatch returns conflict.
5. Acknowledge only after transaction commit.

### Claim

Use a transaction with row locking (or one atomic `UPDATE ... WHERE ... RETURNING` statement). Claim only queued jobs or expired running jobs. Generate a fresh random fencing token and set expiry/heartbeat in the same transaction. Do not allow a still-live lease to be stolen.

### Heartbeat

Update only where `id = ? AND status = 'running' AND lease_owner_token = ? AND lease_expires_at > now()`. Return false when no row is updated. Heartbeat must not resurrect an expired lease.

### Checkpoint/save

Commit only when the fencing token matches and the job is not cancelled. Update job state and latest embedded snapshot in one transaction. If a stale worker's update affects zero rows, abort that worker and discard its late result.

### Cancel

In one transaction, update a nonterminal job to cancelled and invalidate the active lease token. Then signal a local controller if the worker is in this process. Other workers observe cancellation through heartbeat/lease checks. Tools must honor AbortSignal and have bounded timeouts.

### Complete + notify

In one transaction, fence the job completion update and insert an outbox event. A separate dispatcher claims outbox rows with a lease, delivers them, and marks delivered. Retries use the same logical event/idempotency key. A notification failure must not roll back the completed job.

## Security and privacy requirements

- Use stable principal IDs; never key long-lived user state by a raw API key or its reversible representation.
- Enforce tenant/owner scoping in every SQL operation; consider PostgreSQL row-level security as defense in depth, not a replacement for application checks.
- Parameterize all SQL; never concatenate user-controlled SQL fragments.
- Keep provider and channel credentials in server-side secret storage/environment variables, not job rows.
- Redact task, snapshot, result, errors, and outbox payload before persistence and logs.
- Restrict database credentials to required schema operations; use TLS and managed secret rotation.
- Define retention/deletion for tasks, checkpoints, outbox payloads, and audit metadata.
- Avoid logging message content, API keys, bot tokens, or full principal identifiers.

## Failure and concurrency test matrix

- Two independent runtime instances race to claim one queued job: exactly one receives the lease.
- Worker A expires; worker B claims; Worker A heartbeat/save/complete is rejected by fencing.
- Cancellation races with heartbeat, checkpoint, and completion: cancelled remains terminal.
- Database timeout during heartbeat: worker retries within lease budget; after confirmed lease loss it aborts.
- Crash after job insert but before dispatch: queued job is discoverable by a poller.
- Crash after external tool side effect but before checkpoint: tool idempotency/reconciliation prevents unsafe duplicate effects.
- Crash after completion transaction but before notification: outbox dispatcher delivers later.
- Crash after notification delivery but before marking delivered: provider idempotency or a delivery ledger prevents duplicates where supported; otherwise document at-least-once semantics.
- Cross-principal read, cancel, resume, session, and destination access are denied.
- Same idempotency key with changed request hash is rejected.
- Snapshot-store failure does not silently erase the latest recoverable checkpoint.
- Migration rollback and schema-version compatibility are exercised against a disposable database.

## Rollout gates

1. Add migration and adapter behind explicit configuration; local file adapters remain default.
2. Run adapter contract tests against a real disposable PostgreSQL instance.
3. Run multi-instance concurrency and crash/recovery integration tests.
4. Wire Vercel Preview to the shared store using Preview-only credentials.
5. Verify API, Discord, and Telegram flows end-to-end with test principals and destinations.
6. Observe Preview soak metrics and exercise rollback.
7. Only then propose a separate production rollout for explicit approval.

Until these gates pass, Vercel's current temporary-file runtime remains Preview-only and must not be described as durable production infrastructure.
