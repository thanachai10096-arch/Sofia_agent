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

## Required host bootstrap

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
