# API Security and Deployment Guide

This is an operational checklist for the current API boundary, not a guarantee that every deployment concern is solved. Review the current CI and security issues before exposing Sofia to untrusted clients.

## Authentication and scopes

The host application configures `createSofiaApi(dependencies, config)` and supplies the static `apiKeys` map. Do not expose a public endpoint that can mint arbitrary keys.

- Send credentials as `Authorization: Bearer <key>` over HTTPS only.
- Generate unique, high-entropy keys per client. Never place server keys in browser bundles, mobile app binaries, source control, prompts, or logs.
- Use least-privilege scopes:
  - `agent:run`: submit runs/jobs, cancel runs, and read run/job status.
  - `agent:read`: read run/job status without granting run creation or cancellation.
  - `desktop:discover`, `desktop:workspace:list`, `desktop:workspace:read`, `desktop:workspace:write`, `desktop:process:execute`: derive the corresponding desktop capability grants.
  - `security:admin` (or configured `securityAdminScope`): access security status and kill/revive controls, plus learning diagnostics where configured.
- Admin scope does not implicitly grant `agent:run`; desktop scopes do not grant API run access.
- Desktop capabilities must be derived from authenticated server-side scopes and enforced by the desktop runtime, never trusted from request payloads.

The API computes an opaque owner ID from each key and scopes run/job operations to that owner. Treat run and job IDs as opaque.

## CORS and browser clients

Set `allowedOrigins` to exact trusted origins including scheme and port. Keep it empty if cross-origin browser access is unnecessary. Avoid wildcard CORS in production. CORS is not authentication; non-browser clients can call the server directly and must still authenticate.

## Resource limits

Configure `maxBodyBytes`, `maxRunsPerKeyPerDay`, `maxToolCallsPerKeyPerDay`, `maxConcurrentRunsPerKey`, `requestTimeoutMs`, and `runRetentionMs` for your workload.

**Important:** the current in-memory counters are process-local and may reset on restart. They do not coordinate quotas across replicas. Use a shared atomic store for rate limits, usage accounting, idempotency records, and concurrency reservations before claiming cluster-wide enforcement.

## Secrets, TLS, and storage

- Terminate TLS at a trusted ingress/reverse proxy and restrict direct access to the application port.
- Store provider credentials and API keys in the deployment secret manager. Rotate keys by issuing a replacement, updating clients, verifying usage, then removing the old key from server configuration.
- Keep `SOFIA_CAPABILITY_SECRET` and `SOFIA_AUDIT_SECRET` high-entropy and stable across instances that must verify the same capabilities or read the same encrypted audit data. Never reuse provider keys as these secrets.
- Restrict access to `SOFIA_STATE_DIR` and backups; run/job snapshots and memory may contain project context.
- Use an immutable, digest-pinned Docker image for sandbox execution. Process mode is not OS-level isolation. Do not expose shell, write, network, desktop, or destructive tools until permissions and approval paths have been verified.
- Keep bearer tokens, provider credentials, private prompts, and raw tool output out of logs. Redaction is defense in depth, not a replacement for least privilege or filesystem/network isolation.

## Pre-production checklist

- [ ] Configure unique per-client keys and least-privilege scopes.
- [ ] Verify missing, malformed, revoked, and insufficient-scope keys are denied.
- [ ] Verify one key cannot read, cancel, resume, or modify another key's runs/jobs.
- [ ] Verify desktop capabilities are server-derived and enforced by the desktop host.
- [ ] Verify write, shell, browser/network, desktop, and destructive actions require intended policy and approval.
- [ ] Test request-size limits, timeouts, cancellation, disconnects, quotas, and idempotency under concurrency.
- [ ] Use shared atomic stores for limits/reservations before scaling to multiple replicas.
- [ ] Run `npm run license:check`, `npm run typecheck`, `npm test`, and `npm run build`; inspect CI for the exact commit deployed.
- [ ] Review [open security issues](https://github.com/thanachai10096-arch/Sofia_agent/issues). Draft or unmerged PRs are not deployed behavior.

## Approval broker and API

The `ApprovalBroker` is wired into the API entrypoint when explicitly enabled. It creates a pending record bound to the authenticated principal, run ID, tool name, redacted input, risk, exact action hash, and expiry. Decisions are owner-only and one-shot; wrong hashes, replayed decisions, expired requests, missing principals, and aborted runs fail closed. The gateway records approval-required, approved, and denied outcomes in the security audit.

Approval payloads are capped at 64 KiB after secret redaction, and each principal can have at most 50 pending requests; the stores enforce the pending cap atomically.\n\nThe `InMemoryApprovalDecisionStore` is for tests and local development only. The built-in `SqliteApprovalDecisionStore` persists requests across restarts and uses conditional SQL updates so only one concurrent decision wins. For deployments across hosts, implement a transactional network-database adapter; SQLite WAL must not be assumed safe on an arbitrary shared network filesystem.

## Enabling the approval API

The API entrypoint can enable the built-in broker with SOFIA_APPROVAL_ENABLED=true. Set SOFIA_APPROVAL_STORE=sqlite (default) for a single-host SQLite store, or SOFIA_APPROVAL_STORE=redis for a shared Upstash Redis REST store. API keys that review their own pending requests must include the explicit approval:manage scope in SOFIA_API_SCOPES.

- GET /v1/approvals lists only pending requests owned by the authenticated principal.
- POST /v1/approvals/:id/approve and POST /v1/approvals/:id/deny require the exact 64-character action hash in the request body.
- Requests owned by another principal return 404. The route does not offer cross-principal admin approval.
- SQLite requires Node.js 22.5+ (node:sqlite), stores data at SOFIA_APPROVAL_STORE_PATH or .sofia/approvals.sqlite, and uses WAL plus transactional conditional updates. It is suitable only where processes share a filesystem with verified SQLite locking/WAL semantics.
- Redis mode uses UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or REDIS_REST_URL and REDIS_REST_TOKEN), with atomic Lua scripts for create/resolve and a principal-hashed inbox index. SOFIA_APPROVAL_REDIS_PREFIX optionally namespaces keys. All Redis script keys share a cluster hash tag. The adapter tests mock the REST contract; validate the real token permissions and Redis behavior in staging before enabling it in production.
- The SQLite database and sidecars are restricted to owner-only POSIX permissions where supported. Back up and persist the database directory. For production effectful tools, the gateway also reads back and verifies the exact `approval_approved` audit event before allowing the side effect; a missing or mismatched event blocks execution.



