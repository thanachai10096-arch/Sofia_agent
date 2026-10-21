# Sofia Agent — Competitive Capability Gap Plan

Date: 2026-10-19
Baseline: inspected current `main` source for README, `package.json`, SQLite session store/tests, agent lifecycle, model factory, Telegram runtime, coordinated sub-agent runtime, and managed MCP server. This is an evidence-based plan; source presence is not a claim that all paths have passed end-to-end tests.

## Evidence-based baseline

- **SQLite transcript search exists in code.** `SqliteSessionStore` implements FTS5 with a parameterized LIKE fallback, pagination, and persistence tests. The README is stale on this point: it says transcript retrieval endpoints are absent, and the API route inspected does not expose a transcript search endpoint.
- **Transcript replay is incomplete.** `SofiaAgent` records turns when a session store and `sessionId` are supplied, but the current core path does not feed prior turns back into model context. SQLite session support is opt-in through `createSofiaAgentDependenciesWithSessions`; `package.json` says Node >=20 while opening `node:sqlite` requires a compatible Node release (README says Node 22.5+).
- **Telegram exists in code.** `createTelegramMessagingRuntime` bridges allowlisted Telegram messages to the existing Sofia API. Runtime support requires explicit environment configuration and live smoke tests; it should not be described as universally enabled.
- **Bounded sub-agent orchestration exists in code.** `CoordinatedSubagentRuntime` wraps `BoundedSubagentCoordinator` and the model factory wires limits for concurrency, task count, context size, and timeout. The next gap is proving end-to-end delegation quality, parent verification, budgets/cancellation, and failure recovery under realistic workloads.
- **MCP client/managed-server code exists.** `connectManagedMcpServer` uses an explicit tool allowlist and returns tools that must still pass through Sofia's normal ToolRegistry/ToolGateway. This is not evidence of a production MCP host endpoint or OAuth 2.1 authorization-server implementation.
- **Skill lifecycle/evolution primitives exist.** `EvolutionEngine`, `VersionedSkillLifecycle`, and managed skill learning are wired in the factory. The gap is measured, repeatable improvement across a benchmark suite—not simply storing a candidate or a heuristic score.
- **Discord is documented and configured as an opt-in adapter.** Slack/WhatsApp/Signal/Matrix and a public marketplace are not established as supported by the source reviewed here.
- No competitor performance claim (e.g., a fixed latency or percentage speedup) is accepted without a reproducible Sofia benchmark.

## Capability matrix

| Capability | Current evidence | Gap / next implementation |
| --- | --- | --- |
| Learning loop / skill creation | Evolution engine, versioned skill lifecycle, and managed candidate handler are wired in the factory. | Prove the loop from verified successful traces → candidate → redaction/security checks → isolated evaluation → approval → versioned activation → rollback. Benchmark repeated tasks before claiming improvement. |
| Searchable memory | SQLite FTS5 search and LIKE fallback exist, with pagination and tests. | Add an authenticated transcript search API with owner/session scoping, safe snippets, deletion/retention policy, and tests. Avoid returning other users' session IDs or content. |
| Memory replay into context | Current `SofiaAgent` stores turns but does not automatically inject prior turns into the next model context. | Add opt-in bounded context replay, newest relevant turns first, with explicit untrusted-data fencing and token/character budgets. Preserve current API behavior unless caller opts in. |
| User modeling | User Memory API stores explicit user-scoped preferences/facts/goals/instructions. | Add an optional preference profile with provenance, confidence, timestamps, correction/deletion, and per-user isolation. Do not silently infer sensitive traits. |
| Channels | Telegram runtime and Discord adapter exist in source; Telegram has explicit user/chat allowlists and connects through the existing API. | Harden the common adapter contract, add per-channel live smoke tests and restart/dedupe/rate-limit checks, then add Slack. Do not advertise untested platforms. |
| Multi-agent orchestration | Bounded coordinator and coordinated sub-agent runtime are wired into the factory. | Verify parallel task aggregation, shared budget/deadline, cancellation, max fan-out/depth, workspace isolation, parent verification, and graceful partial failure with end-to-end tests. |
| Skill marketplace | No reviewed evidence of a public marketplace with safe install lifecycle. | Start with a signed/versioned registry, provenance, pinned dependencies, permission declarations, static scans, sandbox evaluation, human review, revocation, and rollback. |
| Remote execution | Opt-in Docker sandbox and cloud execution backend contract exist. | Add backend adapters only through the existing contract; test cancellation, timeouts, artifact transfer, network isolation, and audit trails before claiming additional providers. |
| MCP interop | MCP client and managed-server adapter exist; tools are explicitly allowlisted and still must pass the ToolGateway. | Add/verify an MCP server entrypoint and authenticated remote transport only if needed. OAuth 2.1 is a separate gap until a real authorization-server flow and security tests exist. |

## Delivery order

### P0 — Transcript context replay + authenticated transcript search
1. Preserve the existing session interfaces and opt-in SQLite factory.
2. Add a bounded context builder that uses recent turns and marks transcript content as untrusted.
3. Keep replay opt-in; do not implicitly change all existing callers or force SQLite on Node 20.
4. Add a transcript search API only after extending the store contract with owner-scoped search; apply authenticated key/session ownership in the database query path, not only after fetching results.
5. Test cross-user isolation, malformed/empty queries, pagination, FTS fallback, deletion, restart recovery, and context size.
6. Update README to reflect code accurately once routes and opt-in usage are complete.

### P1 — Measured learning loop
1. Record verified run outcomes and redacted failure categories without storing secrets by default.
2. Generate candidates only from repeatable successful traces.
3. Quarantine candidates until static/security checks and disposable-workspace tests pass.
4. Require approval before activation; version and roll back skills.
5. Evaluate against a fixed repeat-task suite; report sample count, success rate, regressions, token usage, and p50/p95 latency.

### P2 — User profile and channels
1. Separate durable user preferences from raw transcript memory.
2. Add explicit correction/deletion and provenance.
3. Keep Telegram/Discord behind allowlists and the shared API/tool policy.
4. Add Slack only after common adapter contract and live integration tests.

### P3 — Orchestration and execution backends
1. Validate existing bounded sub-agent runtime with concurrent integration tests.
2. Add parent verification, aggregate result schemas, cancellation, and budget accounting where missing.
3. Extend the existing execution-backend contract; do not duplicate runtime, tool registry, or policy gateway.

### P4 — Registry and MCP transport
1. Add a reviewed, versioned skill registry before any public marketplace.
2. Expose only approved MCP tools through the existing policy gate.
3. Implement remote auth/OAuth only with a real flow, least-privilege scopes, and security tests.

## Acceptance criteria

- Each change is additive and backward-compatible unless a separately approved breaking change is necessary.
- Ownership is enforced server-side for every transcript/memory query and mutation.
- Retrieved transcript content is untrusted and cannot override system policy or grant tools.
- No secrets or raw sensitive payloads are promoted into skills or user profiles by default.
- Do not claim support, production readiness, or speedup without automated checks and the relevant live integration/benchmark evidence.
- Run repository license, typecheck, test, and build checks; review the final diff before merge.

## Safety and scope

This plan does not authorize production deployment, secret changes, automatic skill activation, public marketplace ingestion, or merging into `main`. Implement changes on isolated feature branches, inspect diffs, run tests, and open reviewable pull requests.
