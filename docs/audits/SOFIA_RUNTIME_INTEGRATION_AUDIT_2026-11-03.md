# Sofia Agent Runtime Integration Audit — 2026-11-03

Status: repository review and implementation plan. This document is additive; it does not authorize merging, deployment, data migration, or changes to production secrets.

## Scope and evidence

Reviewed the repository `thanachai10096-arch/Sofia_agent` on 2026-11-03, using:
- Main base commit: `4189b70ba0dc7068af52f2296a345bed613e8b14`
- Vercel migration / Discord gateway candidate: `3e9966057e5f9bc8e3ddacc929ce702e73a6e4a1`
- Open PRs inspected: #349, #348, #347, #350, #308, #303, #301, #296, #297.
- Files inspected include the Vercel API adapter, Discord Gateway daemon, Telegram webhook, Job Runtime, model configuration, and related PR patches.

This was a source and PR review. No local build, typecheck, unit test, integration test, or production smoke test was executed as part of this review. A green Vercel build is not evidence that Core durability or end-to-end messaging works.

## Executive assessment

Sofia has substantial existing runtime components. The immediate weakness is not a lack of features; it is the gap between component-level implementation and a verified, durable, end-to-end platform.

The Vercel candidate is honest about several limitations: its API adapter caches one Core instance per warm Function, stores state under the temporary filesystem, and explicitly says it is suitable for Preview smoke tests rather than durable production jobs. The migration must not be described as production-ready until the storage and execution boundaries are replaced and tested.

## Findings

### P0 — Cloud state is not durable or shared

Evidence:
- `src/platform/vercel-api-runtime.ts` creates workspace/state under `os.tmpdir()`.
- It uses `FileRunRecordStore` and the normal Agent dependency factory.
- The comments explicitly limit this adapter to Preview smoke tests.
- The Job Runtime's `FileJobStateStore` documents itself as local/single-host and requires atomic shared storage for multi-host workers.

Impact:
- Warm instances may not share run, job, session, idempotency, usage, or memory state.
- Temporary files can disappear between invocations or instances.
- A successful HTTP response cannot prove restart recovery.

Required direction:
- Define storage ports for jobs, run records, sessions, idempotency, usage/quotas, memory, and cron.
- Implement a transactional shared adapter (Postgres is the current target in the migration plan).
- Add schema/versioning, owner scoping, transaction boundaries, uniqueness constraints, and migration/rollback tests.
- Keep file-backed stores for local development and single-process use.

### P0 — Long-running work needs a durable execution owner

Evidence:
- The candidate API adapter dispatches through the existing in-process API server.
- The current Job Runtime owns local execution and file-backed state.
- The Vercel migration plan itself calls for a durable workflow/queue layer before production.

Impact:
- A Function or daemon restart can interrupt work.
- Process-local timers and in-memory maps cannot provide distributed scheduling, deduplication, or exactly-once effects.
- A request timeout can leave ambiguous outcomes unless job acceptance and idempotency are durable.

Required direction:
- Keep the existing Brain/Executor as the execution engine; do not create a second Agent Runtime.
- Add a durable orchestration adapter around it, with claim/lease fencing, heartbeat, checkpoint, cancellation, retry policy, resume, and terminal notification.
- Use an outbox or equivalent transactional delivery record so completion notifications are not lost or duplicated.
- Test crash/restart at every transition: accepted, claimed, checkpointed, tool side-effect started, completed, notification pending, notification delivered.

### P0 — Discord Gateway needs stricter boundary validation and complete lifecycle behavior

Evidence:
- The daemon reads `SOFIA_API_BASE_URL`, constructs API URLs from it, and calls the Sofia API.
- The Discord Gateway candidate checks user and channel allowlists before dispatch.
- The worker uses process-local `seen`, `inflight`, and pending-message collections.
- The current task path submits a run and extracts a limited set of response fields.

Impact:
- Gateway restarts can forget in-flight/deduplication state.
- A configured upstream URL is a security boundary and must be validated as a strict HTTPS origin with an explicit host allowlist, not merely trusted because it parses.
- A queued/accepted response is not the same as a completed result; the channel needs durable job status and completion delivery.
- Response schema drift can produce a generic fallback instead of the actual final answer.

