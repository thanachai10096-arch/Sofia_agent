# Sofia Cron Scheduler

Sofia's existing `CronScheduler` provides owner-scoped schedules, timezone-aware cron expressions, durable claims, execution history, retry limits, timeout cancellation, and audit events.

## Global pause and resume

The scheduler also supports a persistent global emergency pause:

- `pauseAll(actor, reason)` stores a pause flag, timestamp, bounded operator reason, and audit event.
- `resumeAll(actor)` clears the pause flag and records a resume event.
- `schedulerStatus(actor)` reports pause state, enabled schedules, and active executions.
- `tick()` does not claim or dispatch automatic work while globally paused.

Global pause does not kill executions that were already claimed or running. This suppresses future automatic fires without pretending completed side effects can be undone.

After resume, overdue schedules are handled by each schedule's existing `misfirePolicy`:

- `skip`: record the missed occurrence without dispatching it.
- `run-once`: coalesce the missed slot into one catch-up execution.

The global pause state is persisted in the existing file-backed cron store. Older state files remain compatible because absent pause fields default to an unpaused scheduler.

## Authorization

Pause, resume, and status operations require an authorized non-empty actor through the scheduler's existing authorization callback. API adapters should only pass a principal established by their authentication layer; never trust a model-supplied actor string.

This ports the operational pause/resume lifecycle from Hermes while retaining Sofia's existing owner checks, durable execution history, and misfire policies.
## Brain management tools

Authenticated Brain runs can manage their own schedules through two progressive tools:

- `cronjob_list` reads the current principal's schedules, scheduler status, and a selected schedule's history.
- `cronjob_manage` creates, enables, disables, cancels, pauses, or resumes schedules.

The actor/owner is injected by Sofia from the authenticated principal; it is never accepted from model arguments. Mutating operations carry the existing `write` effect and therefore require the configured approval handler. The scheduler instance is shared with the API adapter, so chat and API operations observe the same persisted state.

Jobs dispatched by the scheduler carry a persisted `cronExecution` marker. On initial execution and resume, the Brain factory omits cron management tools for these jobs, preventing scheduled tasks from recursively creating or modifying schedules.
