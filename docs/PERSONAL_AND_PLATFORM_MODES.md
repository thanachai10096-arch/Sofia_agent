# Personal Mode and Multi-user Platform Architecture

Status: additive product architecture decision. This document defines the boundary between the owner's first deployment and the later user-facing product. It does not claim that both modes are fully implemented or production-ready.

## Decision

Sofia will have **one Core and two operating profiles**:

1. **Personal Mode** — the owner's private Sofia deployment, built and validated first.
2. **Platform Mode** — the Hermes-like experience for independent users, built on the same Core after the personal workflow is reliable.

These are not two agents, two planners, or two tool runtimes. They are deployment and identity profiles around the existing Sofia API, Brain/Executor, model gateway, Tool Gateway, policy/approval path, job runtime, and channel adapters.

## Product boundary

| Concern | Personal Mode (first) | Platform Mode (later) |
| --- | --- | --- |
| Primary owner | One explicitly configured owner principal | Many independently authenticated principals |
| Main goal | Make the owner's Sofia useful end-to-end | Let each user install, self-host, or connect to a hosted Sofia |
| Setup | Owner-controlled environment and private setup | Hermes-like setup wizard with local or hosted choice |
| Model credentials | Owner's configured provider credentials, stored server-side/local securely | Each self-hosted user configures their own provider; a hosted service may offer an explicitly selected managed-provider option |
| Sofia API credentials | Private owner credential, never a model-provider credential | Per-user/revocable Sofia credentials or authenticated sessions |
| Memory and sessions | Scoped to the owner principal and private deployment | Strictly scoped to each user, and where needed each channel/conversation |
| Skills and tools | Owner-approved capabilities under existing policy | Per-user capabilities and approvals; no inherited owner privileges |
| Chat channels | Owner's allowlisted Telegram/Discord/etc. identities | Each user links and authorizes their own channel identities |
| Storage | Local persistent state or a private single-owner cloud store | Local per-user state for self-hosting; shared transactional stores for multi-user cloud |
| Operations | One trusted deployment/process initially | Multi-tenant isolation, shared durable jobs, quotas, rate limits, audit, backups and recovery |

## Non-negotiable invariants

- A single Sofia Core owns planning and execution. Channel adapters must not create another Brain, tool registry, or policy engine.
- Personal Mode is not a privileged template whose API keys, memory, channel tokens, files, skills, or permissions are copied into Platform Mode.
- Model-provider credentials and Sofia authentication credentials are different secrets with different purposes.
- A user may select only a provider/model route that their deployment has explicitly configured and authorized. Do not accept arbitrary client-supplied provider URLs or secrets in hosted mode.
- Every run, session, memory entry, schedule, artifact, approval, skill, and channel link must have an authenticated owner boundary. Channel sender IDs alone are not proof of identity.
- Retrieved memory and conversation history are untrusted reference context. They never grant tool access or override current policy.
- Tool permissions, approvals, workspace containment, network restrictions, secret redaction, and run ownership remain enforced by the existing Sofia policy path in both modes.
- No feature is marked connected or operational without a real verification result. Unit tests, a health endpoint, and a successful deployment build are separate evidence types.

## Shared Core and profile composition

The profile should configure existing services rather than fork them:

```text
Personal Mode ─┐
               ├─ authenticated Sofia API ─ existing Sofia Core
Platform Mode ─┘                         ├─ model gateway
                                         ├─ Brain / Executor
                                         ├─ Tool Gateway + Policy / approvals
                                         ├─ sessions + memory
                                         ├─ durable jobs + cron
                                         └─ channel adapters
```

A profile may choose different composition settings, storage adapters, authentication mechanisms, and available integrations. It must not replace the execution lifecycle or weaken policy.

## Delivery sequence

### Phase 1 — Personal Mode first

- Keep the existing local/single-process stores as supported local adapters.
- Configure one private owner identity and explicitly allowlisted channels.
- Configure the owner's model provider(s) through the existing model gateway.
- Verify ordinary chat, task execution, follow-up context, tool approvals, memory, scheduled work, cancellation, restart recovery, and final-result delivery.
- Keep credentials server-side and out of logs, transcripts, prompts, and repository files.
- Use a private persistent state directory. Do not treat ephemeral function storage as durable.
- Record exact commit, test, deployment, and live smoke-test evidence for each working capability.

### Phase 2 — prepare reusable user-facing setup

- Build the setup wizard as a thin adapter over existing configuration, model, storage, and integration services.
- Offer distinct choices for local/self-hosted use and connecting to a hosted Sofia API.
- For local use, let the user configure their own provider protocol, base URL, model ID, and API key using secure local storage.
- For hosted use, authenticate the user to Sofia; provider credentials remain on trusted servers and are never embedded in browser/mobile clients.
- Keep provider connection tests user-triggered because they may incur cost.
- Preserve existing CLI commands and environment-based configuration.

### Phase 3 — Platform Mode

- Add stable user/principal IDs and revocable API-key or session mappings; do not use a raw API key as a long-term identity.
- Move cloud sessions, memory, jobs, cron, idempotency, usage/quota, skill records, and message deduplication to shared transactional stores before multi-replica operation.
- Enforce owner scoping at every read/write/action boundary and test cross-user denial.
- Add per-user quotas, rate limits, cost visibility, retention controls, deletion/forget flows, backups, and audit events.
- Require explicit account linking and allowlists for each chat integration.
- Add multi-user concurrency and failure-recovery tests before describing hosted Platform Mode as ready.

## Data separation requirements

At minimum, persisted records need a stable owner/principal reference. Conversation- and channel-specific data also needs a scoped session/conversation key. Authorization must derive the principal from verified authentication, never from a user-controlled request field.

Before enabling shared cloud storage, define and test:
- unique constraints for owner-scoped IDs and provider event/idempotency keys;
- transaction boundaries for job acceptance, claims, quota reservations, and notification outbox records;
- encryption and secret-storage boundaries for provider credentials and integration tokens;
- retention, export, delete, and full-forget semantics;
- key rotation and revocation without accidental cross-account reassignment;
- recovery and backup/restore behavior.

Do not introduce a database migration or change existing store semantics as part of this architecture document.

## Readiness gates

**Personal Mode is ready for the owner's daily use only when** the exact deployed version passes the owner's real workflow: authenticated chat, a normal conversation and follow-up, a permitted tool action with approval where required, correct memory scope, a long-running job, cancellation or recovery, and delivery of the final result after reconnect/restart. Record any unsupported channels or tools as not ready.

**Platform Mode is ready for external users only when** the exact release candidate additionally passes:
- two or more independent users concurrently using the system without data or capability leakage;
- cross-user tests for runs, sessions, memory, files, schedules, skills, approvals, channel links, quotas, and deletion;
- provider credential isolation, key rotation, revocation, and safe error/log redaction;
- shared-store concurrency, restart recovery, idempotency, and durable notification tests;
- local install and clean setup tests on every claimed supported platform;
- real provider and real chat-channel smoke tests in a non-production environment;
- security review, complete CI, backup/restore validation, privacy/retention documentation, and an explicit production release decision.

Until these gates pass, describe the relevant profile as in development or preview rather than ready.

## Explicit non-goals

- No second Agent Runtime or parallel planner.
- No automatic copy of personal data or secrets into user accounts.
- No forced migration from local stores before a tested shared adapter exists.
- No production deployment, production-secret change, DNS cutover, destructive migration, or deletion of existing services as part of this work.
- No promise that every messaging app, provider protocol, or operating system is supported until its adapter and live tests exist.
