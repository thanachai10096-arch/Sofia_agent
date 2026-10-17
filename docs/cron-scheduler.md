# Persistent Cron Scheduler

This module is additive and submits work through the existing `JobRuntime`; it does not execute tools directly. The runtime remains responsible for the Brain, Tool Registry and policy checks.

## Use

Construct `CronScheduler` with a `JobRuntime`, call `create`, and invoke `tick()` from the host's timer/worker loop. The default `FileCronStore` persists schedules, execution history and audit events under Sofia's cron state directory. Set `SOFIA_STATE_DIR` to a durable absolute path in production. For multi-host deployments, inject a `CronStore` backed by a transactional database; filesystem locks only coordinate processes sharing a local filesystem.

Cron syntax supports five fields (minute hour day-of-month month day-of-week), numbers, lists, ranges and steps. Time zones use IANA names such as `Asia/Bangkok`. `maxRetries` controls additional attempts, bounded to ten retries. A timeout requests cancellation of the underlying runtime job, not just the scheduler's polling loop.

## Operational limitations

This is an additive module and is not yet wired into the API/server lifecycle. The host must call `tick()` periodically. The scheduler's claim is persisted before dispatch, so a crash in that window can leave a claim without a runtime job; recovery of this window is not implemented. The `run-once` misfire policy still requires implementation and tests. Validate real file-lock behavior and recovery before unattended production use. For multi-host use, provide a transactional database-backed store. Configure explicit authorization for deployments with admin/operator roles.
