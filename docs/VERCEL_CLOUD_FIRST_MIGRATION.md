# Vercel Cloud-First Migration Plan

Status: architecture decision and migration gates only. This document does not claim that Sofia is deployable on Vercel yet, and it does not authorize a production cutover.

## Goal

Operate Sofia Agent as a cloud service that the owner can use entirely from an iPhone. No personal computer or always-on home machine is required. The existing Sofia Core, model routing, tool policy, approval rules, memory semantics, and channel identity boundaries remain the source of truth.

The migration is additive and staged. Railway remains the current working deployment until the Vercel path passes the same acceptance checks. Do not delete Railway services, change production DNS, or migrate/delete existing data as part of the initial Vercel setup.

## Findings from the current repository

The current `main` branch contains a Node HTTP API and local-process composition root, not a Vercel serverless application:

- `src/api/entrypoint.ts` starts a long-lived HTTP server and composes the Core.
- Telegram currently uses Bot API long polling via `createTelegramMessagingRuntime`.
- The optional Discord Gateway transport is a persistent connection (currently in a draft PR); Discord signed HTTP interactions are the serverless-compatible path.
- `src/api/server.ts` constructs a `CronScheduler` and owns process-local timer lifecycle.
- Job state, Brain checkpoints, project memory, API run records, usage state, and message deduplication use local filesystem-backed stores.
- The README explicitly says file-backed state is single-process and temporary storage is not sufficient for production recovery.
- `CloudExecutionBackend` currently has only `LocalJobBackend`; it is not a remote execution backend.
- The repository has no root `vercel.json` and no Vercel function entrypoint for the existing API.
- The Vercel project `i888` is connected to this repository and has successfully built the isolated Preview smoke-test function. It is not yet a production-ready Sofia deployment: no PostgreSQL resource or project connector is configured, the existing API composition root still assumes a long-lived process, and the Preview endpoint has not yet been independently verified through an HTTP request.

### Additional source-level verification

The existing source was inspected directly on the migration branch:

- `src/api/entrypoint.ts` reads `SOFIA_API_KEY` at module startup and throws if it is absent; it creates a workspace directory and constructs local dependencies before listening.
- The same entrypoint starts the Telegram runtime after the HTTP server begins listening.
- When Discord Gateway configuration is enabled, the entrypoint starts a persistent transport and a five-second recovery interval. These are worker/process lifecycle concerns, not request-scoped function work.
- `src/api/server.ts` creates process-local `Map` instances for active runs and idempotency. It starts async run execution using a detached promise after returning an accepted response. A serverless request must not rely on that promise or warm-instance memory to finish work.
- The API's run-record persistence is optional and currently wired by the local entrypoint to `FileRunRecordStore`. The usage limiter also receives a local file path.
- The Vercel project connector query returned an empty connector list. This is evidence that no database connector is currently attached to this project, not evidence that no external database could ever be configured.

These findings mean the current entrypoint must not be imported or wrapped as a Vercel Function. Doing so would risk dropped background tasks, lost in-memory idempotency/active-run state, duplicated work after retries, and non-durable local-file writes.

These are architectural blockers, not merely deployment-setting changes.

## Target architecture

```text
iPhone (Telegram / Discord / mobile web)
             |
             v
Vercel HTTPS Functions
  - authenticated API / BFF
  - Telegram webhook endpoint
  - Discord signed-interaction endpoint
  - health and status endpoints
             |
             +------> Postgres (durable shared state)
             |          - owners / sessions
             |          - jobs / checkpoints / run records
             |          - idempotency / dedupe / quotas
             |          - user and project memory
             |          - cron schedules and history
             |
             +------> Vercel Workflow SDK
             |          - durable task orchestration
             |          - retry / resume / wait / notification
             |
             +------> isolated execution environment
                        - workspace per run
                        - bounded tools and network egress
                        - artifacts in object storage
             |
             v
          Sofia Core
  plan -> act -> verify -> recover
  policy / approval / model routing
```

Sofia Core must remain provider-agnostic and must not be reimplemented inside channel adapters. All channels use the same authenticated API and policy gateway.

## Migration workstreams

### P0 — Establish a Vercel preview target

1. Keep the existing isolated `api/health.ts` smoke-test function separate from Sofia Core.
2. Add a Vercel-compatible Core adapter only after its dependencies are request-safe and durable; it must not start a listener, polling loop, detached task, or permanent timer during module initialization.
3. Keep the existing Node server entrypoint unchanged for Railway and local deployments.
4. Verify function routing, Node runtime, environment isolation, and redacted logs on Preview.
5. Keep `main` and the existing Railway service as the rollback path.

