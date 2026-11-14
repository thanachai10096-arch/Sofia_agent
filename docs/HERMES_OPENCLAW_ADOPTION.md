# Hermes + OpenClaw adoption plan for Sofia Agent

**Status:** architecture plan on an isolated feature branch. This document does not claim that the proposed integrations are implemented or production-validated.

**Upstream references**
- Hermes Agent: https://github.com/NousResearch/hermes-agent
- Hermes architecture: https://hermes-agent.nousresearch.com/docs/developer-guide/architecture
- OpenClaw: https://github.com/openclaw/openclaw
- OpenClaw architecture: https://docs.openclaw.ai/architecture (verify current upstream URL before implementation)

## Decision

Adopt selected design patterns and compatible interfaces from both projects. Do not vendor either complete runtime, replace Sofia Brain, or allow an upstream adapter to bypass Sofia's Tool Gateway, policy, approvals, durable job ownership, verification, or audit trail.

Sofia remains the authoritative execution runtime. External projects are references and, where useful, protocol/skill-format compatibility targets.

## What to learn from each project

### Hermes Agent — learning, context and agent quality

1. **Closed learning loop:** capture task outcome, independently verified evidence, failure category, and skill version; propose reusable skills only after successful verified work. Keep generated candidates quarantined until reviewed and evaluated.
2. **Portable skills:** support the Agent Skills open format with progressive disclosure (metadata first, full instructions on demand). Sofia's skill registry remains authoritative for capability declarations and policy.
3. **Context lifecycle:** compose stable instructions, trusted runtime configuration, scoped memory, skills, recent turns, and evidence as distinct provenance-labelled sections. Compress older context with a bounded summarizer while preserving goals, acceptance criteria, decisions, and tool evidence.
4. **Session recall:** add searchable conversation history and session lineage. Retrieval returns untrusted context only; it never grants permissions.
5. **Provider runtime consistency:** use one resolver for provider protocol, model, endpoint, credential source, limits, and normalized errors across API, messaging, scheduler, and CLI. Preserve Sofia's configured-route allowlist and never accept provider URLs or keys from clients.
6. **Specialist delegation:** improve bounded subagents with isolated context, explicit task contracts, per-child tool allowlists/budgets, cancellation, and parent verification.

### OpenClaw — gateway, channels, plugins and device connectivity

1. **Gateway as control plane:** make the existing Sofia API + messaging gateway the single authority for sessions, channel connections, events, tool policy, and run status. Do not create a second agent loop.
2. **Normalized channel events:** normalize Telegram/Discord and future adapters into a common event contract (platform, tenant/principal, conversation, message ID, timestamp, text/attachments metadata, reply target). Authenticate the provider and authorize the sender before dispatch.
3. **Pairing and identity:** add an explicit pending/approved/revoked pairing lifecycle for unknown DMs, with per-user and per-conversation scopes. Keep existing allowlists as the immediate safe default.
4. **Plugin contracts:** define versioned plugin manifests for channel adapters, tool providers, model providers, and event hooks. Plugins register capabilities but cannot self-authorize; all tool calls still pass the central registry and policy.
5. **Device nodes:** treat desktop/mobile/browser/device actions as separately paired nodes with narrow, expiring capability grants. A cloud process must not imply it has access to a user's local device.
6. **Multi-agent coordination:** use bounded task messages and explicit ownership; do not treat child-agent output as trusted. Parent Brain independently verifies results before side effects or completion.
7. **Operational control:** expose health, connection state, queue lag, active runs, and redacted audit events. Channel reconnect and graceful shutdown must be deterministic.

## Mapping to Sofia's current seams

| Upstream pattern | Sofia integration point | Required invariant |
| --- | --- | --- |
| Hermes agent loop / context assembly | `src/brain/*` and existing Brain executor | Preserve one Brain lifecycle and strict output validation |
| Hermes provider resolver | existing model gateway/router | Client selects only configured route IDs; no silent fallback for explicit route |
| Hermes skills and learning | `src/skills/*`, skill lifecycle and project memory | Verified evidence before promotion; skill cannot grant authority |
| Hermes session search | existing session/transcript stores | User/platform isolation, bounded retrieval, provenance |
| Hermes subagents | bounded subagent coordinator | Least-privilege child tools, separate budgets, parent verification |
| OpenClaw Gateway | existing API and `src/integrations/messaging/*` | One dispatch path; no second runtime |
| OpenClaw channels/pairing | Telegram/Discord adapters and access policy | Authenticate, authorize, deduplicate, rate-limit before dispatch |
| OpenClaw plugins/tools | existing tool registry and capability contracts | Plugins register; central policy authorizes every invocation |
| OpenClaw nodes | existing desktop/local runtime | Explicit pairing, scoped grants, revocation, local consent |
| OpenClaw automation | existing durable jobs / cron scheduler | Atomic claim, lease, idempotency, cancellation and recovery |

## Implementation sequence