Required direction:
- Keep the explicit user + channel allowlists and owner identity binding.
- Validate the configured API origin against an explicit deployment allowlist; reject unexpected ports, credentials, path, query, fragment, and non-HTTPS protocols.
- Move dedupe and message/job correlation to shared durable storage.
- Define one normalized API response contract for accepted jobs, running jobs, completed results, and errors.
- Add tests for normal text, `/run`, duplicate gateway events, unauthorized users/channels, empty content, rate limits, timeout, API errors, restart recovery, and outbound Discord delivery.
- Do not log message bodies, tokens, API keys, or private task content. Existing diagnostic logging of message excerpts should be removed or redacted before general use.

### P1 — Telegram webhook is an ingress adapter, not yet a complete chat channel

Evidence:
- `api/telegram/webhook.ts` validates the Telegram webhook secret and user/chat allowlists.
- It forwards the task to an API endpoint and sends an immediate accepted/job-ID acknowledgement.
- Its comments state completion delivery is outside the ingress endpoint and that upstream idempotency must be shared.

Impact:
- Users can receive an acknowledgement without receiving the final answer.
- If upstream state is process-local, Telegram retries may create duplicate logical runs after restarts.
- A webhook should acknowledge only after durable acceptance, then rely on a durable notification path.

Required direction:
- Reuse the same shared Job/Session/Outbox services as Discord.
- Persist update ID idempotency before acknowledging Telegram.
- Send accepted, progress, and completed messages through a durable notifier.
- Test webhook retries, duplicate update IDs, secret mismatch, allowlist denial, API outage, and bot delivery failure.

### P1 — Model configuration and credential separation must be consolidated

Evidence:
- PR #347 separates Sofia API authentication (`SOFIA_API_KEY`) from the custom model credential (`SOFIA_MODEL_API_KEY`) while retaining a legacy alias.
- PR #349 adds Kimi and DeepSeek provider environment examples.
- Provider configuration remains server-side and server-wide in the inspected Web Chat design.

Required direction:
- Merge provider configuration through one validated config schema.
- Preserve backward compatibility for legacy aliases with explicit deprecation behavior.
- Never let API authentication keys be used as provider credentials.
- Add provider contract tests for text, structured JSON, streaming, tool calls, timeout, retry, rate-limit, malformed response, and capability mismatch.
- Distinguish provider/model discovery from a successful live provider call.

### P1 — Memory and model preferences are not yet cloud-safe by default

Evidence:
- PR #296 adds owner-scoped memory context to synchronous API runs.
- PR #301 carries owner-scoped memory into durable API jobs.
- PR #297 stores model preferences in a file-backed store keyed by derived API-key identity.
- The Vercel adapter uses temporary local storage.

Impact:
- Owner-scoped retrieval is a good boundary, but file-backed preferences/memory are not shared across Function instances.
- Key rotation changes the derived identity and may orphan preferences.
- Memory injection must remain bounded, explicitly untrusted, and unable to change tool permissions.

Required direction:
- Use shared transactional stores and stable principal IDs rather than API-key-derived identity for long-term user preferences.
- Keep API-key-to-principal mapping scoped and revocable.
- Preserve memory as untrusted reference context; enforce current request, system policy, and tool authorization independently.
- Add cross-user isolation and key-rotation tests.

### P1 — Verified Learning must be gated by reproducible evidence

Evidence:
- PR #308 adds a substantial Verified Learning Loop, SQLite stores, reconciliation, repair, and lifecycle promotion logic.
- The repository already has skills and approval boundaries.

Required direction:
- Do not promote generated skills based only on model self-evaluation.
- Require reproducible cases, regression repeats, security review, provenance, rollback, and a minimum quality gain.
- Keep learned artifacts quarantined until approval and policy checks pass.
- Test interruption and recovery during each learning lifecycle stage.

### P1 — Static analysis findings require adjudication before release

Evidence:
- GitHub CodeQL review comments on PR #349 report URL/SSRF-related findings in the Telegram URL validation tests and Discord Gateway worker, plus a user-controlled timer finding.
- The worker constructs a request URL from configured environment data and consumes a Gateway-provided heartbeat interval.

Required direction:
- Review each alert against the exact dataflow and document true-positive/false-positive rationale.
- Prefer strict URL origin allowlisting and bounded numeric timer validation.
- Do not suppress alerts without tests that demonstrate the boundary.
- Require CodeQL and dependency/security checks on the exact release commit.

## PR integration order (do not merge automatically)

