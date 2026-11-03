# Vercel owner-only composition blockers

Status: source audit; no runtime behavior changed.

This document extends `VERCEL_SERVERLESS_COMPATIBILITY_AUDIT.md` after tracing the existing dependency factory. The goal is to avoid accidentally deploying a local-machine composition into a serverless function.

## Additional verified blockers

### Dependency factory is a local host composition

`src/models/factory.ts:createSofiaAgentDependencies()` currently:

- Creates `createNodeWorkspaceRuntime(workspace)`, which grants access to a filesystem workspace.
- Loads the model provider configuration from process environment.
- Constructs local file-backed stores for Brain run state, project memory, skill lifecycle, evolution state, durable job state, and user memory.
- Creates a Playwright browser runtime when browser policy is enabled.
- Creates `DurableJobRuntime` with `FileRunStore` and a workspace path.
- Returns a `FileUserMemoryStore` with its default local state directory.

This is appropriate for the existing self-hosted/local mode. It is not a safe default for Vercel Functions: the instance filesystem is not a shared durable owner workspace, and different invocations may execute in different instances or regions.

### Session storage is opt-in SQLite, not a cloud session adapter

`createSofiaAgentDependenciesWithSessions()` opens `SqliteSessionStore` at an optional local database path and returns a close function. It does not provide a shared transactional session store suitable for serverless horizontal scaling.

### A shared job store alone would not make execution durable

`JobStateStore` has atomic claim/heartbeat/lease concepts, but `DurableJobRuntime` also owns in-process controllers and starts work in the process that calls submit/resume. A cloud implementation must pair persistence with a durable dispatcher/worker execution model. Do not wire a remote store into the current factory and assume detached work will survive a Function lifecycle.

## Required design boundary

Introduce an explicit deployment composition selection without changing the local default:

- `local`: current filesystem workspace, file stores, local Playwright and existing CLI/server behavior.
- `vercel-owner`: no implicit local workspace; requires explicitly supplied cloud storage, durable workflow/worker dispatcher, owner authentication, and a policy-limited tool profile. If any required adapter is absent, startup must fail closed with a clear configuration error.
- Never silently fall back from `vercel-owner` to local files or in-memory state.

## Tool capability policy for the first Vercel milestone

The first serverless owner deployment should not expose arbitrary local desktop/process tools. Until a remote workspace is deliberately designed and secured, disable desktop capabilities and host-local process execution in the Vercel composition. Keep the existing tool registry and policy gateway; pass a restricted, explicit capability profile rather than forking the Agent.

Browser automation must be separately evaluated for Vercel runtime limits, browser binary availability, outbound egress policy, and per-run resource budgets. Do not enable it merely because `PlaywrightBrowserRuntime` can be constructed.

## Safe implementation sequence

1. Add an explicit composition interface and tests that prove local composition remains unchanged.
2. Define cloud ports for workspace/files, job state, runs/idempotency, sessions, memory, schedules, and outbox.
3. Select a provider and region only after owner approval; implement transaction/lease tests against that real provider.
4. Add a durable workflow/worker dispatcher and ensure request Functions only validate, authorize, persist, and acknowledge.
5. Add an owner-only Vercel composition that refuses to start without every required adapter and security setting.
6. Test cold starts, parallel invocations, deployment replacement, retries, cancellation, idempotency, and owner isolation before enabling channels or Production.

## Explicit non-goals

- Do not change or remove the current local runtime.
- Do not make a second Sofia Agent or duplicate the Brain.
- Do not move personal workspace or memory data automatically.
- Do not provision a database, workflow service, or paid integration without approval.
- Do not enable public signup, multi-tenant access, or Production in this phase.