### P0 — reliability and safety before new surface area

- Resolve Telegram `poll_conflict` with an explicit single-poller ownership strategy (or move to a webhook transport); never let two replicas poll the same bot token.
- Make gateway startup/shutdown observable and deterministic; expose connection health and last successful poll/delivery timestamps.
- Recheck authorization at dispatch and at every tool execution; retain deduplication and rate limits.
- Add a shared transactional job/lease/deduplication backend before enabling multiple active workers. Current file-backed state is single-process only.
- Add adversarial tests for forged events, duplicate delivery, reconnect races, revoked users, cross-user session access, and plugin tool privilege escalation.

### P1 — Hermes learning/context capabilities

- Introduce a versioned skill manifest and Agent Skills-compatible reader with metadata-only discovery and on-demand instruction loading.
- Add a context assembler with provenance tags and a strict token/character budget; summarize only with retained task intent and evidence references.
- Add session full-text search and lineage using the existing persistence abstraction; choose the storage implementation only after concurrency and retention requirements are specified.
- Add an evidence-backed skill candidate lifecycle: draft → evaluate → approve → active → rollback/deprecate.
- Integrate bounded multi-agent planning only after contracts, budgets, cancellation, and parent verification are covered.

### P1 — OpenClaw gateway/plugin capabilities

- Define a normalized channel event schema and conformance tests for Telegram and Discord.
- Add optional DM pairing as a controlled extension of current allowlists; do not auto-approve unknown senders.
- Define plugin manifests, version compatibility, declared capabilities, and lifecycle hooks. Plugin code is untrusted and must run with least privilege.
- Add device-node registration, pairing, scoped grants, revocation, and an explicit local consent flow before exposing more desktop/mobile operations.

### P2 — usability and scale

- Add operator status for connected channels, active jobs, queued jobs, leases, failed deliveries, and audit traces.
- Add multi-host deployment only after transactional storage, worker claims, shared rate limiting, and cross-worker idempotency are validated.
- Add protocol adapters (for example ACP/MCP where justified) as clients of Sofia's stable execution contract, never as alternate policy paths.

## Explicit exclusions

- Do not replace `src/brain` or the Sofia state machine with Hermes or OpenClaw.
- Do not install either project as a nested runtime or copy large upstream modules without a focused compatibility/security review.
- Do not adopt host-level unrestricted shell execution, implicit local-device access, or permissive public gateway defaults.
- Do not enable a second Telegram poller or deploy multi-replica file-backed workers.
- Do not claim self-learning means model-weight training. Sofia learns reusable, evidence-backed workflow/skill records.
- Do not claim a capability is complete based on documentation alone.

## Validation gates

Every implementation slice must include:
- typecheck, full unit tests, build, and license checks;
- tests proving forbidden actions did not happen (not merely that an error was returned);
- per-platform live smoke tests for real channel behavior;
- exact commit SHA and CI evidence;
- staging validation before Production rollout;
- rollback path and compatibility check for persisted state.

Benchmark Sofia before and after changes using the same versioned tasks, models, budgets, tools, and environment. Report independently checked success, regression/unsafe-action rate, recovery rate, latency, cost per successful task, and human interventions. Do not claim superiority over Hermes or OpenClaw without reproducible results.


## Incremental implementation update — Telegram single-poller guard

A first implementation slice has been added on the feature branch:

- `RedisTelegramPollLease` uses Redis `SET NX PX` to elect one poller for a bot identity.
- Renewal and release use Lua compare-and-act scripts, so a stale process cannot extend or delete a successor's lease.
- Telegram HTTP transport accepts an optional lease. When configured, it refuses to call `deleteWebhook` or `getUpdates` without acquiring the lease, renews while polling, aborts if ownership is lost, and releases on shutdown/loop exit.
- `createTelegramMessagingRuntime` accepts an optional injected `pollLease` dependency.

**Important rollout limitation:** the standalone Railway entrypoint does not yet construct and inject a Redis client/lease. Therefore this feature is opt-in at the transport/runtime composition seam and does not by itself protect the currently deployed Railway service. Do not claim the live Telegram poll conflict is fixed until the Railway composition root injects a shared Redis lease and a two-instance staging test proves exclusivity and failover.

Added deterministic tests cover Redis lease ownership, renewal/release, refusing to poll without a lease, and releasing the lease on shutdown. These tests have been authored but are not yet CI-verified on this branch.

Next implementation slice:
1. Wire a shared Redis client into the Railway composition root using server-only credentials.
2. Inject `RedisTelegramPollLease` into the Telegram runtime.
3. Configure Redis availability as a startup requirement only when Telegram polling is enabled; if Redis is unavailable, fail closed by leaving Telegram disabled.
4. Add two-process integration coverage: one owner polls, a second cannot; after owner termination/TTL expiry, the second acquires and resumes.
5. Run full CI and a real Telegram staging smoke test before enabling in Production.
