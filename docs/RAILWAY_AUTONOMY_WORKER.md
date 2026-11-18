# Railway Autonomy Worker Integration

This document describes the production host contract for running Sofia's bounded
autonomy queue as a separate Railway worker. It is an integration guide, not a
claim that the worker is already deployed.

## Current architecture

- The Sofia API service remains the authenticated job producer.
- A separate worker process claims jobs from `PostgresAutonomyJobStore`.
- The PostgreSQL pool, adapter resolver, sandbox attestation, budget telemetry,
  audit sink and kill-switch authority are constructed by trusted host code.
- Job payloads contain data only. Never deserialize executable code, adapters,
  credentials or policy from a job.
- The worker uses bounded sessions and exits on SIGTERM/SIGINT; Railway controls
  process restart and deployment lifecycle.

## Worker host implementation\n\nThe repository now exports `runRailwayAutonomyWorker()` and `runRailwayAutonomyWorkerWithProcessSignals()` from `src/autonomy/railway-worker.ts`. The worker performs a `SELECT 1` connectivity preflight before claiming jobs. The process-signal wrapper removes its signal listeners and invokes the optional host-provided `closePool` callback in `finally`. The host supplies the PostgreSQL pool and all privileged adapters. The pool must expose `query()` and `connect()` and should be created by the host from its server-side `DATABASE_URL`. Startup is disabled unless `SOFIA_AUTONOMY_WORKER_ENABLED=true`, and refuses to start without `DATABASE_URL` or the required trusted dependencies. The helper processes a bounded session and returns; it does not create a Railway service, provision a database, or invent adapter implementations.\n\n## Required host bootstrap

The host must construct a real PostgreSQL pool (for example, `pg.Pool`), then:

1. Construct `PostgresAutonomyJobStore(pool)`.
2. Run `ensureSchema()` from a controlled migration/startup path using a
   least-privilege database role. Do not run schema DDL from model-generated code.
3. Construct `SofiaAutonomyRuntime` and `AutonomyJobSupervisor` with:
   - a trusted `resolveAdapters(job)` implementation;
   - a sandbox attestation backed by the actual sandbox supervisor;
   - live budget counters and spending limits;
   - a mandatory user/project/system kill-switch authority;
   - a durable audit sink.
4. Call `runUntilStopped(workerId, abortSignal, { maxJobs: 100 })`.
5. On SIGTERM or SIGINT, abort the signal and allow the active job to cancel or
   checkpoint before process exit. Configure Railway's drain window to exceed
   the expected shutdown grace period.

Do not substitute `FileAutonomyJobStore` for a multi-replica deployment. It is
only safe within its documented single-process domain.

## Railway service configuration

Create a dedicated worker service from the same repository and production
branch after the host bootstrap is implemented. Its start command should point
to the compiled worker entrypoint, not the API entrypoint. Set the worker's
database URL using a private Railway reference to the PostgreSQL service in the
same project/environment. Do not copy database credentials into source control
or into job payloads.

Suggested non-secret settings (names are reserved for the host integration):

- `SOFIA_AUTONOMY_WORKER_ENABLED=true`
- `SOFIA_AUTONOMY_WORKER_ID` (unique per replica; generate at process start)
- `SOFIA_AUTONOMY_MAX_JOBS_PER_SESSION=100`
- `SOFIA_AUTONOMY_IDLE_DELAY_MS=2000`
- `SOFIA_AUTONOMY_KILL_SWITCH_POLL_MS=5000`

The worker must refuse startup if its database, audit, budget, sandbox
attestation or kill-switch dependencies are missing. It must not silently fall
back to local file storage or disable the kill switch.

## Deployment gates

Before enabling the worker in production:

- The PostgreSQL service must be live and healthy in the same Railway project
  and environment as the worker, with persistent storage and backups.
- Run PostgreSQL integration tests for concurrent claims, lease expiry,
  heartbeat ownership, retry limits, cancellation and checkpoint persistence.
- Run API-to-queue-to-worker-to-memory end-to-end tests with tenant isolation.
- Verify SIGTERM during an active cycle produces a durable checkpoint and a
  recoverable job state.
- Verify kill-switch outage prevents work and is visible in audit logs.
- Verify resource limits, spend ceilings and sandbox isolation under load.
- Confirm CI typecheck, unit tests, integration tests and CodeQL complete.

## Environment discovery note

The currently inspected Railway account has a live Sofia API service in the
`carefree-caring` production environment. A separate `blissful-rebirth`
project contains PostgreSQL/Redis resources only as an uncommitted staged
environment patch; it has no live services yet. Do not reference those staged
resources from production or accept that patch as part of this code change.
Provision and validate the database in the intended Sofia environment before
connecting the worker.

## Authenticated API producer

The API can optionally receive `autonomyJobStore` in `SofiaApiConfig`. When configured, it exposes:

- `POST /v1/autonomy/jobs` — requires `autonomy:run`; accepts only `topic` and optional `context`. The authenticated API key's hashed key ID becomes the principal. Client-supplied principal IDs and unknown fields are rejected.
- `GET /v1/autonomy/jobs` — requires `autonomy:read` or `autonomy:run`; lists only the authenticated principal's jobs.
- `GET /v1/autonomy/jobs/:id` — same read scope; cross-principal lookups return 404.
- `DELETE /v1/autonomy/jobs/:id` — requires `autonomy:run`; cancels only a job owned by the authenticated principal.

An optional `Idempotency-Key` is hashed together with the authenticated principal before it reaches the queue. The endpoint does not accept sandbox settings, execution policy, budget, worker identity, adapter names, or privileged configuration from clients. The worker still resolves those dependencies from trusted host configuration.

Example request body:

```json
{ "topic": "Review recovery behavior", "context": "Focus on lease expiry" }
```

The API queue is opt-in: without `autonomyJobStore`, these routes return 503. The API and worker must be configured with the same PostgreSQL database-backed store in a production deployment.
