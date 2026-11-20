# API Security and Deployment Guide

This is an operational checklist for the current API boundary, not a guarantee that every deployment concern is solved. Review the current CI and security issues before exposing Sofia to untrusted clients.

## Authentication and scopes

The host application configures `createSofiaApi(dependencies, config)` and supplies the static `apiKeys` map. Do not expose a public endpoint that can mint arbitrary keys.

- Send credentials as `Authorization: Bearer <key>` over HTTPS only.
- Generate unique, high-entropy keys per client. Never place server keys in browser bundles, mobile app binaries, source control, prompts, or logs.
- Use least-privilege scopes:
  - `agent:run`: submit runs/jobs, cancel runs, and read run/job status.
  - `agent:read`: read run/job status without granting run creation or cancellation.
  - `approval:read`: list pending approvals and read the authenticated owner's approval history.
  - `approval:decide`: approve or reject the authenticated owner's exact pending action hash.
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

## Approval journal

The API entrypoint configures a file-backed approval journal at `SOFIA_APPROVAL_JOURNAL_PATH`, defaulting to `$SOFIA_WORKSPACE/.sofia/approvals.json`. Keep this file on a private persistent filesystem and back it up according to your retention policy. The journal stores approval metadata and terminal state, not proposed tool inputs. Pending requests are marked `interrupted` on restart or graceful shutdown and are never restored as executable approvals. The file journal supports one writer process; do not share it between replicas. Grant `approval:read` and `approval:decide` only to clients allowed to review and decide their own actions.

### Transactional SQLite approval store (library integration stage)

The library exposes `SqliteApprovalStore` as a transactional metadata store (requires Node.js 22.5+ for the built-in `node:sqlite` module; the rest of the package retains its existing Node.js engine range). Multiple local processes can open the same SQLite database and use conditional state transitions so only one process can settle a pending approval. It stores owner, run, tool, action-hash, risk, timestamps, and status only; it never stores proposed tool input. `DurableApprovalBroker` now implements the same broker interface consumed by the API, so a custom host can inject it into `createSofiaApi` and use the same broker instance for agent dependencies. The standard entrypoint still uses the file-backed `ApprovalBroker` by default; no live deployment is switched automatically. SQLite WAL is intended for a local disk shared by processes on one host; it is not a safe general-purpose multi-host/network-filesystem coordination service. For multi-host deployments, use a transactional server database with equivalent compare-and-set semantics and worker leases.



### Durable approval decision handoff primitive

`SqliteApprovalStore.get(principalId, approvalId)` reads a single approval record scoped to its owner. Separate workers opening the same local SQLite database can therefore observe a committed terminal decision after another worker calls `settlePending`. The conditional update remains single-use: only one reviewer can win the pending-to-terminal transition. A future broker integration must keep the original worker as the sole executor, poll or subscribe for the terminal state, re-check owner/action hash/expiry, and decrypt the action using server-held key material before execution. This lookup alone is not a worker lease, notification mechanism, or complete distributed broker. `DurableApprovalBroker` composes the lookup with encrypted proposal reads and the origin worker's bounded polling loop; it supports same-host cross-process review/decision, not multi-host execution.

### Encrypted approval payload storage (library primitive)

The library also exposes `Aes256GcmApprovalPayloadCipher` and `SqliteApprovalPayloadStore`. Initialize `SqliteApprovalStore` first, then open the payload store against the same local database file. Pass the proposed action, server-derived context (approval ID, principal ID, run ID, tool name, action hash, and expiry), and a configured `ApprovalPayloadCipher` to `save`; the store encrypts before writing and persists only the AES-GCM envelope. `load` decrypts and returns the action only while that same owner/action context remains pending. Keep the stable 32-byte key held outside SQLite; never accept the cipher, decryption context, or keys from an API client. Envelopes are limited to 256 KiB. This primitive is composed by `DurableApprovalBroker` and can be injected into the API through `SofiaApiConfig.approvalBroker`; it does not implement distributed worker leases or make SQLite suitable for multi-host use. Keep key IDs stable, retain old keys only for the required decrypt/backup window, and test rotation and restore procedures before enabling it.

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

API keys are configured through a static key-to-scope map; automated key management and distributed quota storage remain deployment responsibilities until a dedicated implementation is merged. Approval behavior depends on the configured approval handler and tool gateway. The standard API entrypoint uses a file-backed owner-scoped approval journal; custom hosts must configure the same broker for the API and agent dependencies. Audit the exact composition used by your deployment rather than assuming every adapter has identical controls.


## Durable SQLite approval handoff

`DurableApprovalCoordinator` composes `SqliteApprovalStore`, `SqliteApprovalPayloadStore`, and a server-held `ApprovalPayloadCipher` for a same-host worker handoff. The originating worker creates the ticket and remains the only worker that should resume and execute the approved action. A reviewer can read the proposed input through the owner-scoped coordinator method, then settle the metadata row using the exact owner and action hash. The origin polls the committed state and receives the decrypted input only after an `approved` decision.

Creation serializes the proposal before writing, then `SqliteApprovalPayloadStore.createPendingWithPayload` inserts metadata and the encrypted envelope in one `BEGIN IMMEDIATE` transaction on the same SQLite connection. Any insertion failure rolls back both rows, so a crash cannot leave a visible pending approval without its payload. Callers must treat a null ticket as a failed creation and must never expose it for approval.

The coordinator uses bounded polling and a bounded approval TTL. An abort returns `interrupted`. A missing row, mismatched owner/context, unavailable payload, or failed authentication also fails closed. Do not pass tickets or server-held cipher instances to untrusted clients, and do not return encrypted envelopes or encryption keys from API routes.

This is still a local SQLite/WAL design for processes sharing one host filesystem. It is not a multi-host broker, worker lease, pub/sub notification system, or distributed execution guarantee. The existing API routes and `ApprovalBroker` are not yet replaced by this coordinator; integration requires a host-owned key provider, lifecycle/shutdown handling, and API-level authorization tests.


### DurableApprovalBroker integration

`DurableApprovalBroker` implements the existing `ApprovalBrokerPort` used by the HTTP approval routes. Construct it with a `SqliteApprovalStore`, a `SqliteApprovalPayloadStore` opened on the same database file, and a `DurableApprovalCoordinator` configured with a stable server-held cipher key. Use one broker instance for both `createSofiaApi(..., { approvalBroker })` and the agent dependency approval handler. A separate API/reviewer process may construct its own broker and SQLite connections using the same database and key; owner-scoped pending reads and compare-and-set decisions are shared, while the original worker remains responsible for resuming its own call.

The broker validates owner and exact action hash before settling a decision, scopes cancellation by owner and run, and removes the encrypted payload after the origin receives a terminal result. The encryption key is not stored in SQLite or returned by the API. The standard `src/api/entrypoint.ts` intentionally remains on the existing file-backed broker until deployment key provisioning, shutdown behavior, and end-to-end API tests are completed. The new broker is a library integration option, not an automatic production migration.

Before enabling it in a host, run the durable broker tests and the full project checks on Node.js 22.5+; verify the same stable 32-byte key is provisioned to every trusted same-host process. Do not share the SQLite file across hosts or arbitrary network filesystems.
