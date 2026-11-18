# Multi-Tenant Isolation Architecture (RFC)

Status: partially implemented foundations; **not production-ready multi-tenant isolation**. The current API must not be marketed or exposed as an isolated multi-tenant workspace service.

## 1. Current boundary

The API derives an opaque principal ID from each bearer API key and scopes API run/job records, user memory, cron schedules, usage counters, and session IDs to that principal in their respective code paths. The single-key API entrypoint now stores transcripts in a separate SQLite database named by the server-derived owner ID and migrates that owner’s legacy transcripts on startup. This is useful defense in depth, but it is not complete tenant isolation.

The current process constructs a single `AgentDependencies` instance from one operator-configured `SOFIA_WORKSPACE`. Brain runs currently share workspace-backed project memory, run snapshots, skill lifecycle/ledger, evolution state, local runtime, and desktop workspace root. Some of these stores are created inside the Brain factory but rooted at the same workspace. A principal ID passed to the Agent does not automatically partition those resources.

Client-supplied workspace paths are rejected by the API validation guard. Do not work around this by accepting arbitrary paths or by deriving paths directly from request body fields.

## 1.1 Verified implementation inventory (repository audit)

The following observations were verified against the current `main` implementation during this audit. They describe the present code, not the target architecture.

| Component | Current implementation | Isolation consequence |
|---|---|---|
| API authentication | `src/api/server.ts` hashes the bearer token into `keyId` and attaches configured scopes | Distinct API keys receive distinct opaque principals; this does not itself partition runtime resources |
| API transcripts | `createSofiaAgentDependenciesWithOwnerSessions` opens `.sofia/sessions/<keyId>.sqlite` for the single-key API entrypoint and migrates only `<keyId>:` records from the legacy shared SQLite database | Physical per-owner database files for the entrypoint; direct multi-key `createSofiaApi` hosts must still inject a correctly routed per-owner session store |
| User memory | `FileUserMemoryStore` receives `auth.keyId` for API CRUD and hashes the user ID for its filename | API user-memory files are principal-scoped; this does not isolate project memory |
| Project memory | `createBrainFactory` constructs one `FileProjectMemoryStore(workspace)`; store hashes only the project namespace | Runs using the same workspace share project memory and the persistent skill ledger |
| Brain run snapshots | One `FileRunStore(workspace)` is captured by the Brain factory | Brain snapshots are namespaced by workspace, not by authenticated principal |
| Checkpoints | One `DurableCheckpointManager(runtime, workspace)` is captured by the Brain factory | Checkpoint metadata is workspace-namespaced, while rollback acts on the same shared runtime |
| Evolution | One `EvolutionEngine(workspace/.sofia/evolution.json)` is constructed by dependency factory | Skill/task performance history is shared across principals using this process |
| Skill lifecycle | One lifecycle file at `workspace/.sofia/skill-lifecycle.json` is captured by the Brain factory | Learned/approved skill lifecycle state is shared |
| Workspace runtime | One `createNodeWorkspaceRuntime(workspace)` is injected into every Brain run | File reads/writes, shell and Git operate against the same configured root |
| Desktop tools | Per-run tools are created with the same `workspace` root | Per-run tool objects do not provide per-tenant filesystem isolation |
| API durable jobs | `DurableJobRuntime` is constructed once with a workspace-scoped run store | Job ownership checks exist, but the job execution factory still targets the shared workspace |

**Important distinction:** creating per-principal copies of memory, snapshots, or checkpoint metadata would not make the filesystem safe to share. Checkpoint rollback, shell execution, Git, repository indexing, project context discovery, and generated artifacts all act on the runtime root. The runtime/workspace boundary must be isolated before user-controlled code execution is offered to multiple tenants.

### Tenant workspace allocator (foundation added; not yet wired)

The branch now contains `src/platform/tenant-workspace.ts` with `createTenantWorkspace(root, principalId)`. It:
- requires an absolute operator-configured root and a non-empty authenticated principal ID;
- hashes the principal ID with SHA-256 so raw IDs/tokens are not embedded in filesystem paths;
- creates a deterministic `tenants/<hash>/workspace` directory with restrictive directory permissions;
- rejects symlink redirection at the tenant directory, tenant root, and workspace directory.

