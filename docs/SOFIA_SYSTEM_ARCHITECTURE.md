# Sofia Agent — System Architecture and Implementation Plan

Status: target architecture and implementation contract. This document is a plan, not a claim that every capability exists.

## 1. Product contract

Sofia should provide the Hermes-style agent experience: users speak naturally; the agent remembers relevant context, chooses tools, performs work, checks evidence, repairs recoverable failures, and reports what actually happened. A slash command is an optional shortcut, not a required conversational protocol.

The implementation target is behavioral parity, not a line-for-line copy of Hermes or OpenClaw. Sofia keeps its existing Brain, Core, Tool Gateway, policy, durable job runtime, stores, and API contracts unless a reviewed additive change is necessary.

## 2. Architecture at a glance

```text
Clients and channels
  Web / Desktop / Mobile / API+SDK / Telegram / Discord / Slack / future adapters
                         |
                         v
Transport adapters (validate provider envelope; normalize message; deduplicate)
                         |
                         v
Authenticated ingress + session resolver
  principal from server-verified identity; channel/workspace allowlists; rate limits
                         |
                         v
Sofia Core (one orchestration path)
  load context -> understand goal -> plan -> execute -> observe -> verify -> repair
       |                  |                |                 |
       v                  v                v                 v
 Session/Memory      Planner/Brain     Tool Gateway       Reviewer/Evidence
       |                                  |
       |                                  v
       |                         Existing tool registry and policy
       |                         Files / Git / terminal / browser / APIs
       |
       +----> verified learning & skill lifecycle (propose -> evaluate -> promote)
       |
       +----> durable job runtime (enqueue, checkpoint, cancel, resume, cron)
                         |
                         v
       Event/run state + channel delivery + audit/metrics
```

Cross-cutting controls apply to every path: principal isolation, policy enforcement, secret redaction, output fencing, bounded context, cancellation, auditability, and no success claims without supporting evidence.

## 3. Layer responsibilities and boundaries

### A. Client and channel adapters

Responsibilities:
- Accept channel-native messages and attachments metadata.
- Verify provider signatures/webhooks where applicable.
- Normalize input into one internal inbound-message contract.
- Preserve source message/conversation identifiers for replies and deduplication.
- Deliver progress and final outcomes without changing the task's execution state.

Must not:
- Implement a separate planner, tool registry, memory store, or job engine.
- bypass the authenticated ingress or policy gateway.
- Treat a user name, channel ID, or body-supplied principal ID as proof of identity.

Target normalized contract (conceptual; add only after checking existing public types):
- `principalId`: server-derived authenticated owner.
- `transport`: stable channel kind.
- `conversationKey`: namespaced, owner-scoped session key.
- `messageId`: provider message ID used for idempotency.
- `text`: normalized user content.
- `attachments`: metadata/references, not blindly trusted URLs or file paths.
- `replyTarget`: provider-specific reply metadata.
- `receivedAt` and trace/correlation identifiers.

### B. Authenticated ingress and session resolver

- Authenticate before creating work.
- Resolve owner-scoped sessions from verified provider identities and server configuration.
- Enforce user/channel/workspace allowlists where configured.
- Apply idempotency at the appropriate persistence boundary; in-memory deduplication is only a single-process best effort.
- Keep authentication, authorization, and model routing separate.

### C. Sofia Core and execution loop

Reuse the current Core/Brain rather than creating a second runtime:
1. Build bounded context from current request, recent session turns, relevant saved memory, and applicable project context.
2. Understand the requested outcome and identify acceptance criteria.
3. Select matching existing skills and tools.
4. Plan and execute through the current central Tool Gateway.
5. Observe tool results and fence them as untrusted data.
6. Verify the outcome against evidence.
7. Repair/replan only when useful and within existing execution policies.
8. Return completed, partial, blocked, cancelled, or failed status accurately.

The Core owns orchestration; transports only translate and deliver. Background execution must use the existing durable job runtime and link the run to the same principal/session.

