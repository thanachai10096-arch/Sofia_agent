# Sofia Autonomy Model

## Purpose

Sofia can reason, plan, reflect, learn from authorized information, create candidate
skills and run bounded experiments without asking approval at every cognitive step.
Autonomy is not authority: thinking about an action does not grant permission to
execute it. This is an AGI-oriented engineering direction, not a claim that Sofia
is AGI.

## Default autonomy profile

| Capability | Default | Boundary |
| --- | --- | --- |
| Independent thinking and planning | Autonomous | No external side effect |
| Read memory and local research | Autonomous | Memory remains untrusted reference data |
| Write learning notes | Autonomous | Principal/tenant scoped and auditable |
| Create skill candidates | Autonomous | Quarantined; cannot grant capabilities |
| Network research | Off | Requires profile opt-in and execution-policy host allowlist |
| Experiments and code edits | Sandbox only | Isolated workspace and resource budgets |
| Skill promotion | Evidence-gated | Tests, adversarial tests, benchmark >= 0.90, zero safety incidents, version and rollback |
| Production deploy and external actions | Human approval | Never enabled by an autonomy profile |
| Secrets, policy and destructive production changes | Human approval | Never enabled by an autonomy profile |

## Independent research and improvement loop

1. Observe task outcomes and authorized telemetry.
2. Identify knowledge gaps and formulate research questions.
3. Research locally; use network only when both policy layers allow it.
4. Generate hypotheses and measurable success criteria.
5. Create an isolated experiment workspace.
6. Run tests and adversarial evaluations within resource budgets.
7. Record evidence, failures and provenance.
8. Keep candidate skills quarantined until the promotion gate passes.
9. Promote only through the controlled registry with a rollback path.
10. Compare before/after benchmarks and repeat within the cycle budget.

## Two independent permission planes

- Cognitive autonomy governs thinking, planning, memory and candidate generation.
- Execution policy governs tools, filesystem, shell, network, browser, secrets and
  destructive operations. The existing security policy remains authoritative.

A request must pass both planes. This controller does not change ExecutionPolicy
and must not bypass tool-level checks, approval gates, the security kill switch,
principal isolation or audit requirements.

## Runtime budgets

Initial defaults: 8 autonomy cycles, 40 steps, 8 tool calls per step, 300 seconds
per experiment and USD 1 estimated spend per run. Operators may lower these
values. Raising budgets does not grant new tool capabilities.

## Non-goals

- No self-editing of security policy, credentials, approval rules or this controller.
- No automatic production deployment.
- No generated skill code outside the sandbox.
- No cross-user memory or workspace access.
- No assumption that a sandbox exists: absent verified isolation means deny.

## Integration note

This is a policy decision module. Runtime entry points must call it before
autonomous loops or sandbox operations and must still enforce ExecutionPolicy
at every tool invocation. Promotion eligibility is not itself a registry mutation;
the registry integration must preserve versioning, audit records and rollback.

## Durable research jobs

The autonomy job-store contract persists queued/running/terminal state, principal
ownership, idempotency keys, bounded retry attempts, worker leases and result or
failure metadata. The local `FileAutonomyJobStore` uses atomic file replacement
under `SOFIA_STATE_DIR`, restrictive directory/file modes and per-process
serialization. Expired worker leases can be recovered after a process restart;
retry attempts remain bounded and cancellation is terminal.

**Deployment constraint:** the file implementation is for one active process and
one worker claim domain. Atomic rename is not a distributed lock. Do not run
multiple Railway replicas against this store and assume exclusive claims. For
multi-replica production use, implement the same `AutonomyJobStore` contract
with transactional PostgreSQL/Redis claims, lease compare-and-swap, and tenant
scoping. Configure `SOFIA_STATE_DIR` to a persistent Railway Volume path;
ephemeral container storage does not survive replacement/redeploy.

The queue is a persistence primitive, not an autonomous scheduler. A trusted
host supervisor must explicitly enqueue work, claim jobs, resolve adapters from
trusted server configuration, pass authenticated principal identity and the
kill-switch signal into `SofiaAutonomyRuntime`, heartbeat leases, and persist
completion/failure. Never deserialize executable adapters or credentials from
job payloads. Job payloads are data only and must be validated by the host.

### PostgreSQL multi-worker backend

`PostgresAutonomyJobStore` implements the same job-store contract for shared
worker deployments. It uses a transactional claim query with
`FOR UPDATE SKIP LOCKED`, tenant-scoped reads and updates, lease ownership
checks, bounded attempts, idempotency uniqueness per principal, and expired
lease recovery. Call `ensureSchema()` during a controlled server startup or
managed migration; do not run schema DDL on every request.

Supply a trusted server-side PostgreSQL pool (for example, a Railway PostgreSQL
connection). The implementation intentionally accepts a small pool interface
and does not add a database driver dependency. Configure TLS and credentials
outside job payloads, use a least-privilege database role, and never expose the
pool to model-generated code. This adapter is now available but has not yet
been connected to Railway infrastructure or validated against a live database.

### Per-cycle checkpoints and replay-safe learning

Research workers persist a checkpoint after each completed cycle. The checkpoint
contains only bounded cycle evidence and the next cycle number; it is written
under the active worker lease and principal scope. After an expired lease is
recovered, the next worker resumes at the next uncompleted cycle rather than
replaying all prior completed cycles.

The research adapter receives a stable idempotency key in every
`recordLearning` call (`research:<principalId>:<cycle>`). Host memory adapters
must enforce uniqueness on that key (or map it to a deterministic memory-entry
ID) so a crash between memory persistence and checkpoint persistence cannot
create duplicate learning records. A cycle interrupted before its learning
write may be recomputed; experiments must themselves be idempotent or use
versioned, isolated artifacts before retrying. Checkpoints do not make an
in-flight external side effect exactly-once.
