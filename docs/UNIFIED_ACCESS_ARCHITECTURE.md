# Unified Access Architecture

Status: architecture and shared chat-dispatch foundation. This document is not a claim that every client or provider adapter is already implemented.

## Goal

Web Chat, Desktop, Mobile, Telegram, Discord, Slack, and third-party SDKs must use the same Sofia API and Sofia Core. Channel adapters translate transport-specific events into the existing API contract; they must not contain a second planner, tool registry, or execution engine.

## Existing foundation to reuse

The current repository already has:
- `src/api/server.ts`: authenticated API, run submission, run lookup/cancellation, streaming, quotas, and optional run persistence.
- `src/sdk/client.ts`: HTTPS-enforcing client with async start, reconnectable run polling, cancellation, and job helpers.
- `src/desktop/` and `src/platform/local-runtime.ts`: local capability-gated execution foundations.
- `src/brain/job-runtime.ts`: durable job lifecycle foundation.

These capabilities must be checked against current tests and deployment configuration before treating a deployment as production-ready.

## Request path

1. Web/Desktop/Mobile or a server-side chat adapter receives a user command.
2. The channel authenticates its own user and validates the provider's webhook/signature where applicable.
3. The adapter maps the provider's immutable sender ID and conversation/channel ID to an allowlisted Sofia principal.
4. The adapter uses the Sofia SDK over HTTPS. Privileged Sofia API keys stay on trusted servers, never in browser or mobile bundles.
5. Sofia API validates API key, scope, quota, and run ownership, then forwards work to the existing Sofia Agent/Core.
6. The client tracks the returned run ID through polling or streaming and formats status for its channel.
7. Tool permissions and approval policy are enforced by Sofia regardless of the origin channel.

## Workspace isolation status

The current standalone API entrypoint constructs one Agent dependency graph from the
server-owned `SOFIA_WORKSPACE`. API keys scope run ownership, sessions, quotas, and
user memory, but that does **not** establish per-user filesystem/workspace isolation.
The request-level `workspace` field is therefore rejected with
`workspace_selection_unsupported`; callers cannot select an arbitrary host path.

Until a per-principal workspace resolver is implemented and wired through every
workspace-backed subsystem (Brain runtime, desktop tools, browser profiles, checkpoints,
project memory, skill state, jobs, and sandbox mounts), deployments must treat the
configured workspace as a single-tenant boundary. Do not expose a shared API key to
untrusted end users or claim multi-tenant workspace isolation.

The required follow-up is a server-owned principal-to-workspace mapping with canonical
path and symlink containment, isolated mutable state, and tests proving principal A
cannot read, write, list, execute in, or infer principal B's workspace. The resolver
must be applied before constructing each principal's runtime/dependency graph; merely
sanitizing a caller-provided path is insufficient.
 
## Channel implementation boundaries

| Channel | Adapter responsibility | Must not do |
| --- | --- | --- |
| Web Chat | Authenticated application session, stream/poll UI, reconnect | Expose a master API key in frontend code |
| Desktop | Pair local runtime, display approvals, reconnect to runs | Treat remote API access as permission to all local files |
| Mobile | Use authenticated backend, async runs, polling/reconnect | Embed privileged API keys in the app |
| Telegram | Verify webhook configuration/secret, map chat + sender IDs, reply to run status | Trust display names or accept arbitrary chats by default |
| Discord | Verify interactions/signatures, map guild/channel/user, acknowledge within provider limits | Trust message text as identity or skip replay handling |
| Slack | Verify signing secret and timestamp, map workspace/channel/user, acknowledge promptly | Process unverified/replayed events |
| API/SDK | Stable versioned contract, scopes, quotas, errors, reconnectable jobs | Bypass API policy or accept cross-owner run IDs |

## Shared chat dispatcher

