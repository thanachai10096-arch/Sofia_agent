# Vercel serverless compatibility audit

Status: source audit complete; implementation gate for the owner-only Preview deployment.

## Executive finding

The existing Sofia Core is reusable, but the current Node HTTP server composition is not a Vercel Functions entrypoint. Do not import `src/api/entrypoint.ts` from a Function and do not treat a successful Vercel build or `/api/health` response as proof that agent execution is ready.

This audit is deliberately additive. It does not replace the Core, alter the local runtime, select a database vendor, or enable Production.

## Verified source-level findings

### 1. HTTP composition is coupled to a listening server

- `src/api/server.ts` constructs a Node `Server` with `createServer(...)` and returns that server.
- Its route callback uses `IncomingMessage` and `ServerResponse` directly.
- The same composition starts a cron recovery/tick loop on the server's `listening` event and clears it on `close`.
- `src/api/entrypoint.ts` calls `server.listen(...)`, starts the Telegram runtime, starts a Discord transport, and owns shutdown handlers and a periodic Discord recovery timer.

**Consequence:** a Vercel Function must not import the entrypoint. The HTTP route logic needs an explicit request-handler boundary that can be called by both the existing Node server and a Vercel adapter, while lifecycle workers remain outside the request Function.

### 2. Ordinary API runs are process-local and detached

- `src/api/server.ts` stores active runs and idempotency entries in in-memory `Map` instances.
- `startRun` starts an async task without awaiting it from the HTTP request lifecycle.
- `RunRecordStore` is optional and its file implementation describes itself as best-effort; save failures are swallowed and in-memory state remains authoritative.
- The server rehydrates old queued/running run records as failed after restart rather than handing them to a durable worker.

**Consequence:** returning `202 Accepted` and relying on a detached promise is not a durable execution strategy on serverless infrastructure. A request may end or an instance may be reclaimed before the task finishes.

### 3. Durable Brain jobs have a useful adapter seam, but the default is local files

- `src/brain/job-runtime.ts` defines `JobStateStore` with claim, heartbeat, expiry recovery, cancel, save, list, and get operations.
- `DurableJobRuntime` uses `FileJobStateStore` by default.
- The file implementation explicitly rejects a lock owned by another host and documents that multi-host coordination needs a shared transactional store.
- The runtime starts execution from `submit` and keeps controllers/worker coordination in process memory.

**Consequence:** the interface is a good compatibility seam for a cloud adapter, but a cloud store alone is insufficient. Dispatch, lease renewal, checkpoint persistence, cancellation, and result delivery must be owned by a durable worker/workflow service rather than by the request Function.

### 4. Cron is not a serverless scheduler yet

- `CronScheduler` has a `CronStore` transaction boundary and a file-backed implementation.
- `createSofiaApi` starts cron recovery and one-second ticking from Node server lifecycle events.

**Consequence:** keep schedule definitions and execution history in durable storage, but move ticking/dispatch to a durable scheduler or workflow trigger. Never rely on a warm Function or `setInterval`.

### 5. Existing channel adapters are ingress-only

- `api/telegram/webhook.ts` and `api/discord/interactions.ts` forward requests to `SOFIA_API_BASE_URL`.
- Both currently expect an upstream HTTPS API and server-side key.
- The Telegram route acknowledges after upstream acceptance; its own comments note that upstream idempotency is currently process-local and completion delivery is outside the route.
- Discord HTTP interactions provide slash-command interactions, not arbitrary Discord message events.

**Consequence:** do not configure channel secrets until the real owner-only execution endpoint, durable acceptance, idempotency, and completion outbox are deployed. Discord natural chat still needs a separate Gateway/event worker.

## Target composition (preserve existing Core)

1. **Request adapter:** Vercel Node Function translates the platform request into a framework-neutral Sofia API request and response. The current Node server remains a supported local/self-hosted adapter.
2. **Composition root:** constructs the existing `AgentDependencies`, auth policy, model router, tool registry, and security controls without opening a listener or starting timers.
3. **Durable acceptance:** authenticate the owner, validate scopes, reserve an owner-scoped idempotency key, persist a job and outbox event transactionally, then return the durable job ID.
4. **Worker/workflow:** claim with lease fencing, load the persisted job, invoke the existing Brain/Agent execution path, persist checkpoints and terminal state, and renew/release leases safely.
5. **Completion outbox:** persist channel delivery intent and receipt; retry delivery without rerunning completed work.
6. **Owner data adapters:** implement shared transactional adapters behind existing storage interfaces for jobs, runs/idempotency, sessions, memory, schedules, and delivery receipts.

## Required invariants

- Every job, run, memory item, session, schedule, idempotency record, and delivery receipt is scoped to the authenticated owner.
- No provider credential or master Sofia API key is sent to browser code or chat clients.
- Claims and writes use atomic transactions and lease-owner fencing across workers.
- A repeated webhook/request with the same owner-scoped idempotency key cannot create a second logical job.
- A Function timeout or deployment replacement cannot silently lose accepted work.
- Cancellation, retry, resume, and completion notification are durable state transitions.
- User-provided task/context remains untrusted input; existing policy, approvals, tool scopes, and output redaction remain in force.
- The file/SQLite local mode continues to work; cloud adapters are additive and selected explicitly.

## Implementation order

### V1 — Extract the HTTP boundary

- Separate route dispatch from `createServer` without changing route behavior.
- Keep `createSofiaApi` as a compatibility wrapper around the same handler.
- Add request/response contract tests for health, auth, scopes, CORS, body limits, run/job ownership, memory, cron, and Discord signature route behavior.
- Ensure constructing the Vercel handler has no listener, polling, timer, or background side effect.

### V2 — Durable owner storage

- Define and test transactional cloud implementations for `JobStateStore`, `RunRecordStore`, `CronStore`, user memory, sessions, idempotency, and outbox.
- Do not choose or provision a database until the owner explicitly selects provider, region, backup, retention, and deletion policy.
- Keep secrets in Vercel server-side environment variables only.

### V3 — Durable worker and channels

- Add a workflow/worker dispatcher with bounded execution, leases, checkpoints, retry policy, and idempotent completion.
- Make Telegram/Discord ingress persist accepted work before acknowledging.
- Deliver final messages from the outbox; do not hold a webhook open for the Agent run.
- Keep Discord Gateway in a separate persistent worker, not a Vercel Function.

### V4 — Owner-only Preview acceptance

- Verify exact deployed commit, tests, cold starts, repeat invocations, worker termination/recovery, duplicate webhook delivery, cancellation, and owner/denied identity behavior.
- Keep Production disabled until the rollout document's O4 gate is satisfied.

## Explicitly not done

- No database or paid service has been provisioned.
- No personal memory, chat history, credentials, or local workspace has been migrated.
- No Vercel Production promotion or DNS cutover has been performed.
- No public signup, multi-tenant access, billing, or user-issued API keys have been added.
- No tests are claimed by this source audit alone.
