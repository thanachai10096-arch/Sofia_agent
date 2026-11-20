# Persistent Cron Scheduler

This module is additive and submits work through the existing `JobRuntime`; it does not execute tools directly. The runtime remains responsible for the Brain, Tool Registry and policy checks.

## Use

When `createSofiaApi` receives `deps.jobRuntime`, the API calls `recover()` during startup and starts a one-second `tick()` loop after the server begins listening. Standalone hosts can construct `CronScheduler`, call `recover()` once, and then invoke `tick()` periodically. The API stops its timer as soon as shutdown is requested. After HTTP connections drain, it awaits startup recovery and each tenant scheduler's `close()` before invoking the server-close callback, so the caller can close `JobRuntime` afterward. `CronScheduler.close()` is idempotent, rejects new schedule mutations and ticks, aborts active executions/monitors, and waits for tick, recovery, and execution tasks to settle. Standalone hosts should call `close()` before closing the underlying `JobRuntime`.

`recover()` reconciles persisted runtime job IDs and monitors live jobs. A claimed execution without a persisted job ID is marked indeterminate and is not automatically resubmitted, because the previous process may have submitted it immediately before crashing. The default `FileCronStore` persists schedules, bounded execution history (500 entries per schedule, 10,000 total) and audit events under Sofia's cron state directory. The scheduler enforces a default maximum of 100 schedules per API key, including disabled schedules. Set `SOFIA_STATE_DIR` to a durable absolute path in production. For multi-host deployments, inject a `CronStore` backed by a transactional database; filesystem locks only coordinate processes sharing a local filesystem. If a lock has a dead PID, the store now fails closed rather than deleting it automatically; an operator must verify no scheduler process is active before removing a stale lock. This avoids unlinking another process's replacement live lock.

Cron syntax supports five fields (minute hour day-of-month month day-of-week), numbers, lists, ranges and steps. Recurring schedules use IANA time zones such as `Asia/Bangkok`. One-time schedules use `runAt` with an ISO-8601 timestamp that includes `Z` or an explicit UTC offset; provide exactly one of `cron` or `runAt`. `maxRetries` controls additional attempts, bounded to ten retries. A timeout requests cancellation of the underlying runtime job, not just the scheduler's polling loop.

## Operational limitations

A crash between persisting a claim and persisting the runtime job ID remains inherently indeterminate: recovery records the uncertainty and suppresses automatic resubmission to avoid duplicate side effects. Exactly-once execution across that window requires idempotency support in the runtime or an atomic outbox/transactional dispatch integration. Retries are at-least-once attempts: a failed job may already have performed partial external side effects, so tasks should be idempotent or use their own deduplication key before enabling retries. The timeout bounds runtime-job monitoring after submission; deployments should also ensure the underlying `JobRuntime.submit()` has its own bounded timeout.

Misfires at least one minute late follow the configured policy: `skip` records a skipped occurrence; `run-once` dispatches one coalesced execution and advances the next run beyond the current time. Validate file-lock behavior and recovery before unattended production use. The file store is intended for processes sharing a local filesystem, not multi-host coordination. This is a foundation, not a guarantee of exactly-once delivery.

## API job submission idempotency

`POST /v1/jobs` accepts an optional `Idempotency-Key` header (1–200 characters). The runtime hashes it together with the authenticated owner ID and atomically creates or finds the durable job under the file-store lock. Repeating the same key with the same validated request returns the existing job without dispatching a second execution; reusing the key with a different request returns HTTP 409. The raw key is not persisted. This protects client/network retries and concurrent duplicate submissions, but does not close the crash window between durable queue creation and worker dispatch.

## Durable Job Runtime recovery boundary

The file-backed `DurableJobRuntime` atomically persists a submitted job as `queued` before it begins the asynchronous lease claim. A process crash in that interval can leave a durable `queued` record. The current runtime reconciles expired `running` leases when jobs are read or listed, but it does not yet have a startup dispatcher that reclaims and starts orphaned `queued` records. Operators must treat such records as pending recovery rather than assuming they will execute automatically.

A worker crash after an external side effect but before the terminal job result is durably saved is also indeterminate. A saved Brain snapshot can support resume, but it cannot prove whether an external action already happened. Resume/retry is therefore at-least-once for non-idempotent side effects. Integrations should persist an action-level idempotency key or use a transactional outbox before automatically retrying payments, purchases, messages, or other externally visible actions. The local file store is single-host coordination only; it is not a distributed queue.

## API routes

Cron endpoints remain unavailable if no job runtime is configured.

- `POST /v1/cron/schedules` — create a recurring schedule with `cron` or a one-time schedule with `runAt`.
- `GET /v1/cron/schedules` — list schedules owned by the authenticated API key.
- `GET /v1/cron/schedules/:id/history` — read execution history.
- `POST /v1/cron/schedules/:id/enable` and `/disable` — toggle a schedule.
- `DELETE /v1/cron/schedules/:id` — disable the schedule and cancel its active runtime job if present.

Grant `cron:read` to list schedules/history and `cron:manage` to create, enable, disable or cancel schedules. Ownership is derived from the authenticated API key; clients cannot choose another owner's `ownerKeyId`. The scheduler enforces a default limit of 100 schedules per API key (including disabled schedules), configurable with `maxSchedulesPerOwner` when constructing `CronScheduler` and capped at 10,000.