### P1 — Replace local-only state with shared durable storage

Introduce store interfaces and a PostgreSQL implementation for the production cloud path. Preserve the existing file-backed stores as the local/single-process implementation.

Required durable records:
- Job lifecycle, lease/fencing tokens, checkpoints, cancellation, and completion notifications.
- API run records, ownership, idempotency keys, and request fingerprints.
- Conversation/session context with strict owner + channel scoping.
- User memory and project memory, including existing prompt-injection checks and secret redaction.
- Skill ledger and evidence/provenance records.
- Usage/quota reservations, rate limits, and message deduplication.
- Cron schedules, execution history, retries, and misfire/recovery state.

Use database transactions and unique constraints for cross-instance ownership, idempotency, and provider event deduplication. Do not use Vercel `/tmp` as persistent storage. Do not horizontally scale the existing file stores.

### P2 — Durable task execution

Integrate the Vercel Workflow SDK behind the existing job/cloud-execution contracts. A webhook/function must acknowledge quickly and start or resume a durable workflow; it must not rely on an unawaited promise, `setInterval`, or a warm function instance to finish a task.

Workflow steps should:
- persist the accepted request and authenticated owner;
- acquire an idempotent job claim;
- invoke the existing Sofia execution lifecycle with explicit resource/time/tool budgets;
- persist checkpoints and safe progress;
- retry only retryable failures and never repeat non-idempotent external actions blindly;
- support cancellation and owner-scoped status lookup;
- deliver the final result to the originating conversation, with delivery retries and deduplication.

For tasks requiring a writable workspace, use a disposable isolated execution environment and persist artifacts outside the function filesystem. Never expose unrestricted shell, host files, or arbitrary network egress.

### P3 — Make chat transports serverless-compatible

- Telegram: add a webhook transport with Telegram secret-token verification, raw-body/size limits, replay/deduplication, allowlisted immutable user/chat IDs, and outbound Bot API delivery. Do not run long polling on Vercel.
- Discord: use the existing signed HTTP interaction route for slash commands. A persistent Discord Gateway connection must run in a worker-capable environment and must not be started inside a Vercel Function.
- Slack and additional providers: use their verified HTTP event/webhook protocols, then dispatch to the same Sofia handler and durable workflow.
- Keep natural-language chat behavior and the existing command path; ordinary text in an enabled/allowlisted conversation must not require `/run`.
- Never place provider tokens or Sofia master API keys in the iPhone/browser bundle.

### P4 — Scheduled work and operations

Move recurring schedules from the in-process timer to durable orchestration. Platform Cron may be used only as a trigger to enqueue due work; the database/workflow layer remains authoritative for schedule state, deduplication, timezone semantics, missed executions, and retries.

Add redacted structured logs, workflow/job metrics, alerts for stuck jobs, and an operator recovery procedure. Ensure secrets are not logged.

## Required acceptance gates

No production cutover until all applicable checks pass on the exact preview commit:

1. `npm run license:check`, `npm run typecheck`, `npm test`, and `npm run build`.
2. Cold start and repeated invocation do not lose API configuration or rely on mutable module state for correctness.
3. Two concurrent function instances cannot create duplicate jobs for one provider event or idempotency key.
4. A job survives function termination, deployment replacement, and workflow retry; status and cancellation remain owner-scoped.
5. Checkpoints, memory, sessions, run records, quotas, and cron state survive restart and are isolated between users.
6. Telegram webhook signature/secret verification, duplicate delivery, allowlist rejection, and outbound completion delivery pass live smoke tests.
7. Discord signed interactions pass signature, timestamp, replay, allowlist, acknowledgement, and result-delivery tests.
8. Tool policy, approvals, workspace containment, secret redaction, network restrictions, and cancellation remain enforced through workflow execution.
9. A real iPhone-only acceptance test covers submitting a task, closing Telegram/the browser, returning later, reading the result, cancelling a task, and receiving an approval request.
10. Cost and plan limits are measured before enabling always-on or high-volume workloads.

## Explicit non-goals for the first migration

- No rewrite of the Agent Brain or replacement of Sofia Core.
- No merge of unrelated draft PRs as a shortcut.
- No production deployment or DNS cutover during foundation work.
- No destructive database migration or deletion of Railway state.
- No claim that Discord Gateway, Telegram long polling, local desktop capabilities, or unrestricted browser/shell execution work inside a serverless function.