For effectful tool execution, `execution_started` is a write-ahead receipt, not proof that the external action did or did not happen. If a tool throws after invocation begins, Sofia records the outcome as `indeterminate` and leaves the start receipt unresolved for manual/provider-side reconciliation. It must not be interpreted as a confirmed failure or automatically retried: a provider timeout can occur after the provider accepted the purchase, transfer, or command. Only a verified `completed` receipt or a confirmed `failed` outcome closes the receipt. This audit mechanism detects uncertainty; it is not an atomic distributed idempotency ledger, and multi-host action deduplication remains future work.

The feature remains disabled unless explicitly enabled. Redis mode is the preferred shared store for multi-replica Railway deployments. Do not grant approval:manage to browser/mobile clients that should not approve actions.

## Per-user project workspaces

The API entrypoint provisions project workspaces under `.sofia/user-workspaces` (or `SOFIA_USER_WORKSPACES_DIR`). Set `SOFIA_MAX_CACHED_WORKSPACES` to bound the number of open per-project dependency/session runtimes (default 256, maximum 5000). The client supplies only an opaque project ID in the `workspace` field; it is validated as a short identifier and hashed before being used as a directory name. It is never interpreted as a filesystem path. Each workspace is rooted beneath the authenticated API principal's private directory, and its runtime, Brain services, and SQLite session store are created for that project. Requests without `workspace` use that principal's `default` project when the entrypoint resolver is enabled.

For multiple end users, configure a distinct high-entropy API key per user with `SOFIA_API_KEYS_JSON`, a JSON object mapping each key to its scopes. If this variable is absent, the legacy `SOFIA_API_KEY` plus `SOFIA_API_SCOPES` configuration remains supported. The API derives the principal from the bearer key; different keys are different principals and therefore receive different workspace roots, sessions, memories, and ownership boundaries. Do not share one master key among untrusted end users. Multi-principal mode refuses to start unless `SOFIA_SANDBOX_MODE=docker` and `SOFIA_SANDBOX_IMAGE` is pinned as `image@sha256:<64-hex-digest>`: process-mode child commands run under the same service OS identity and are not a tenant filesystem boundary. Multi-principal mode also rejects desktop scopes until desktop execution has a separate per-tenant OS boundary.

Example shape (use real random keys in the secret manager; do not copy these placeholders):

```json
{
  "user-key-one-placeholder": ["agent:run", "agent:read"],
  "user-key-two-placeholder": ["agent:run", "agent:read"]
}
```

The host resolver is optional for embedded API consumers. If it is not configured, requests that explicitly select a workspace are rejected rather than silently running against the process-wide workspace; multi-key hosts without a resolver fail closed as well. The built-in entrypoint configures the resolver. Durable jobs now use the selected project runtime: submit with `POST /v1/jobs` and a `workspace` project ID in the JSON body; list with `GET /v1/jobs?workspace=<project-id>`; and read/resume/cancel with `/v1/jobs/<job-id>?workspace=<project-id>`. If a submit request supplies `workspace` in both the body and query string, both values must match or the API rejects the ambiguous request with `400 workspace_selector_mismatch`. The server resolves the runtime from both the authenticated principal and project ID, then checks the job owner again before returning or mutating it. Cron schedules remain host-scoped and return `503 project_scoped_cron_unavailable` in project-isolated mode until their dispatcher and recovery loop are partitioned by project. Workspace isolation is an application-level boundary; continue to apply OS/container sandboxing and per-tool policy for hostile code.

## Current limitations

API keys can be configured through a static key-to-scope map using `SOFIA_API_KEYS_JSON` (or the legacy single-key variables); automated key issuance, rotation, revocation, and distributed quota storage remain deployment responsibilities. The built-in approval API is opt-in and the SQLite adapter is for a single host or a verified SQLite-compatible shared filesystem; a transactional network-database adapter for multi-host deployment remains future work. Approval behavior depends on the configured handler and tool gateway, so verify the exact host composition before enabling effectful tools.