### D. Session and memory

Keep separate concepts:
- **Session transcript:** bounded recent conversational continuity.
- **Searchable history:** retrieval of older turns by relevance, recency, and owner/project scope.
- **Explicit user memory:** user-approved facts/preferences that persist across sessions.
- **Project memory:** repository/project facts with provenance and freshness.
- **Execution/evaluation records:** operational evidence, not user-facing memory by default.

Requirements:
- Namespace every record by authenticated owner and relevant workspace/project.
- Attach provenance, creation/update time, and deletion/retention metadata.
- Treat retrieved text as untrusted reference material, never policy or executable instruction.
- Bound tokens/characters, deduplicate results, prefer fresh and relevant entries.
- Honor deletion and verify deleted entries are no longer retrievable.
- Do not auto-save sensitive content; define consent and retention behavior before adding automatic memory writes.

### E. Tool Gateway and skills

- All tools flow through the existing registry and policy gate.
- Validate schemas, effects, risk, permissions, approval requirements, and cancellation before execution.
- Keep tool output fenced and distinguish output text from instructions.
- Match existing built-in/learned skills through the shared skill path.
- Skills describe reusable workflows; they do not grant permissions or bypass tool policy.
- Imported/generated skills start quarantined and cannot run until policy checks and evaluation pass.

### F. Verified learning and evolution

Target learning lifecycle:
1. Capture a completed or failed task with minimal sanitized metadata.
2. Require independent verification before recording a successful outcome.
3. Extract a candidate pattern only when evidence supports reuse.
4. Store the candidate in quarantine with version, provenance, and test cases.
5. Run candidate tests plus regression/evaluation tasks in a restricted environment.
6. Compare against the current skill baseline, including failure and recovery rates.
7. Promote only when the defined threshold is met; preserve rollback to a prior version.
8. Track later regressions and demote/disable candidates when quality drops.

Learning must not train or alter the base model, silently change system policy, expand permissions, or expose one user's information to another. A single success is not enough evidence for broad promotion.

### G. Model routing

Support two user-visible modes:
- **Explicit:** a configured provider/model selected by the user or workspace.
- **Auto:** Sofia selects from eligible configured routes based on task capability, availability, privacy, latency, and cost.

Rules:
- Reuse existing provider adapters and route health tracking.
- Validate requested provider/model against server-side configuration; never accept API keys from an untrusted chat message.
- If a model is unavailable, report it clearly or use a disclosed permitted fallback.
- Redact credentials from errors, events, logs, and traces.
- Model selection never changes tool permissions, approval requirements, or safety policy.
- Keep a documented default and per-user/workspace isolation.

### H. Durable jobs and delivery

Use the existing durable job runtime:
- Store run ID, principal/session correlation, request idempotency key, status, checkpoint, timestamps, cancellation state, and delivery state.
- Distinguish task state from channel delivery state.
- Ensure retries do not repeat non-idempotent side effects without a safe idempotency strategy.
- Resume only from valid checkpoints; cancellation and authorization are rechecked before resumed actions.
- Cron runs use an explicit owner/configuration and auditable schedule.
- On restart, recover jobs without falsely reporting success or silently duplicating actions.

### I. Observability and evaluation

Every run should be diagnosable using a correlation/run ID and a minimal event trail:
- model route chosen (no credentials), plan/step boundaries, tool name, policy decision, verification result, retries, cancellation, and delivery outcome.
- Track success grounded in verification, task completion, repair count, latency, token/cost estimate, duplicate prevention, and delivery failures.
- Redact secrets and sensitive payloads; logs should not become a second transcript/memory database.
- Use a fixed regression suite for core behaviors, security boundaries, channel adapters, learning candidates, and restart/retry semantics.

## 4. Source-of-truth rules