Regression coverage is in `src/platform/tenant-workspace.test.ts` for deterministic separation, invalid inputs, and symlink escapes.

**This is only an allocation primitive.** It is intentionally not connected to `createBrainFactory` yet: the current Brain factory, durable job runtime, API run store, shared tool registry, checkpoint manager, evolution engine, and background jobs still capture process-wide dependencies. Wiring only the workspace path would leave other stores and lifecycle operations cross-tenant. The next implementation step must introduce a per-principal dependency bundle and ensure queued jobs retain an immutable tenant identity through execution and recovery.

### Safe interim operating mode

Until a tenant-aware runtime factory and tenant-owned workspace roots exist:
- treat the API deployment as a single trusted workspace/operator, even when API keys have separate run and user-memory records;
- do not grant desktop workspace or process-execution scopes to untrusted principals;
- keep Discord/Telegram identities allowlisted as trusted operators, not as independent workspace tenants;
- do not enable public self-service signup, arbitrary project import, or shared-workspace execution;
- retain the workspace override rejection and clearly disclose the single-workspace limitation.

## 2. Security invariants

1. **Server-derived tenant identity:** tenant/principal identity comes only from authenticated server-side credentials and membership records. Never trust `tenantId`, `ownerId`, `workspace`, storage keys, or capability claims supplied by a client.
2. **Default deny:** every read, write, list, delete, resume, cancel, schedule, tool call, and artifact lookup must be authorized against the authenticated tenant and resource owner.
3. **Filesystem confinement:** resolve a tenant root on the server. Canonicalize paths, reject traversal, and verify real paths remain beneath the tenant root after symlink resolution. Never expose the host root or another tenant's directory to a tool.
4. **Independent mutable state:** project memory, checkpoints, run snapshots, skill state, evolution state, browser profiles, desktop state, and generated artifacts must be tenant-scoped.
5. **No ambient secrets:** provider credentials and service credentials remain server-managed. Tenant-scoped credentials, if supported, are encrypted and selected only after authorization. Never inject another tenant's secrets into a run.
6. **Fenced execution:** queued jobs, approvals, leases, callbacks, and notifications carry immutable tenant and principal identifiers. Re-check ownership at execution time, not only when enqueuing.
7. **Shared infrastructure is not shared authorization:** database/object-store rows and keys include tenant ownership and enforce it in the data-access layer. Random IDs are not authorization.
8. **Cluster-safe accounting:** quotas, idempotency, concurrency reservations, and billing events require atomic shared storage before horizontal scaling.

## 3. Target request flow

```text
Client credential
  -> Authentication (API key / OAuth identity)
  -> Resolve principal + tenant membership (server-side)
  -> Authorize scope and tenant status
  -> TenantContext (immutable, request-scoped)
  -> TenantResourceResolver
       -> workspace root
       -> project/session store
       -> memory and project knowledge
       -> run/checkpoint/job store
       -> browser profile and desktop sandbox
       -> secrets and usage ledger
  -> Brain / tools / subagents receive the same TenantContext
  -> audit event records tenant + principal + resource + decision
```

A tenant context should be an opaque, immutable server-created value. Do not let callers construct it from arbitrary strings. Child agents inherit a constrained context from the parent; they cannot change tenant, principal, workspace root, or capabilities.

## 4. Resource partitioning

| Resource | Required partition |
|---|---|
| Workspace and artifacts | Per-tenant root; per-project subdirectories; confined sandbox mount |
| Project memory / repository map | Per tenant and project |
| User memory | Per principal, with explicit tenant sharing rules |
| Run snapshots / checkpoints | Tenant + run ID; owner checks on every operation |
| Jobs / leases / resume | Tenant + owner; tenant checked again on claim and resume |
| Sessions / transcripts | Tenant + principal + session ID |
| Skills / evolution | Tenant-owned namespace; shared global skills read-only and reviewed |
| Browser profiles / cookies | Per principal or tenant policy; never process-global |
| Desktop access | Per-tenant sandbox and explicit device binding; disabled until isolation exists |
| API/provider secrets | Encrypted tenant-scoped secret records; never plain environment inheritance |
| Cron schedules | Tenant + owner; execution re-authorizes tenant status and quotas |
| Audit / usage / billing | Append-only tenant-attributed records with restricted admin access |