`src/integrations/chat-adapter.ts` is a transport-neutral dispatcher intended for provider adapters. It expects a *verified* command envelope, checks an explicit access policy, limits task size, claims a provider message ID for deduplication, and submits through the same Sofia client API. The caller must implement platform signature verification. `src/integrations/file-chat-deduplicator.ts` provides a durable, atomic local-filesystem implementation: exclusive file creation prevents concurrent duplicate claims and marker files survive process restarts. It intentionally does not expire successful claims, avoiding replay after an arbitrary TTL; operators must plan retention/cleanup, and multi-host deployments should use a shared database with a unique constraint. Release a claim only when the downstream request definitively failed and retry is safe. An in-memory dedupe map is suitable only for tests.

## Delivery order

### P0 — API and security contract
- Verify authentication/scopes, owner checks, quota/rate limits, cancellation, run-store behavior, and workspace isolation.
- Define channel-to-Sofia identity linking and revocation.
- Enforce the same Tool Policy and approval requirements for every channel.
- Never expose secrets, internal stack traces, or privileged tool output to a channel by default.

### P1 — Web Chat and SDK
- Reuse `SofiaClient.start()`, `getRun()`, `cancel()`, and the existing stream endpoint.
- Add a browser-facing backend/BFF so the master API key stays server-side.
- Add reconnectable conversation/session storage and SSE reconnect semantics.
- Test owner isolation, expired credentials, duplicate requests, network loss, and cancellation.

### P2 — Desktop and Mobile
- Desktop connects to a paired Local Runtime with explicit capability grants and approval UX.
- Mobile is a control/monitoring client first; local-device execution is a separate capability and must not be implied.
- Add secure pairing/revocation, session expiry, and reconnect flows.
- Test Windows, macOS, Linux, iOS, and Android only where an actual supported client/runtime exists.

### P3 — Telegram, Discord, Slack
- Implement one provider adapter per platform, each with its own signature verification and webhook/event rules.
- Use a server-side Sofia SDK client and a least-privilege API key scoped to `agent:run` and only necessary read permissions.
- Require explicit sender/chat/workspace allowlists initially.
- Use durable idempotency, bounded message lengths, safe status formatting, rate limits, and clear approval handling.
- Add provider-specific integration tests using signed fixtures; do not claim live integration without real provider credentials and webhook tests.

### P4 — Production readiness
- Add end-to-end tests from each channel to a disposable workspace and independent result verification.
- Test provider retries, duplicate delivery, timeout, cancellation, server restart, job recovery, and authorization failures.
- Add metrics for accepted/rejected commands, run latency, failures, and approval waits without logging secrets or raw sensitive prompts.
- Document deployment, secrets, webhook setup, data retention, and incident response.

## Acceptance criteria

- All channels use the same API and Sofia Core.
- An unauthorized user cannot submit, read, cancel, or approve another user's run.
- Duplicate provider events do not create duplicate runs.
- Losing a client connection does not silently lose a run ID or expose another user's run.
- Every tool action remains subject to Sofia's policy and approval enforcement.
- Provider adapters pass signature/replay tests and a real provider smoke test before being described as operational.
- Typecheck, unit tests, build, CI, and end-to-end evidence are reported separately; no one check substitutes for the others.

### Principal workspace resolver foundation

`src/platform/principal-workspace.ts` now provides a stable opaque SHA-256 mapping from an authenticated principal ID to a dedicated directory. It rejects invalid principal IDs, symlink roots, and symlink tenant directories, and verifies the canonical tenant path remains beneath the configured root. Regression tests cover stable mapping, cross-principal directory separation, invalid IDs, and symlink rejection.

This is **not yet wired into the API/Agent composition root**. The current `createSofiaAgentDependenciesWithSessions()` still creates one process-wide dependency graph from the configured workspace; the resolver must not be treated as enabling multi-tenant execution until every runtime and mutable store is constructed per principal and cross-tenant integration tests pass. The resolver also cannot eliminate OS-level TOCTOU races against a hostile local process with write access to the workspace root.

The resolver also exposes `resolveStoreDirectory(principalId, storeName)` for fixed application-owned state namespaces (for example `memory`, `jobs`, or `checkpoints`). It validates store identifiers and checks the canonical path and symlink boundary beneath that principal's workspace. This helper is still not a substitute for wiring every store to the resolved directory.

