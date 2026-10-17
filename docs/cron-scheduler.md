# Persistent Cron Scheduler

This module is additive and submits work through the existing `JobRuntime`; it does not execute tools directly. The runtime remains responsible for the Brain, Tool Registry and policy checks.

## Use

Construct `CronScheduler` with a `JobRuntime`, call `recover()` once during startup, then call `create` and invoke `tick()` from the host's timer/worker loop. `recover()` reconciles persisted runtime job IDs and monitors live jobs; a claimed execution without a persisted job ID is marked indeterminate and is not automatically resubmitted, because the previous process may have submitted it immediately before crashing. The default `FileCronStore` persists schedules, execution history and audit events under Sofia's cron state directory. Set `SOFIA_STATE_DIR` to a durable absolute path in production. For multi-host deployments, inject a `CronStore` backed by a transactional database; filesystem locks only coordinate processes sharing a local filesystem.

Cron syntax supports five fields (minute hour day-of-month month day-of-week), numbers, lists, ranges and steps. Recurring schedules use IANA time zones such as `Asia/Bangkok`. One-time schedules use `runAt` with an ISO-8601 timestamp that includes `Z` or an explicit UTC offset; provide exactly one of `cron` or `runAt`. `maxRetries` controls additional attempts, bounded to ten retries. A timeout requests cancellation of the underlying runtime job, not just the scheduler's polling loop.

## Operational limitations

This is an additive module and is not yet wired into the API/server lifecycle. The host must call `tick()` periodically. A crash between persisting a claim and persisting the runtime job ID remains inherently indeterminate: recovery records the uncertainty and suppresses automatic resubmission to avoid duplicate side effects. Exactly-once execution across that window requires idempotency support in the runtime or an atomic outbox/transactional dispatch integration. Misfires at least one minute late follow the configured policy: `skip` records a skipped occurrence; `run-once` dispatches one coalesced execution and advances the next run beyond the current time. Deterministic tests cover both paths. Validate real file-lock behavior and recovery before unattended production use. For multi-host use, provide a transactional database-backed store. Configure explicit authorization for deployments with admin/operator roles.
