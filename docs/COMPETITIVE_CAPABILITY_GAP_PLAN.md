# Sofia Agent — Competitive Capability Gap Plan

Date: 2026-10-19
Baseline: repository `main` README, package manifest, and session-store source inspected through GitHub. This is an implementation plan, not a claim that every capability below has been tested or shipped.

## Evidence-based baseline

- The README describes a policy-controlled agent lifecycle, tool gateway, built-in/persisted learned skills, durable jobs, recovery/checkpoints, an opt-in Docker sandbox, SDK/API, and an opt-in Discord interaction adapter.
- The README explicitly says SQLite transcript persistence does **not** replay history into model context and does **not** add transcript retrieval endpoints.
- The README's session-store source currently exposes a small in-memory `MemorySessionStore` interface. A separate SQLite-backed factory is documented as opt-in and requires Node 22.5+ because it uses `node:sqlite`; package.json currently declares Node >=20. This runtime-engine mismatch must be resolved before making SQLite the default.
- The README documents Discord, but does not claim Telegram/Slack/WhatsApp/Signal/Matrix support.
- The repository does not currently document a verified multi-agent orchestrator, public MCP server/OAuth 2.1 implementation, or a safe public skill marketplace. Treat those as gaps until code and tests prove otherwise.
- No performance claim (including a fixed memory-search latency or percentage speedup) is accepted without a reproducible benchmark on Sofia's own test corpus.

## Capability matrix

| Capability | Current evidence | Gap / next implementation |
| --- | --- | --- |
| Learning loop / skill creation | Persisted learned skills are described; README warns evolution signals are heuristic. | Add a bounded, opt-in post-run evaluator: extract candidate procedure from successful traces, redact secrets, run static/security review, test in a disposable workspace, require approval before activation, version skills, and support rollback. Never auto-promote arbitrary model output. |
| Searchable memory | SQLite transcript persistence documented; history replay and retrieval endpoint explicitly absent. | Add indexed FTS5 search with pagination and user/session ownership checks; return snippets with source IDs; inject only a small, relevant, recency-aware and token-bounded set into context. Respect deletion/retention and treat retrieved text as untrusted. |
| User modeling | Explicit user-memory routes are documented. | Add a separate opt-in preference profile with provenance, confidence, timestamps, correction/deletion, and per-user isolation. Store durable preferences only; do not silently infer sensitive traits. |
| Channels | Discord adapter documented. | Build a shared channel adapter contract and implement Telegram next, then Slack; keep auth, identity mapping, allowlists, rate limits, deduplication, and per-channel permissions in the common gateway. Each adapter needs live smoke tests before being advertised as supported. |
| Multi-agent orchestration | General agent lifecycle is documented; no verified orchestrator in the reviewed evidence. | Add bounded orchestrator/sub-agent contract with structured input/output, explicit task scopes, shared run budget/deadline, cancellation, max fan-out/depth, isolated workspaces, and parent verification. Start sequentially; enable parallelism only after race and budget tests. |
| Skill marketplace | No marketplace evidenced in reviewed docs. | Start with a signed/versioned local registry, provenance and dependency manifest, static scan, permission declaration, sandbox test, human review, revocation, and pinned versions. Do not ingest arbitrary skills directly from a public feed. |
| Remote execution | README describes an opt-in Docker sandbox and cloud execution backend contract. | Docker is not equivalent to a multi-backend executor. Define one execution-backend interface, capability declarations, timeouts/cancellation, artifact handling, and audit logs. Add SSH/hosted providers only behind explicit configuration and policy; do not claim six backends until tested. |
| MCP interop | No verified MCP server/OAuth 2.1 support evidenced in reviewed docs. | Implement MCP server as a separate opt-in adapter over the existing Tool Gateway, with least-privilege tool exposure, request validation, audit traces, and OAuth 2.1 only when a real authorization-server flow is implemented and tested. Never bypass existing policy checks. |

## Delivery order

### P0 — Memory retrieval and safe context replay
1. Inspect the actual SQLite store, API route registration, session ownership model, and test conventions before editing.
2. Add search/query contracts without breaking existing store interfaces.
3. Implement FTS5 search with a safe fallback when FTS5 is unavailable; use parameterized queries and strict ownership scoping.
4. Add a bounded context assembler: relevance + recency, token/character budget, source labels, and explicit separation of retrieved content from instructions.
5. Add tests for isolation, empty results, malformed queries, pagination, retention/deletion, FTS fallback, and context budget.
6. Resolve/document the Node engine floor before enabling `node:sqlite` on a Node 20 deployment.

### P1 — Observable learning loop
1. Record a minimal run outcome: task category, verified success/failure, tool sequence metadata, and redacted failure category. Avoid storing secrets or full sensitive payloads by default.
2. Produce candidate skills only from repeatable, verified successful traces.
3. Run lint/schema/security checks and disposable-workspace tests; quarantine candidates.
4. Require approval before activation; version and roll back skills; track outcome metrics and regressions.
5. Evaluate against a fixed repeat-task suite. Do not claim speedup until measured against a baseline.

### P2 — User preferences and channel adapter
1. Keep user profile data separate from raw transcript memory.
2. Support explicit user corrections and deletion.
3. Extract a channel-neutral message/identity contract; preserve the existing Discord API.
4. Add Telegram as a separate opt-in adapter and test retries, duplicate updates, unauthorized users, and restart behavior.

### P3 — Orchestration and execution backends
1. Define structured sub-agent contracts and shared budgets.
2. Add cancellation, fan-out/depth caps, isolated workspaces, deterministic aggregation, and parent verification.
3. Extend the current backend contract rather than duplicating the runtime or tool registry.
4. Add new backends only with real integration tests and a documented threat model.

### P4 — Reviewed skills registry and MCP
1. Add registry metadata, signatures/provenance, pinned versions, revocation, and review workflow.
2. Expose only approved tools through MCP by reusing the Tool Gateway policy.
3. Add auth and transport security tests; OAuth 2.1 is a separate acceptance gate, not a README-only feature.

## Acceptance criteria

- Every new feature has tests that exercise both success and denial/failure paths.
- Existing public interfaces remain backward-compatible unless a separately approved breaking change is required.
- User/session ownership is checked server-side for every retrieval and mutation.
- No secrets, API keys, or untrusted transcript content are promoted into skills or instructions.
- No new capability is described as production-ready until automated checks and the relevant live integration smoke test pass.
- Performance claims include a reproducible command, corpus, sample count, p50/p95, and baseline comparison.

## Safety and scope

This roadmap does not authorize production deployment, secret changes, automatic skill activation, public marketplace ingestion, broad filesystem access, or merging into `main`. Implement each feature additively on a feature branch, inspect diffs, run the repository's license/type/test/build checks, and open a reviewable pull request.
