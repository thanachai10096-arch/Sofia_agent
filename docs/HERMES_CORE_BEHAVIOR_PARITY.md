# Hermes-Style Core Behavior Parity

Status: implementation contract and gap register. This document does not claim that the listed behaviors are already implemented.

## Goal

Sofia should follow the same user-facing agent operating model as Hermes Agent: natural-language requests enter one persistent agent loop; relevant context is retrieved; the agent chooses and uses tools; results are checked; recoverable failures lead to repair; and verified experience can improve future task execution. Sofia may retain its own implementation, APIs, and security architecture. The target is behavioral parity, not a blind copy of another codebase.

## Non-negotiable behavior

1. **Natural language is the default interface.** A user can ask for work in an ordinary message. A slash command may be offered as an optional shortcut, but must not be the only way to initiate work in a chat channel that supports ordinary messages.
2. **One core, many transports.** Web, desktop, mobile, API/SDK, Telegram, Discord, and future adapters normalize input and call the same authorized Sofia Core. Transport-specific code must not implement a second planner or bypass the Tool Gateway.
3. **Session continuity.** Each authenticated user has isolated sessions. Relevant recent turns are available to the next turn in that session; the system can retrieve older relevant turns without injecting an unbounded transcript. Session identity and ownership are derived from authenticated context, not trusted client-supplied owner IDs.
4. **Useful long-term memory.** Retrieve relevant, fresh, provenance-bearing user/project memories before planning. Separate memory from system policy and instructions; treat retrieved content as untrusted reference data. Respect retention, deletion, and scope boundaries.
5. **Tool-using execution loop.** Understand the goal and acceptance criteria, plan, execute through the central registry, observe evidence, verify, and repair/replan when useful. Never report success without evidence that supports the requested outcome.
6. **Reusable skills and learning loop.** Match applicable skills before execution. Record outcomes only after independent verification; retain sanitized failure lessons; rank using multiple observations; propose or create reusable skill improvements from repeated patterns. Generated/external skills remain quarantined until policy-compliant review/installation. Learning cannot grant permissions or change policy.
7. **Background work and recovery.** Long-running tasks have durable status, cancellation, checkpoints where supported, restart recovery, and duplicate-side-effect protection. Chat replies link back to the same run/session state rather than creating an unrelated execution path.
8. **Model choice is user-respecting.** Support an explicit provider/model choice when configured, and a Sofia-managed automatic mode. Routing considers task capability, privacy, provider availability, latency, and cost. Provider choice must never alter authorization or security policy.
9. **Honest limits.** Report completed, partial, blocked, cancelled, and failed outcomes distinctly. Distinguish implemented, unit-tested, integration-tested, CI-verified, and deployment-validated capabilities.

## Current branch status (verified against source and tests)

- **Session replay and older-turn retrieval — implemented on the `SofiaAgent` path:** when a caller supplies `sessionId`, the next run receives up to 12 recent prior turns within a 6,000-character bound, plus up to five lexical matches from older turns in that same session (2,000-character bound). Retrieval never searches across sessions/users and retrieved history is fenced as untrusted. This is bounded lexical matching, not semantic/vector search.
- **Saved user memory — implemented as optional retrieval:** if a configured memory store and host-derived `principalId` are present, Sofia retrieves up to five relevant explicitly saved memories within a 2,400-character bound. Retrieval is best-effort and memory is fenced as untrusted reference data. This does not enable automatic memory writing.
- **Learning — partially implemented:** the Brain has a verified repair-skill learning path, the EvolutionEngine records outcomes and ranks skills, and `getImprovementProposals()` now emits review-only, task-specific suggestions when at least three observations show a low success rate or high recovery cost. Proposals do not edit, enable, promote, or execute skills. This is not proof of autonomous general-purpose skill creation from arbitrary completed conversations or model training.
- **Model selection — not yet exposed as a per-request provider/model preference:** current legacy routing selects an internal route by task type. Explicit user choice plus `auto` remains open work.
- **Discord ordinary-message path — CI-verified, private-server smoke test pending:** an opt-in Gateway transport and runtime route ordinary text through the shared `MessagingGateway` and existing Sofia API handler. It includes heartbeat/reconnect, user/channel allowlists, deduplication, result delivery, and stops retrying when Discord rejects credentials/intents. Sofia CI #2579 and CodeQL #1038 passed for commit `d90611a1abf6afbdf6391049c291ba5d0fa88370`. Enable `SOFIA_DISCORD_GATEWAY_ENABLED=true` only after configuring Discord's Message Content privileged intent and verifying a private server. This is not yet deployment-validated.
- **Discord interaction replay protection — implemented in this branch:** the signed interaction transport tracks accepted interaction IDs for 14 minutes and rejects duplicate dispatches; a regression test covers replaying the exact signed request. This is scoped to the current process and is not a distributed cross-instance idempotency store.
- **Background jobs — substantial existing support:** the repository already contains durable job state, checkpoint resume, cancellation, and cron scheduling tests. Remaining work is consistent chat-to-run/session correlation and accurate progress/final-state delivery.