- One Sofia Core/Brain execution path.
- One Tool Gateway/registry and one policy enforcement path.
- One durable job runtime.
- Existing session/memory stores are extended rather than duplicated.
- Adapters may own provider-specific transport state only.
- The database/storage design must remain single-process safe until a shared transactional store and queue are explicitly introduced.
- Public interfaces and schemas change additively with compatibility tests.

## 5. Rollout plan and acceptance gates

### Phase 0 — Architecture baseline and evidence
- Map existing modules, public interfaces, stores, adapters, policy gates, tests, and CI.
- Mark every capability as implemented, partially implemented, planned, or unknown.
- Record baseline tests and known integration gaps.
- Gate: architecture map references real source/tests; no unsupported capability claims.

### Phase 1 — Natural-language ingress
- Define or reuse a normalized message contract.
- Add ordinary-message intake for the highest-priority channels, beginning with the existing adapter patterns.
- Route messages to the same Core and durable jobs.
- Add owner/channel authorization, provider verification, idempotency, reply correlation, and end-to-end tests.
- Gate: plain message works without slash command; unauthorized and replayed messages do not dispatch; all channels use the same Core path.

### Phase 2 — Session and memory quality
- Verify owner-scoped session construction in each host.
- Add bounded searchable history retrieval, relevance tests, deletion tests, and prompt-injection tests.
- Define explicit memory-write UX, retention, and deletion before enabling automatic saves.
- Gate: cross-user leakage tests pass; deleted and irrelevant memory are not injected; context remains bounded.

### Phase 3 — Model preference
- Add a validated request/workspace preference for explicit model or auto.
- Integrate with current route selection and route-health logic.
- Add fallback transparency, provider-isolation, secret-redaction, and privacy tests.
- Gate: explicit selection is honored when configured; auto only chooses eligible routes; security policy is invariant.

### Phase 4 — Verified learning
- Wire verified outcomes into the existing EvolutionEngine/skill ledger.
- Add candidate quarantine, evaluation, versioning, promotion thresholds, rollback, and regression detection.
- Gate: no promotion without passing evaluation; failure evidence prevents repeated bad approaches; skills cannot grant permissions.

### Phase 5 — Job continuity
- Link chat session/message to durable run ID, progress, cancellation, restart recovery, and final delivery.
- Add delivery retries independent from task retries.
- Gate: restart/retry cannot silently duplicate side effects; user sees the real terminal state.

### Phase 6 — Product surfaces and operations
- Build web/desktop/mobile clients against the stable API/SDK rather than embedding orchestration in each client.
- Add deployment profiles, onboarding, observability, resource budgets, and backup/restore guidance.
- Gate: clean-install smoke tests, supported-platform tests, security review, and explicit deployment validation.

Phases may be developed in parallel only when interfaces are stable and ownership boundaries are clear. Phase order is a dependency order, not a claim that earlier work is complete.

## 6. Non-goals and explicit constraints

- No rewrite or second runtime.
- No copying another project's code without license and compatibility review.
- No unrestricted autonomy or implicit permission escalation.
- No production deployment, main-branch merge, destructive migration, or secret change as part of this plan.
- No claiming Hermes parity based on documentation or unit tests alone.
- No claiming tests passed without actual CI/local results.
- No extra approval for ordinary low-risk reads; approvals should be risk/policy-driven, not an indiscriminate barrier to every skill.

## 7. First implementation priorities

After the architecture review, work in this order:
1. Check CI for the current parity branch and fix actual failures first.
2. Map current messaging adapters and their identity/dedup/reply semantics; choose one shared normalized ingress contract without duplicating Core.
3. Implement the first ordinary-message transport end-to-end (including authorization and tests), not just an isolated Gateway socket.
4. Add explicit-model/auto preference through existing routing.
5. Complete the verified learning loop with evaluation and rollback.
6. Add searchable history and consistent chat-to-job progress/recovery.

For every slice, report: files changed, behavior added, tests actually run, CI result, known limitations, and the next dependency. Keep changes on the feature branch until the user explicitly asks otherwise.