## References

- Vercel Functions limits: https://vercel.com/docs/functions/limitations
- Vercel Node.js Functions: https://vercel.com/docs/functions/runtimes/node-js
- Vercel Workflow SDK: https://github.com/vercel/workflow
- Vercel Git deployments: https://vercel.com/docs/git
- Sofia cloud execution contract: `docs/CLOUD-EXECUTION-BACKEND.md`
- Sofia API security: `docs/API_SECURITY.md`
- Sofia messaging gateway: `docs/MESSAGING_GATEWAY.md`
- Sofia unified access architecture: `docs/UNIFIED_ACCESS_ARCHITECTURE.md`


### P1 storage contract audit — 2026-11-02

The following matrix records the actual seams inspected in the migration branch. It distinguishes reusable contracts from stores that still need an additive cloud contract. This is an architecture audit only; no database provider, schema, credentials, or migration has been selected.

| State domain | Current source contract / implementation | Cloud-readiness finding | Safe next step |
|---|---|---|---|
| Cron schedules/history/audit | `CronStore.transact(operation)`; `FileCronStore` | The transaction boundary is a good adapter seam, but the `SchedulerState` type passed through the public interface is not exported. File locking is local-filesystem coordination, not a multi-host database lock. | Export or relocate the state contract additively, add contract tests, then implement a transactional shared-store adapter. Keep `FileCronStore` as default for local/Railway. |
| Long-running Brain jobs | `JobRuntime` is public; `FileJobStateStore` is private inside `src/brain/job-runtime.ts` | Job state has leases, heartbeats, fencing tokens, cancellation, and checkpoint persistence, but the state-store contract is private and the runtime owns process-local maps/controllers. | Extract a public additive `JobStateStore` contract without changing `JobRuntime`; make lease claim/heartbeat/save/cancel atomic in a shared adapter and test two-worker races. |
| API run records | `RunRecordStore.save/remove/loadAllSync`; `FileRunRecordStore` | The synchronous full-store read blocks a clean remote database implementation. API startup rehydrates records synchronously; writes are best-effort and swallowed on failure. | Introduce an async `RunRecordRepository`/initialization path alongside the legacy interface. Preserve record validation, owner scoping, capability allowlist, idempotency hash and request fingerprint. |
| API active runs/idempotency/concurrency | Local `Map` objects inside `createSofiaApi` | These maps are not shared across instances; detached run execution is not durable under serverless termination. | Move acceptance, idempotency reservation, per-owner concurrency reservation, and status transitions into transactional shared storage; dispatch work to durable workflow only after commit. |
| User memory | `UserMemoryStore`; `FileUserMemoryStore` | The interface is reusable. The implementation hashes user IDs for filenames and applies secret redaction and prompt-injection filtering, but its write queue is process-local and files are local. | Implement a shared adapter preserving user scoping, validation, limits, redaction, prompt-injection checks, and explicit-write semantics. Add cross-user isolation and concurrent-write tests. |
| Project memory / skill ledger | `ProjectMemoryStore`; `FileProjectMemoryStore`; `PersistentSkillLedger` | The contract is reusable, but file writes do not use a cross-process transaction/lock. The ledger has a synchronous file-backed warm cache and async fire-and-forget persistence, which is not a durable cloud commit boundary. | Add an awaited durable ledger path and a cloud-safe cache/reload strategy; retain existing file implementation for local use. Preserve evidence IDs and provenance. |
| Usage quotas | `UsageLimiter` in `src/api/usage.ts` | With no storage path, counters are in-memory. With a path, it uses synchronous local file locking and filesystem persistence. Neither is a cross-instance serverless quota authority. | Add an async atomic quota-reservation contract with database-side increment/limit enforcement. Keep current limiter for local/single-process compatibility. |
| Session/conversation state | Existing session wiring requires further path-level audit | Do not assume the existing session persistence is cloud-safe based on memory APIs. | Trace session identity and store wiring separately before selecting a schema; require owner + channel + conversation scoping and retention/deletion behavior. |
| Provider event deduplication | API idempotency is reconstructed from run records; channel dedupe is a separate concern | Rehydrating a local map is not sufficient for concurrent webhook deliveries across instances. | Add provider-scoped unique event keys and atomic insert-or-return semantics; keep raw provider secrets and raw idempotency keys out of storage/logs. |

#### Required compatibility design

