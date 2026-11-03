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

## Concrete owner-scope integration point (verified 2026-11-03)

The current public API routes in `src/api/server.ts` behave as follows:
- `GET /v1/jobs/:id` calls `JobRuntime.get(id)`, then compares `ownerKeyId` with the authenticated `auth.keyId` before returning the record.
- Resume and cancel first perform the same read-and-compare check, then call the unscoped runtime mutation.
- `GET /v1/jobs` calls `JobRuntime.list()` and filters by `ownerKeyId` in the API process.
- The public `JobRuntime` port exposes only `get(id)` and `list()`; the lower `JobStateStore` port likewise exposes only unscoped `get(id)` and `list()`.

This is an API response authorization check, not a storage-level tenant boundary. It currently prevents a normal authenticated caller from receiving another owner's job through these routes, but it loads unrelated job records into the same function process and makes it easy for a future route to omit the owner check. The new cloud adapter must not copy this pattern.

### Additive capability shape

Before introducing the cloud adapter, add an explicit owner-scoped capability alongside the existing interfaces (do not break local/custom implementations in the first change):

    interface OwnedJobStateStore {
      getForOwner(id: string, ownerKeyId: string): Promise<JobRecord | undefined>;
      listForOwner(ownerKeyId: string, limit: number, cursor?: string): Promise<JobRecord[]>;
      cancelForOwner(id: string, ownerKeyId: string): Promise<JobRecord | undefined>;
    }

The shared PostgreSQL implementation should implement this capability with owner predicates in SQL. The file adapter may implement the same semantics by filtering its local file under its existing lock/read boundary. API routes should prefer this capability; if a configured cloud runtime lacks it, fail closed for owner-facing job operations rather than silently falling back to an unscoped full-table scan. Compatibility fallback can remain available only for explicitly local/file-backed mode while migration is in progress.

Resume requires special care: authorization and the state transition must be bound to the same owner-scoped record. The adapter/runtime should expose a single owner-authorized resume operation or an atomic owner check immediately before scheduling, while retaining the existing resume-slot and lease fencing rules. Do not implement it as an API-only `getForOwner()` followed by an unrelated unscoped mutation once shared multi-tenant storage is enabled.

### Required regression tests for API wiring

- Owner A's list query invokes the owner-scoped store method with A's authenticated principal and does not call unscoped `list()` in cloud mode.
- Owner A cannot read, cancel, or resume Owner B's job; response shape does not reveal whether B's job exists.
- A store configured as cloud/shared but missing the owner-scoped capability returns a service-unavailable/fail-closed result; it must not silently scan all tenants.
- Local file mode preserves existing API compatibility while returning only the requesting owner's jobs.
- Cursor pagination is stable under concurrent inserts and is bounded by a server-side maximum.


## Atomic owner-scoped resume reservation

The shared adapter MUST implement `reserveResumeForOwner(id, ownerKeyId, token, reservationMs)` as one database transaction / conditional update. A read followed by an application-side write is not sufficient.

Required behavior:

1. Match both `id` and `owner_key_id` in the mutation predicate.
2. Reject completed/cancelled jobs, jobs without a checkpoint, and jobs with a non-expired running lease.
3. Reject a job with an unexpired `resume_reservation_token`.
4. Otherwise set a fresh opaque reservation token and expiry, returning the reserved row.
5. The worker claim operation transitions the job to `running`, assigns its lease token, and clears both resume reservation columns atomically.
6. A crashed caller cannot hold the job forever: another caller may replace an expired reservation. The reservation token is internal and MUST NOT be returned by API serializers.
7. The adapter must verify that the returned owner matches the authenticated owner; a zero-row update is reported as unavailable, without revealing whether another owner owns the ID.

A PostgreSQL implementation should use a single conditional `UPDATE ... WHERE ... AND (...reservation expired...) RETURNING *` (or an equivalent `SELECT FOR UPDATE` transaction). It must not perform an unscoped read first. Contract tests must race two independent connections and prove exactly one receives the reservation.


## Implemented adapter entry point

`src/brain/postgres-job-state-store.ts` now provides a driver-neutral `PostgresJobStateStore` implementing both `JobStateStore` and `OwnedJobStateStore`. It accepts a node-postgres-compatible executor with `query(sql, values)`; it does not add a database driver dependency to Sofia.

The factory accepts an additive third argument:

```ts
const jobStateStore = new PostgresJobStateStore(pool);
const deps = createSofiaAgentDependencies(workspace, approval, { jobStateStore });
```

The host must supply a configured PostgreSQL Pool, apply `db/migrations/0001_shared_job_runtime.sql` through its own migration process, and keep the connection string server-side. Do not pass database credentials to browser/mobile clients.

The adapter uses conditional single-statement updates for claim, heartbeat, lease expiry recovery, cancellation, save fencing, and owner-scoped resume reservation. It implements owner-filtered get/list/cancel queries. SQL contract tests assert the critical predicates without requiring a live database.