1. #347 — credential separation. Review config compatibility and deployment environment impact.
2. #296 and #301 — memory context integration. Verify they do not conflict and both preserve owner scoping.
3. #297 — model preferences. Replace file-backed cloud persistence before claiming multi-instance support.
4. #303 — Web Chat. Keep same-origin, HttpOnly cookie, CSRF/origin validation, and server-side credentials; replace process-memory sessions before multi-instance use.
5. #308 — Verified Learning. Review separately due its broad surface area and promotion/security implications.
6. #349 — Vercel migration. Treat as architecture/Preview candidate until shared storage and durable execution are real.
7. #348 — Discord Gateway. Integrate only after the normalized job API and durable notification contract are defined.
8. #350 — health endpoint. Keep its degraded/not-ready semantics; it must not be used as a readiness badge.

This is a dependency-oriented review order, not approval to merge. Resolve conflicts and rerun checks after each integration.

## Release acceptance gates

A release candidate is not ready until all applicable checks pass on the exact commit:

- [ ] typecheck and build
- [ ] complete unit/regression suite
- [ ] security checks including CodeQL and dependency audit
- [ ] durable shared-store concurrency and owner-isolation tests
- [ ] restart/recovery tests for jobs, sessions, cron, idempotency, and notifications
- [ ] Discord normal chat + `/run` end-to-end, including unauthorized identity/channel cases
- [ ] Telegram webhook + final-result delivery end-to-end
- [ ] model provider contract and live smoke tests for each configured provider
- [ ] Web Chat authentication, origin/CSRF, cookie, and multi-instance tests
- [ ] learning/skill promotion rollback and provenance tests
- [ ] preview soak test and observability review
- [ ] explicit production approval and rollback plan

## Non-goals and safety constraints

- Do not replace the existing Sofia Brain/Executor with a parallel runtime.
- Do not remove local file-backed stores; keep them as supported local adapters.
- Do not merge open PRs automatically.
- Do not modify production secrets, domains, or deployment targets as part of this audit.
- Do not claim tests, readiness, or provider compatibility without exact evidence.


## Follow-up hardening performed on the audit branch

Commit `becb52081cd47c33366f3eac285f2f6045ee2a77` changes only
`workers/discord-gateway/daemon/worker.mjs`:

- Removes Discord user IDs from allowlist-denial logs.
- Removes Discord channel IDs from allowlist-denial logs.
- Removes message IDs, channel IDs, and the first 80 characters of message content from successful message-received logs.
- Keeps event names and denial reasons so operators can diagnose flow without recording user content or direct identifiers.

This is a privacy-minimizing change only. It does not alter authorization, message routing, or delivery behavior.

Validation evidence:
- GitHub combined status for this commit reports Vercel checks failed because the account hit the deployment/build rate limit (`build-rate-limit`) for both `sofia-discord-test` and `i888`.
- No build, typecheck, unit test, or runtime test result is available for this commit. Treat it as unverified until CI can run.
- No deployment was created and no production environment was modified.


## Follow-up: Job Runtime lease, heartbeat, cancellation, and recovery review

Reviewed on the audit branch:
- `src/brain/job-runtime.ts`
- `src/brain/job-runtime.test.ts`
- `src/platform/vercel-api-runtime.ts`
- `src/brain/run-store.ts`

### Existing behavior verified by source inspection

The existing `DurableJobRuntime` already provides a meaningful single-host durability foundation:
- Atomic file-store claims with an owner token and expiring lease.
- Heartbeats that extend a lease only while the same owner token still holds a live lease.
- Fencing on save: a worker whose lease token no longer matches cannot overwrite the current job record.
- Cancellation is persisted before the local controller is aborted; a late success must not replace a terminal cancellation.
- Checkpoints are redacted before being written to the separate RunStore and embedded job record.
- Expired running jobs are marked interrupted and can be resumed from a persisted snapshot.
- Public job records omit the internal lease owner token.
- The file store uses an exclusive lock and explicitly fails closed on a lock owned by another host.

The test file contains coverage for process restart recovery, checkpoint resume, duplicate resume prevention, active and cross-process cancellation, stale/foreign lock handling, redaction, private file permissions, and injected JobStateStore behavior. This is source-level test inventory only; these tests were not executed during this audit.

### Remaining production gaps

