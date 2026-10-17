# Persistent Cron Scheduler

This module is an additive scheduler that submits work through the existing `JobRuntime`; it does not execute tools directly. The runtime remains responsible for the Brain, Tool Registry and policy checks.

## Use

Construct `CronScheduler` with a `JobRuntime`, call `create`, and invoke `tick()` from the host's existing timer/worker loop. The default `FileCronStore` persists schedules, execution history and audit events under Sofia's cron state directory. Set `SOFIA_STATE_DIR` to a durable absolute path in production. For multi-host deployments, inject a `CronStore` backed by a transactional database; filesystem locks only coordinate processes sharing a local filesystem.

Cron syntax supports the five standard fields (minute hour day-of-month month day-of-week), numbers, lists, ranges and steps. Time zones use IANA names such as `Asia/Bangkok`. Misfire policy `skip` is the default; `run-once` is reserved in the input type but catch-up policy is not yet implemented. Retry fields are stored but retry dispatch is not yet implemented.

## Operational limitations

This is an initial additive module, not yet wired into the API/server lifecycle. The host must call `tick()` periodically. A claimed occurrence is durably recorded before dispatch to prevent concurrent duplicate claims; a process crash in the claim-to-submit window can leave a claimed history record without a runtime job. Review this crash window before enabling unattended production schedules. Configure explicit authorization in deployments with admin/operator roles.
