# Sofia Agent Capability Gap Matrix

**Purpose:** strengthen Sofia by selectively adopting proven agent patterns without duplicating its existing runtime.
**Scope:** Sofia Agents repository only. This document does not change Zuse.
**Evidence rule:** "Documented" means the repository documents a capability; it does not prove the capability has passed end-to-end tests in every environment. Treat benchmark claims as unproven until measured.

## Current architecture documented by the repository

`Zuse / SDK -> Sofia API -> Agent -> Brain -> Tool Gateway -> central Policy -> capabilities`

The documented Brain lifecycle is `understand -> plan -> execute -> observe -> verify -> diagnose -> repair`. The README describes a central tool registry/policy gateway, persisted learned skills, a Playwright browser runtime, durable jobs/checkpoints, profiles/templates, an evaluation runner, and a model-agnostic API.

## Capability matrix

| Capability | Current evidence in Sofia | Maturity assessment | Gap / risk to close | Priority |
|---|---|---|---|---|
| Brain planning and repair loop | README documents the lifecycle, planner/executor, verification and repair | Implemented/documented; task-level reliability needs measured proof | Build a repeatable task suite and assert that verification is based on observable evidence, not model claims | P0 |
| Tool registry and policy gateway | README describes one registry and one central policy gateway | Architectural foundation present | Test every tool path against the same policy; cover malformed arguments, cancellation, timeout, and denied actions | P0 |
| CI and cross-platform support | package scripts define typecheck, test, build; CI workflows are present | Must be judged by current workflow results per commit/PR | Do not merge an unverified PR just because main is green; require typecheck, tests, build on Linux/macOS/Windows for each change | P0 |
| Durable jobs and recovery | README documents snapshots/checkpoints and guarded resume; PR #7/#3 describe recovery hardening | Foundation documented; latest changes must be verified on their own branch | Test process restart, orphaned running jobs, duplicate resume, concurrent writes, cancellation and corrupted snapshots | P0 |
| Browser automation | README documents Playwright navigation and interaction; browser is opt-in | Capability documented; real-world safety and E2E coverage need proof | Keep SSRF protections on every navigation/redirect/subresource; test timeouts, redirects, DNS edge cases, browser cleanup and screenshots | P0 |
| Codebase understanding and editing | README documents repository intelligence and edit engine | Foundation documented | Validate multi-file edits with baseline tests, minimal diffs, rollback, and no success report until tests/verification pass | P0 |
| Skills and learning | README documents built-in and persisted learned skills; platform includes skills and evaluation runner | Platform foundation documented; learning quality unproven | Add confidence calibration, outcome history, failure memory, ranking, versioning and rollback; promote skills only after evaluation | P1 |
| Persistent memory | Learned skills are documented as persisted; general cross-session experience memory is not established by README alone | Partial / evidence insufficient | Add scoped memory for user/project/task, provenance, freshness, retrieval tests, deletion controls and protection against prompt injection in stored content | P1 |
| Multi-agent delegation | PR list and README establish profiles/templates, but not proof of reliable general delegation | Not yet proven as production-grade capability | Implement bounded delegation with explicit task contracts, per-agent budgets, shared trace, conflict handling, cancellation and final independent review | P1 |
| Computer / desktop operation | README links a permission-gated local runtime foundation; PR #11 describes native driver and pairing primitives | Foundation only; not a complete installed desktop agent | Complete authenticated loopback transport, installer/service lifecycle, revocation, platform permission tests and hands-on Windows/macOS/Linux validation. Do not expose a local driver directly on a public API | P1 |
| Security and permissions | Central policy and sandbox abstractions documented; README explicitly says process sandbox is not a container | Partial, honest limitations documented | Threat model, workspace allowlists, secret redaction, audit trail, least privilege, network egress controls and negative tests for every privileged action | P0 |
| Mobile/browser clients and streaming | README documents async runs, polling, cancellation, SSE and CORS | API surface documented; integration E2E not proven here | Test disconnect/reconnect, sleep/background, cancellation, CORS/auth, and ensure privileged API keys remain server-side | P1 |
| Model routing and cost control | README says model-agnostic public surface and internal model routing | Design direction documented | Test routing policy, fallback/circuit breaker, per-run budgets, usage accounting and deterministic behavior when providers fail; model selection remains internal | P1 |
| Evaluation and benchmarking | README lists an Evaluation runner | Runner existence documented; competitive performance not established | Create versioned benchmark tasks and baseline; compare success, regression rate, time, cost, safety and recovery against the same tasks | P0 |
| Observability and diagnosis | README documents traces and token budget | Foundation documented | Correlate run/step/tool/agent IDs, redact secrets, record evidence for verification and make failed runs diagnosable without logging sensitive data | P1 |
| Deployment / cloud execution | README documents a CloudExecutionBackend contract | Contract is not proof of a production cloud worker | Add a real backend only when needed, with auth, isolation, quotas, timeout, durable queue, observability and retry/idempotency tests | P2 |