1. **No shared transactional cloud adapter is wired into the Vercel runtime.** The Vercel adapter constructs the default runtime dependencies and uses temporary filesystem paths. The JobStateStore injection seam is useful, but an interface alone does not provide multi-instance durability.
2. **RunStore is also file-backed.** Its per-target save queue is process-local. It does not coordinate independent Function instances or provide transactional coupling with the job row.
3. **Job state and checkpoint state are separate writes.** The code attempts to preserve an embedded snapshot fallback if RunStore save fails, but a cloud implementation still needs explicit consistency and recovery semantics.
4. **Lease fencing cannot make external side effects exactly-once.** Tools that send messages, modify repositories, or call external APIs need idempotency keys/outbox records and reconciliation; a lease only fences job-state writes.
5. **Cancellation is cooperative.** Tools and provider calls must honor AbortSignal or have bounded timeouts; aborting the Brain does not automatically undo an already-committed external side effect.

### Safe implementation sequence

- Keep `DurableJobRuntime`, Brain, and Executor as the existing execution engine.
- Specify a shared transactional schema for jobs, leases, checkpoints, idempotency keys, and an outbox; enforce owner scoping and uniqueness in the database.
- Implement a Postgres-backed `JobStateStore` with atomic claim/heartbeat/cancel/save transactions and lease-token fencing.
- Implement a shared checkpoint store and ensure checkpoint/job transitions can be reconciled after partial failure.
- Add an outbox-backed notification dispatcher with retry and deduplication.
- Add integration tests with two independent runtime instances against the same database, forced lease expiry, stale-worker writes, cancellation races, duplicate side effects, and restart during notification.
- Wire the shared adapters into Vercel only after those tests pass. Keep file adapters for local development.

### Scope decision

No change to `job-runtime.ts` was made in this follow-up. The inspected local implementation already has substantial lease and recovery protections; replacing it or adding another runtime would increase risk. The next implementation unit should be the shared storage adapter and its contract tests, not a rewrite of the existing executor.


## Follow-up: shared-storage schema and owner-scope review

Added `db/migrations/0001_shared_job_runtime.sql` as an additive PostgreSQL schema candidate. It defines shared job rows, checkpoint history, owner-scoped idempotency keys, and a notification outbox, with indexes for owner history, lease claims, and outbox dispatch.

The schema is deliberately not wired into runtime. The repository currently has no PostgreSQL driver or migration runner in `package.json`, and no database connection configuration was verified. Adding a database dependency or changing deployment configuration without a tested adapter would be premature.

Additional API boundary review:
- `GET /v1/jobs/:id` fetches the job and compares `ownerKeyId` with the authenticated API key identity before returning it.
- `GET /v1/jobs` filters the returned list by `ownerKeyId`.
- Resume/cancel routes perform the same ownership check before mutation.
- The current JobStateStore interface itself remains unscoped: `get(id)` and `list()` return records before API-layer filtering. The PostgreSQL adapter should expose owner-scoped operations (or require a trusted owner scope in its query context) so one tenant's rows are not unnecessarily loaded into another request's process memory.

Schema compatibility note:
- The current runtime can retain lease metadata on terminal records (for example, cancellation can persist while the old worker still holds its fencing token; completion also does not consistently clear lease fields).
- The migration therefore does not impose a terminal-state constraint requiring lease fields to be null. The adapter must still reject heartbeat/claim for terminal states and fence stale writes by token and status.
- The migration has not been applied to a database, parsed by PostgreSQL, or integration-tested. Treat it as a reviewed schema draft only.

Next safe implementation step:
1. Define a principal-scoped cloud store port without weakening the existing local adapter contract.
2. Add a PostgreSQL client and migration runner only after choosing the deployment database and supported connection model.
3. Implement atomic SQL claim/heartbeat/cancel/save and checkpoint/outbox transactions.
4. Run real PostgreSQL migration, contract, concurrency, owner-isolation, and restart tests before enabling it in Vercel Preview.


## Critical follow-up: expired-lease late-save race

A deeper review of `FileJobStateStore.save()` found a race not covered by the earlier lease summary: save previously rejected a stale worker only after another worker had replaced its lease token. If the lease had expired but no replacement worker had claimed the job yet, the old worker could still commit using the unchanged token.

Fix applied on the audit branch:
- `save()` now rejects writes when the persisted record is still `running` but its lease expiry is missing, invalid, or at/before the current time.
- Added a regression test that expires a live job's lease, lets its worker finish before the next heartbeat, and observes the persisted state from a separate runtime instance. The expected state is recovered as failed rather than accepting the late completion.
- This closes the identified local file-store race; the PostgreSQL adapter must implement the same expiry predicate in the same atomic SQL statement as token/status fencing.

Verification status:
- Source and regression test were committed.
- Tests were not executed in this environment, so this is not yet a passing test result.


## Follow-up: atomic owner-scoped resume reservation (2026-11-03)

