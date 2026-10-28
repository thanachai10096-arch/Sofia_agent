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

## Current limitations

API keys are configured through a static key-to-scope map; automated key management and distributed quota storage remain deployment responsibilities until a dedicated implementation is merged. Approval behavior depends on the configured approval handler and tool gateway. Audit the exact composition used by your deployment rather than assuming every adapter has identical controls.

## Usage reporting

- `GET /v1/usage` reports per-API-key request and tool-call counters for the current accounting window.
- `brainRuns`, `brainModelCalls`, and `brainReservedOrUsedTokens` are aggregate counters from successful Brain completion reports, persisted when `usageStorePath` is configured.
- `brainReservedOrUsedTokens` is the Brain budget's reserved-or-used token count. It is **not** guaranteed to equal provider-billed tokens. Legacy runs and failed Brain runs may not contribute a completed Brain usage report.
- `providerInputTokens`, `providerOutputTokens`, and `providerUsageCalls` aggregate input/output token counts explicitly reported by the configured model provider and surfaced through the token-aware Brain route. They are omitted when provenance is not established; they do not substitute estimates for missing provider usage.
- `configuredCostNanoUsd` is the sum of configured route-price estimates for calls with verified provider token usage, expressed in nano-USD (1 USD = 1,000,000,000 nano-USD). It is omitted when no non-zero configured route price is available. The value is a local estimate, not provider-billed cost; BYOK model profiles or provider billing rules may use different rates. Do not treat this endpoint as an invoice or billing ledger.

### Configure price estimates and understand budget scope

- Set `SOFIA_FAST_INPUT_NANO_USD` / `SOFIA_FAST_OUTPUT_NANO_USD`, and the equivalent `SOFIA_CODING_*`, `SOFIA_REASONING_*`, and `SOFIA_VISION_*` variables, to the price per input/output token for each route. Values are integer nano-USD; for example, `1000` means 0.000001 USD per token. Confirm the provider's current pricing and units before setting them.
- An unset or zero route price means Sofia omits `configuredCostNanoUsd` for that run rather than reporting the route as free.
- `SOFIA_BRAIN_MAX_COST_NANO_USD` configures the Brain's **per-run** estimated-cost ceiling. `SOFIA_BRAIN_MAX_TOKENS` and `SOFIA_BRAIN_MAX_MODEL_CALLS` configure per-run token/call ceilings. These are not a durable daily budget shared across all runs for an API key.
- `usageStorePath` persists per-key aggregate reporting and API request/tool-call quotas; it does not by itself create a hard per-account spending cap. A strict account-wide spending limit needs durable per-key budget reservations that coordinate concurrent runs and reconcile actual usage before more provider calls are allowed.
- When a user supplies their own model profile, route-price estimates configured for the server's standard routes may not match that user's provider/model price. Do not use these estimates as the basis for charging customers without a separate, verified billing source.