These are source-level branch statements, not a claim of production deployment validation.

## Implementation sequence

### P0 — Establish one ordinary-message path

- Define a normalized inbound-message contract with authenticated principal, transport, conversation/session key, message ID, text, attachments metadata, and reply target.
- Route ordinary chat messages and optional commands into the existing Core/Tool Gateway. Keep transport adapters thin.
- First slice: add the authenticated Discord Gateway transport, shared natural-language handler mode, and opt-in API-entrypoint runtime; remaining: verify CI and private-server delivery.
- Deduplicate inbound messages and preserve owner/channel authorization.
- Acceptance: a natural-language message starts work without `/run`; the same request through API and chat reaches the same Core behavior; unauthorized users cannot trigger work. The runtime wiring does not satisfy this gate until CI and private-server smoke tests pass.

### P0 — Session context (first slice implemented)

- Implemented bounded replay of recent turns on the existing `SofiaAgent` path; calls without a `sessionId` are unchanged.
- Implemented regression tests proving prior turns reach the next model request.
- Remaining: ensure every host/API/chat adapter derives an isolated session key from authenticated ownership, and add relevance search over older history without unbounded transcript injection.

### P0/P1 — User memory (first slice implemented)

- Implemented optional retrieval of explicitly saved user memories into the existing Core context assembly, scoped to the host-provided principal and bounded to five entries / 2,400 characters.
- Retrieval errors do not fail a run; retrieved memory is fenced as untrusted reference data and cannot grant permissions.
- Remaining: prove cross-adapter owner/session isolation, retrieval behavior after deletion, and relevance quality with end-to-end tests.

### P1 — Close the verified learning loop

- Connect execution outcomes to the existing EvolutionEngine and skill ledger only after independent verification.
- Store sanitized task category, skill/version, success/failure evidence, recovery count, and timestamps.
- Use repeated, task-specific evidence to rank skills and emit review-only improvement proposals (minimum three observations; low success rate or high recovery cost). Keep proposal generation separate from edits/promotion; evaluate any human-reviewed candidate against regression tasks before promotion.
- Acceptance: repeated tasks can reuse a verified skill; failed approaches are not blindly repeated; quarantined skills cannot execute; tests show no single lucky success dominates ranking.

### P1 — User-controlled model routing

- Add an explicit request/config preference for provider + model, alongside `auto`; validate it against configured providers and capability policy.
- Preserve per-user configuration isolation and redact credentials from logs/traces.
- Acceptance: an explicit supported model is honored; auto mode selects an eligible model; unavailable models fail clearly or use a disclosed fallback; all choices pass through the same security policy.

### P1 — Background continuity

- Connect message/session identity to durable run IDs, progress updates, cancellation, and restart recovery.
- Keep transport delivery failures separate from task execution state.
- Acceptance: reconnecting or restarting does not silently duplicate side effects; cancellation is honored; the final message reflects the verified durable run state.

## Required regression tests

- Natural-language chat message starts a run without a slash command.
- API, Telegram, Discord, and web adapters use the same Core contract.
- Missing/invalid signature, missing allowlist, cross-user request, duplicate message, and replayed interaction are rejected.
- Recent transcript and retrieved history are bounded and namespaced by authenticated principal.
- Relevant memory reaches the model; irrelevant memory does not; deleted memory is not retrieved.
- Poisoned memory/transcript/skill content cannot override system policy or tool authorization.
- Skills are promoted only after verified outcomes and regression evaluation.
- Explicit model selection and auto routing both respect configured providers, budgets, privacy, and the same Tool Gateway policy.
- Restart, cancellation, timeout, duplicate delivery, and failed message delivery preserve correct run state.
- No success claim is emitted without verification evidence.

## Change-safety rules

- Inspect current source, tests, git diff, and branch status before changing implementation.
- Extend existing modules and interfaces additively; do not create parallel runtimes, registries, schedulers, or memory stores.
- Preserve current security controls and compatibility. Do not change production, merge to `main`, or perform destructive migrations as part of parity work.
- For each implementation slice, add regression tests and report exact commands/results. A documentation update or commit is not proof that behavior works.