The runtime now adds a short-lived `resumeReservationToken` / expiry and a storage capability `reserveResumeForOwner`. The local file store performs owner, checkpoint, state, active-lease, and reservation checks plus reservation write under the same file lock. `DurableJobRuntime.resumeForOwner` requires this capability for shared stores, reserves before dispatch, and relies on the normal lease claim to atomically transition to running and clear the reservation. Public job serialization removes the reservation token.

A concurrent-resume regression test was added using two independent runtime instances against the same local store. The PostgreSQL schema draft now includes reservation columns, and the store contract requires a single conditional database mutation and a two-connection race test. This remains a contract/schema change only: no PostgreSQL adapter exists, and tests/build have not yet been run. The Vercel adapter therefore still uses its Preview-only local file store and is not production durable.


## Follow-up: PostgreSQL JobStateStore adapter scaffold (2026-11-03)

Added `src/brain/postgres-job-state-store.ts`, a driver-neutral adapter implementing the existing `JobStateStore` and `OwnedJobStateStore` contracts. It provides conditional SQL for worker claim/lease fencing, heartbeat, expired-lease recovery, owner-scoped get/list/cancel, atomic resume reservation, and save conflict fencing. It accepts a node-postgres-compatible `query(sql, values)` executor and adds no package dependency.

The factory now accepts an optional third argument `{ jobStateStore }`, allowing a host to inject a shared store without replacing the Brain/Executor architecture. Added SQL-contract unit tests and a partial index for active resume reservations. The contract document includes the host wiring example and explicitly keeps Vercel on local temp storage until a server-side Pool and migration are supplied.

Remaining release gates: no PostgreSQL driver/pool or migration runner is selected; no live PostgreSQL test has run; no two-connection integration race has been executed; Vercel adapter is not wired to a shared database; all code/tests/build remain unverified in this environment. Do not promote this adapter scaffold to production based only on SQL-string unit tests.


## Follow-up: shared run snapshot persistence (2026-11-03)

Identified a critical cross-instance resume gap: the new PostgreSQL job metadata adapter still depended on `FileRunStore` for Brain snapshots. A job claimed by another serverless instance could not reliably load a snapshot from the first instance's local filesystem. Added `PostgresRunStore` using a dedicated `sofia_agent_run_snapshots` table, injected the same optional `RunStore` into both Brain and DurableJobRuntime via the existing dependency factory, exported the adapter, and added a query-contract unit test. Local FileRunStore remains the default, so existing local behavior is preserved.

Still unverified: TypeScript build/tests, live PostgreSQL compatibility and concurrency, snapshot size/retention limits, host Pool injection, migration execution, and Vercel deployment.


## Follow-up: PostgreSQL transactional outbox adapter (2026-11-03)

Added `PostgresOutboxStore` and query-contract tests. The adapter supports idempotent enqueue, concurrent batch claims using PostgreSQL row locks with `SKIP LOCKED`, expiring worker leases, lease-fenced acknowledgement, and bounded retry/failure transitions. This is an at-least-once delivery foundation only: no dispatcher or Discord/Telegram transport is connected yet, and no live PostgreSQL, worker-crash, or end-to-end delivery tests have run. The migration already defines the outbox table and dispatch index.


## Follow-up: lease-aware outbox dispatcher (2026-11-03)

Added `src/brain/outbox-dispatcher.ts` and unit tests. The dispatcher:
- Claims bounded batches using a worker token and delegates delivery to an injected sender, so platform transports remain decoupled.
- Acknowledges only after sender success and only through the store's lease-fenced acknowledgement.
- Retries failed sends with bounded exponential backoff and a maximum-attempt threshold.
- Redacts and bounds persisted error text.
- Reports claimed, delivered, retried, failed, and lease-lost counts without exposing worker tokens.

Added package exports and documented delivery constraints. Delivery is at-least-once: a crash after remote acceptance and before acknowledgement can cause duplicates, so receivers should deduplicate with the stable outbox message ID. The dispatcher is sequential and does not renew leases; sender timeouts must be shorter than the configured lease.

Important remaining integration gap: `DurableJobRuntime` terminal job persistence is not transactionally coupled to outbox enqueue, and no Discord/Telegram sender is wired. A same-transaction terminal transition + outbox insert (or durable reconciliation) is required before claiming reliable terminal notifications. No database driver, live DB, migration execution, typecheck, test run, build, or deployment was performed for this change.


## Follow-up: atomic terminal job + notification enqueue (2026-11-03)