## What to borrow from other agent ecosystems

These are design patterns to evaluate, not code to copy wholesale:

- **Hermes-style personal agent patterns:** durable experience memory, reusable skills, tool breadth, and scheduled work. Adopt only where Sofia lacks tested equivalents.
- **OpenHands-style coding workflow:** inspect repository -> plan edits -> modify -> run checks -> inspect failures -> repair -> report verified evidence.
- **OpenClaw-style extensibility:** consistent tools/skills/plugin boundaries with one permission model and one audit trail.
- **LangGraph-style orchestration:** explicit state, checkpoints, resumability, bounded retries, and human approval gates for consequential actions.

Do not introduce a second Brain, tool gateway, skill matcher, or job runtime to imitate another project. Integrate new behavior behind Sofia's existing interfaces.

## Execution roadmap and acceptance criteria

### P0 — prove the foundation
1. Resolve any typecheck/test/build failures on the exact PR branch; do not infer a fix from a stale run.
2. Require Linux, macOS and Windows validation for runtime/security changes.
3. Add end-to-end tests for a real run: request -> plan -> tool action -> observe -> verify -> final result.
4. Add restart/recovery tests: queued/running job interrupted -> explicit recovery state -> safe resume or actionable failure, never duplicate concurrent execution.
5. Add negative security tests: blocked browser targets, denied tools, invalid tool arguments, path escapes, secret leakage and cancellation.
6. Establish a benchmark baseline before claiming Sofia is stronger than another agent.

**P0 exit gate:** CI green on the exact commit for all required platforms, deterministic test evidence for the core lifecycle, and no unresolved high-severity security regression.

### P1 — add differentiated agent capabilities
1. Add scoped persistent experience memory with provenance and deletion controls.
2. Upgrade Evolution Engine: success/failure history, confidence calibration, skill ranking, regression evaluation, versioning and rollback.
3. Add bounded specialist delegation with budgets, shared traces, conflict prevention and independent final verification.
4. Finish the safe local desktop operator lifecycle and platform tests before advertising whole-computer control.
5. Add run-level observability and robust mobile reconnect/cancel tests.

**P1 exit gate:** each feature has tests, documented permissions, failure behavior and an evaluation showing that it improves baseline performance without increasing unsafe actions.

### P2 — scale after evidence
1. Implement cloud execution behind the existing backend contract only when isolation, quotas and operational monitoring are ready.
2. Optimize routing, latency and cost from measured traces.
3. Publish repeatable benchmark reports and regression thresholds.

## Benchmark protocol

Use the same versioned task set, starting repository state, allowed tools, time limit and budget for every candidate agent. Include:
- multi-file bug fix with tests;
- feature implementation with acceptance criteria;
- browser task with redirects and unsafe-target rejection;
- interrupted long-running task and recovery;
- malformed tool call and permission denial;
- ambiguous request requiring a clarification or safe stop.

Report at least:
- task success rate (with independently checked acceptance criteria);
- test pass rate and regression rate;
- unsafe-action rate;
- median and p95 completion time;
- cost per successful task;
- recovery success rate;
- number of retries and human interventions.

Run multiple trials for nondeterministic tasks. Record commit SHA, configuration and raw outcomes. Do not claim "better than Hermes/OpenHands/OpenClaw" unless results support the specific claim.

## Explicit non-goals for this phase

- Do not change Zuse or its Landing Page as part of this Sofia-only work.
- Do not expose model choice to end users.
- Do not grant unrestricted disk, browser-profile, shell, or remote-desktop access by default.
- Do not allow self-modifying code or learned skills to enter production without tests, permission checks and rollback.
- Do not merge unrelated open PRs as a shortcut; first reconcile overlapping changes and validate each branch.

## Repository review checklist

- [ ] Inspect all open PRs for overlap and stale base branches.
- [ ] Check latest CI status on each PR head SHA, not only main.
- [ ] Identify one authoritative implementation for each runtime capability.
- [ ] Link every capability claim to code/tests or label it "documented, unverified".
- [ ] Convert each P0 gap into a focused implementation PR with acceptance criteria.