## 5. Workspace layout

Use a server-owned root, for example:

```text
SOFIA_TENANTS_ROOT/
  <opaque-tenant-id>/
    projects/<opaque-project-id>/
    users/<opaque-principal-id>/
    memory/
    runs/
    checkpoints/
    browser-profiles/
    artifacts/
    audit/
```

Opaque IDs must be generated or resolved server-side. Do not use user names, email addresses, organization names, or raw API keys as path components. Create directories with restrictive permissions. For untrusted code execution, use a digest-pinned container with a read-only root filesystem and only the selected project directory mounted writable. Network access remains denied unless an explicit policy grants audited egress.

## 6. Migration plan

### Phase A — Safe single-tenant boundary (current)
- Reject request-selected workspace paths.
- Document that one API process is one trusted workspace/operator boundary.
- Keep public multi-user onboarding disabled until later phases pass.
- Keep desktop/process execution unavailable to untrusted tenant credentials.

### Phase B — Tenant identity and resource resolver
- Add a tenant registry and membership model (tenant ID, principal ID, roles, status).
- Resolve tenant context from verified credentials and membership on every request.
- Add a single server-side resource resolver; eliminate direct use of global workspace paths from request handlers.
- Make the resolver return tenant-scoped stores and sandbox configuration.

### Phase C — Storage isolation
- Add tenant IDs to run/job/cron/session/artifact/usage/audit records.
- Enforce composite ownership constraints in database queries and unique indexes.
- Move project memory, snapshots, skills, and evolution to tenant-scoped stores.
- Use transactional shared storage for jobs, leases, quotas, idempotency, and billing before multi-replica operation.

### Phase D — Execution isolation
- Create a per-tenant/per-project runtime or a short-lived isolated worker.
- Bind the sandbox mount to the authorized project root only.
- Propagate immutable tenant context to Brain, tools, subagents, approvals, and callbacks.
- Keep desktop and persistent browser login disabled until device/profile isolation and revocation are verified.

### Phase E — Billing, admin, and launch
- Attribute model tokens, tool calls, storage, and compute to tenant and principal.
- Add plan limits, hard budget enforcement, abuse controls, suspension, export, and deletion workflows.
- Provide tenant admin/member roles and audit export without cross-tenant access.
- Complete penetration tests and restore tests before enabling self-service onboarding.

## 7. Required adversarial tests

- Tenant A cannot list, read, modify, delete, resume, cancel, or infer Tenant B resources by ID.
- Tenant A cannot access Tenant B files through `../`, absolute paths, symlinks, archive extraction, git worktrees, or tool arguments.
- A child agent cannot change tenant context or return a proposal that executes under another principal.
- A queued job cannot execute after tenant suspension, membership revocation, or project permission removal.
- A stale worker cannot commit artifacts after its lease/fencing token is superseded.
- Session IDs, browser cookies, desktop sessions, project memory, skills, and artifacts never cross tenant boundaries.
- Quotas and billing remain correct under concurrent requests, retries, duplicate idempotency keys, restarts, and multiple replicas.
- Backups, logs, audit exports, support tooling, and deletion jobs preserve tenant boundaries.

## 8. Release gates

Do not enable self-service multi-tenant access until:
- every resource listed in Section 4 is tenant-partitioned;
- every API and background execution path carries and enforces immutable tenant context;
- filesystem and sandbox confinement tests pass on supported operating systems;
- shared-store concurrency and restart tests pass;
- CI is demonstrably executing tests on real runners;
- a security review confirms no cross-tenant read/write path remains.

A green typecheck or unit suite alone is not sufficient evidence of tenant isolation.