Added `PostgresJobStateStore.saveTerminalWithOutbox()`. A single PostgreSQL statement:
- Conditionally updates the terminal job only when owner identity and lease fencing still match.
- Inserts the corresponding outbox event from the successfully updated row, inheriting owner and notification destination from persisted job data.
- Uses the existing unique event key to make repeated terminal persistence idempotent.
- Inserts no notification when the job has no configured notification channel.
- Rejects non-terminal records before issuing SQL.

Updated `DurableJobRuntime` to detect this optional storage capability and use it for completed, failed, and cancelled terminal persistence. Existing local/file stores continue using their existing save path. The event payload is secret-redacted.

Added SQL-contract tests for atomic update+insert structure, owner/destination binding, lease fencing, unique event conflict handling, and rejection of non-terminal records. These are source-level tests only; they have not been executed.

Remaining limits:
- This capability only activates when the host injects `PostgresJobStateStore`; Vercel is not yet wired to PostgreSQL.
- No live PostgreSQL migration or integration test has run, so SQL dialect/runtime behavior is not yet proven.
- Cancellation requested for a queued job without an active worker still follows the direct cancellation path and does not yet guarantee an outbox event.
- Outbox delivery still requires a trusted worker and concrete platform sender implementations.
- The dispatcher is sequential and renews leases when the store supports it; sender adapters must honor AbortSignal and enforce bounded transport timeouts.
- No build, typecheck, unit tests, deployment, or production change was performed.


## Follow-up: atomic cancellation + managed outbox worker (2026-11-03)

Added `PostgresJobStateStore.cancelWithOutbox()`. It atomically transitions a queued/running job to cancelled and inserts an owner- and destination-scoped `job.cancelled` event in the same PostgreSQL statement. Owner-scoped cancellation applies the owner predicate in the database update. No event is inserted without a configured notification channel. The unique outbox event key prevents duplicate logical cancellation events.

Updated `DurableJobRuntime.cancel()` and `cancelForOwner()` to use the optional atomic capability when available; existing FileJobStateStore behavior remains unchanged.

Added `OutboxWorker` as a host-managed polling lifecycle with single-loop protection, bounded polling, error callback isolation, and graceful shutdown after active dispatch. It is exported from the package and has lifecycle tests.

Remaining limitations:
- The worker is not wired into a Vercel Daemon or any deployment; host startup must explicitly start it.
- No platform-specific sender is implemented, so this is still a transport-neutral worker.
- Lease renewal is not implemented; send timeouts must remain below the outbox lease duration.
- At-least-once delivery and crash-after-send duplicate risk remain.
- PostgreSQL SQL and migration have not been exercised against a live database. Added tests have not been run; no typecheck, build, or deployment was performed.

## Follow-up: outbox lease renewal (2026-11-03)

Added optional `OutboxStore.renewLease()` and PostgreSQL implementation. Renewal requires the message to remain processing, the same worker token, and an unexpired lease. The dispatcher renews approximately every third of the lease duration while a sender is active, supplies an AbortSignal, and aborts when renewal is lost or errors.

Changed dispatch cadence to claim one message at a time (up to batchSize) so later messages do not lose their leases while queued behind a slow send. Added tests for renewal fencing, successful long-send renewal, and abort on lease loss.

Remaining limitations:
- Sender adapters must honor AbortSignal; a remote side effect already accepted cannot be rolled back.
- At-least-once delivery remains; receivers should deduplicate using the stable message ID.
- Stores that do not implement optional lease renewal rely on bounded transport timeouts.
- PostgreSQL SQL and migration have not been exercised against a live database. Tests have not been run; no typecheck, build, or deployment was performed.


## Follow-up: outbox lease renewal hardening (2026-11-03)

Reviewed the lease-renewal path and tightened dispatcher ordering:
- Lease renewal remains fenced by message ID, processing status, worker token, and unexpired lease.
- Renewal runs during active sends and aborts the sender when the lease is lost.
- The dispatcher now stops and joins renewal before ACK/retry, preventing a late heartbeat from racing with terminal acknowledgement.
- A sender that ignores abort cannot cause ACK after a known lease loss.
- Explicitly handles JavaScript senders that reject with `undefined`.

Added regression tests for lost-renewal behavior and renewal/ACK ordering. Existing tests also cover renewal success and abort-aware senders.

Not verified: tests/typecheck/build have not been executed in this environment; no live PostgreSQL race test or deployment has been performed.