**Not yet production-ready:** this repository still has no PostgreSQL driver, migration runner, live PostgreSQL integration test, connection lifecycle/pool configuration, or Vercel environment wiring. The Vercel adapter continues to use local temporary storage until the deployment host injects a real Pool and the migration/integration gates pass. The local tests are not a substitute for two-connection PostgreSQL race tests.


## Shared Brain run snapshots

Job metadata alone is insufficient for cross-instance resume: the existing `BrainRunSnapshot` is loaded through `RunStore`. Added `PostgresRunStore` backed by `sofia_agent_run_snapshots`, and the dependency factory now accepts the same injected `runStore` for both Brain checkpoint writes and DurableJobRuntime resume reads.

Host wiring can now pass both adapters:

```ts
const deps = createSofiaAgentDependencies(workspace, approval, {
  jobStateStore: new PostgresJobStateStore(pool),
  runStore: new PostgresRunStore(pool),
});
```

This keeps the local file stores as defaults. The shared PostgreSQL migration creates the snapshot table. A live DB test, payload-size/retention policy, and production host injection remain required before cloud rollout.


## Transactional outbox adapter

Added `PostgresOutboxStore` for the existing `sofia_agent_outbox` migration table. It provides:
- Idempotent enqueue using the unique `(job_id,event_type,destination)` key.
- Bounded batch claims with `FOR UPDATE SKIP LOCKED`, expiring leases, and attempt increments.
- Lease-token-fenced acknowledgement and retry/failure transitions.
- Bounded batch size, lease duration, retry delay, maximum attempts, and stored error length.

Delivery semantics are **at-least-once**, not exactly-once: a worker may deliver successfully and crash before acknowledgement, so the destination adapter must deduplicate by outbox message ID where supported. The adapter deliberately does not send Discord/Telegram messages itself and is not yet wired to job completion; a dispatcher, destination-specific delivery adapters, and end-to-end duplicate/restart tests are still release gates. Do not put provider credentials or unnecessary personal data in payloads.


## Outbox dispatcher contract (2026-11-03)

`OutboxDispatcher` is an optional host-level worker. It claims bounded batches through `OutboxStore`, calls an injected sender, and acknowledges only while its lease token is still valid. Failed sends use bounded exponential backoff and transition to failed after the configured maximum attempts. Error text is secret-redacted and length-bounded before persistence.

Operational requirements:
- Run dispatchers only in a trusted server-side worker; never expose worker tokens to clients.
- Configure transport-level request timeouts shorter than the outbox lease, or add a lease-renewal capability before allowing longer sends.
- Treat delivery as at-least-once. A process crash after the remote service accepts a message but before acknowledgement can cause a duplicate. The receiver/transport should deduplicate using the stable outbox message ID when supported.
- A lost lease means the worker no longer has authority to acknowledge or retry. It must not attempt a second state mutation using a stale token.
- Keep payloads minimal and owner-scoped. Do not put API keys, bot tokens, raw model prompts, full private conversations, or unrelated user data in outbox payloads.
- The dispatcher is not automatically wired to `DurableJobRuntime`, Discord, or Telegram. In particular, terminal job persistence and outbox enqueue are not yet one atomic database transaction. A crash between those independent operations can leave a terminal job without a notification. Production integration must add a same-transaction terminal transition + outbox insert (or a reconciliation process with durable cursor/idempotency) before claiming reliable completion notifications.
- The dispatcher currently processes each claimed batch sequentially and does not renew leases. Use bounded sender timeouts; add renewal before introducing slow or unbounded delivery handlers.

The dispatcher unit tests are source additions only until typecheck and test commands execute in CI or a local environment.


## Atomic terminal job + outbox transition

The PostgreSQL adapter now exposes `saveTerminalWithOutbox(record, eventType, payload)`. It uses one PostgreSQL statement with data-modifying CTEs:

1. Update the terminal job row only when the owner identity and lease token still match and a running lease is unexpired.
2. Insert the corresponding outbox row from the successfully updated row, using the job's persisted owner and notification channel.
3. Apply the existing unique key `(job_id,event_type,destination)` so retries of the same terminal event do not create a second logical notification.

The method rejects non-terminal statuses before issuing SQL. If the job update affects no row, no outbox row is inserted. Because both writes are part of one SQL statement on one PostgreSQL connection, PostgreSQL commits or rolls back both together.

`DurableJobRuntime` detects this optional capability and uses it for completed, failed, and cancelled terminal persistence when present. Local/file stores retain their existing save behavior. The event payload is secret-redacted and intentionally contains only job ID, terminal status, and the available result/error fields; the destination and owner are sourced from the persisted job row, not from the event payload.

Important boundary: this closes the terminal-transition/outbox gap only for hosts that inject `PostgresJobStateStore`. The current Vercel runtime is not wired to PostgreSQL, and no live database test has verified this statement. The dispatcher still needs a trusted worker and platform-specific senders. The notification payload contract must be reviewed by each sender before exposing result content to a chat destination.