1. Keep existing file stores and their constructors as the local/Railway defaults. Cloud adapters are opt-in through composition-root dependency injection; no environment variable should silently switch an existing deployment to a new database.
2. Introduce async contracts additively. Do not change `loadAllSync()` in place or make existing synchronous callers unexpectedly asynchronous. Add a new cloud initialization/repository path and migrate callers in a separately reviewed change.
3. Make the database transaction the authority for uniqueness and concurrency: owner-scoped idempotency, provider event dedupe, job leases/fencing, quota reservations, and schedule claims must not rely on process-local maps or file locks.
4. Preserve the current validation and security behavior at adapter boundaries: `ownerKeyId`, `desktopCapabilities`, allowed capability values, hashed idempotency identifiers, request fingerprints, prompt-injection filtering, secret redaction, and tenant isolation.
5. Define retention, export, deletion, backup, restore, and encryption expectations before storing personal conversation or memory data in a hosted database. Do not log memory contents, provider tokens, API keys, or raw webhook bodies.
6. Add shared contract tests that run against both the existing file implementation and each future cloud adapter. Add concurrency tests with two independent adapter instances, not only one in-process instance.

#### Implementation order after a database choice is approved

- **P1a — Contracts and tests:** export stable cron state types; extract job-state contract; define async run-record repository and quota reservation contract. No schema or provider dependency yet.
- **P1b — Shared persistence adapter:** select a supported PostgreSQL provider only after explicit provider/region/retention approval; add migrations as additive tables, indexes, and constraints. Never run destructive migration automatically.
- **P1c — Composition:** inject cloud stores into a new Vercel-specific composition root; keep Railway/local composition untouched. Do not import `src/api/entrypoint.ts` from a Function.
- **P2 — Workflow dispatch:** transactionally persist and enqueue a durable workflow; add outbox/reconciliation if enqueue and database commit cannot be atomic. Do not use detached in-process promises as the execution guarantee.
- **P3 — Cutover gate:** run compatibility, concurrency, recovery, security, privacy, and iPhone acceptance tests on Preview before any production decision.

No database implementation is started in this change because the project currently has no configured database connector and the user has not selected a provider or approved its data residency/retention. This avoids creating an unreviewed data-processing dependency or requesting credentials in chat.

## Implemented preview smoke test

The additive root-level `api/health.ts` function is a routing smoke test for Vercel Preview deployments. It supports GET/HEAD and returns an explicit status document. A successful response proves only that Vercel routed a request to a Node Function; it intentionally reports Sofia Core, durable storage, and durable execution as not connected. It must not be used as a production-readiness signal.

The Preview deployment for commit `8c6948ebfa5a9d3bd62af6a7e0c4d03f87751903` reached Vercel state `READY` and the build log reported `Build complete` and `Deployment completed`. This verifies deployment/build completion, not successful external HTTP invocation. An HTTP request through the available web client could not access the endpoint, so the endpoint response remains unverified.

After deploying this branch as Preview, verify:
- `GET /api/health` returns HTTP 200 and `deployment: "serverless-function-reachable"`.
- `POST /api/health` returns HTTP 405.
- The response keeps `Cache-Control: no-store`.
- The function does not read secrets, initialize local filesystem stores, start timers, or create background work.

This smoke test is an isolated first step. The existing long-running Node API is still not adapted to Vercel Functions, and no production cutover is authorized.


## Preview deployment verification — 2026-11-02

A subsequent Preview deployment was created from commit `81e1c8cb67b26559249c66833af9af236c49090b`:

- Deployment ID: `dpl_25mfzBvgWf6yUz9KLrXJ8mPm1FZr`
- Project: `i888`
- State: `READY`
- Build logs show `npm run build` invoking `tsc -p tsconfig.build.json`, followed by `Build complete` and `Deployment completed`.
- Vercel reported its separate Typecheck step as skipped because a Build Command is configured; TypeScript compilation nevertheless ran as part of the build command.
- Build emitted an npm warning that the `esbuild@0.28.2` install script was not yet covered by the environment's `allowScripts` policy. The build still completed; do not silently approve install scripts without reviewing the dependency and build requirements.
- An external HTTP GET to `/api/health` could not be completed using the available verification client. Runtime logs queried for the latest 30 minutes returned no entries; this does not prove that the endpoint was invoked or that it returned a successful response.

Therefore, the deployment/build gate is passed for this Preview commit. The HTTP route gate remains pending. The deployment is still a smoke-test deployment, not a connected Sofia Core service.