### Principal-scoped dependency graph: implementation contract

The API refactor must not stop at selecting a workspace path. The authenticated
principal must select one complete dependency graph, and every mutable resource
created by that graph must be rooted in that principal's workspace.

| Resource | Current composition point | Required tenant boundary |
| --- | --- | --- |
| Workspace filesystem and desktop runtime | `createSofiaAgentDependencies()`, `createBrainFactory()`, `DesktopRuntime` | Construct from the resolved principal workspace; never accept a request-supplied path |
| Brain run snapshots and checkpoints | `FileRunStore`, `DurableCheckpointManager` | Principal-specific state directory and namespace |
| Project memory and learned-skill ledger | `FileProjectMemoryStore`, `PersistentSkillLedger` | Principal-specific project-memory root |
| Skill lifecycle and benchmark history | `VersionedSkillLifecycle`, `FileSkillBenchmarkHistory` | Principal-specific lifecycle and benchmark files; no shared mutable singleton |
| Evolution and audit evidence | `EvolutionEngine`, `EncryptedFileAudit`, `AuditSkillEvidenceVerifier` | Principal-specific persistence and verifier; preserve an explicit platform-level audit path only for genuinely global security events |
| Durable jobs | `DurableJobRuntime`, `FileJobStateStore` | Principal-specific state namespace/root; every get/list/resume/cancel/notification path must enforce the authenticated owner |
| API runs and idempotency | `createSofiaApi()`, `FileRunRecordStore`, in-memory run/idempotency maps | Principal-scoped runtime and durable records, or a shared store with mandatory owner predicates on every operation |
| Sessions | `SqliteSessionStore.open(databasePath)` | Explicit principal-specific database path; session IDs must remain owner-bound |
| User memory | `FileUserMemoryStore` | Keep identity hashing and owner checks; use a principal-specific root when composing isolated dependency graphs |
| Browser profiles | `BrowserProfileStore`, `BrowserProfileSessionManager` | Principal-specific profile storage and lifecycle; never share authenticated cookies or page handles |
| Quotas | `UsageLimiter` | Preserve key-level accounting; tenant graph selection must not reset or bypass API-key quotas |

#### Required request lifecycle

1. Authenticate the API key and derive the opaque principal exclusively from
   `auth.keyId`. Ignore any client-provided principal or workspace identifier.
2. Resolve the principal workspace using `PrincipalWorkspaceResolver`.
3. Obtain or create that principal's dependency graph from a server-owned
   registry. The graph must include its Agent/Brain factory, workspace runtime,
   stores, browser profile manager, and job runtime.
4. Route run submission, streaming, polling, cancellation, jobs, cron, memory,
   and session operations through that same principal graph.
5. On shutdown, close each graph's SQLite handles and browser profiles only
   after its active runs/jobs have stopped or been safely drained.
6. Bound registry growth without evicting a graph that still owns active work.
   A process restart must reconstruct the same paths and recover only that
   principal's durable jobs/checkpoints.

#### Cross-tenant acceptance tests

- Principal A cannot read, write, list, execute, resume, cancel, or infer
  Principal B's files, sessions, memories, runs, jobs, checkpoints, browser
  profiles, learned skills, or audit evidence.
- A request body containing another principal ID or an arbitrary workspace
  path cannot change the authenticated principal's dependency graph.
- Two principals can run concurrently without sharing mutable runtime objects,
  browser handles, session databases, skill lifecycle state, or job state.
- Restart recovery, cron dispatch, and notification delivery preserve owner
  boundaries and cannot resume another principal's work.
- Registry shutdown closes all tenant-owned resources; capacity management
  never discards a live job's dependencies.
- Tests use temporary roots and distinct API keys, and include negative
  cross-owner attempts for every read/mutation endpoint.

This matrix is an implementation contract, not a statement that these
boundaries already exist. The current process-global `SofiaAgent`,
`DurableJobRuntime`, run map, cron scheduler, and entrypoint dependency graph
must be refactored before the product can claim multi-tenant isolation.
