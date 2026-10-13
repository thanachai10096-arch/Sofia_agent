# Sofia Agent Capability Gap Matrix

**Purpose:** strengthen Sofia by selectively adopting proven agent patterns without duplicating its existing runtime.
**Scope:** Sofia Agents repository only. This document does not change Zuse.
**Evidence rule:** "Documented" means the repository documents a capability; it does not prove the capability has passed end-to-end tests in every environment. Treat benchmark claims as unproven until measured.

## Recent verified hardening (2026-10-13)

The following changes have been merged into `main` after branch-level CI passed on Ubuntu, Windows, and macOS:

- [PR #66 — Runtime recovery](https://github.com/thanachai10096-arch/Sofia_agents/pull/66): cancelled jobs cannot be resumed; snapshot persistence has a fallback; writes to the same run snapshot are serialized; replanned steps are not incorrectly skipped when a step ID is reused for a different action.
- [PR #67 — Process helper output and network policy](https://github.com/thanachai10096-arch/Sofia_agents/pull/67): output capture is bounded; requests that require network isolation fail closed when this helper cannot enforce it.
- [PR #68 — ProcessSandbox limits](https://github.com/thanachai10096-arch/Sofia_agents/pull/68): combined output-byte limits, timeout/abort failures, forced-kill fallback, and fail-closed network-isolation requests.
- [PR #69 — Reproducible dependencies](https://github.com/thanachai10096-arch/Sofia_agents/pull/69): commits `package-lock.json` and switches CI to `npm ci`.
- [PR #71 — Desktop child environment](https://github.com/thanachai10096-arch/Sofia_agents/pull/71): subprocesses inherit only a minimal baseline environment plus explicitly allowed variable names; runtime preload variables such as `NODE_OPTIONS` remain blocked.
- [PR #73 — Browser reserved IP ranges and live CI](https://github.com/thanachai10096-arch/Sofia_agents/pull/73): blocks the full `192.0.0.0/24` special-purpose range and `192.0.2.0/24` documentation range; live API/provider workflows use the committed lockfile.
- [PR #74 — Docker-backed ContainerSandbox](https://github.com/thanachai10096-arch/Sofia_agents/pull/74): adds digest-pinned, preloaded Docker execution with a read-only root filesystem, dropped capabilities, no-new-privileges, resource limits, workspace-only bind mount, network mode selection, and timeout/abort cleanup. The local runtime uses it when `SOFIA_SANDBOX_MODE=docker` and `SOFIA_SANDBOX_IMAGE` is configured.
- [PR #77 — Browser egress proxy](https://github.com/thanachai10096-arch/Sofia_agents/pull/77): validates all DNS answers and connects to a vetted numeric IP through a local HTTP/CONNECT proxy; blocks private/internal targets and non-standard web ports; disables Chromium QUIC and non-proxied WebRTC UDP.
- [PR #78 — Evidence-backed evaluation](https://github.com/thanachai10096-arch/Sofia_agents/pull/78): removes false-positive benchmark scoring; each acceptance criterion must have a matching executable probe, passed verification with evidence, and a completed Brain report.

- [PR #80 — Real process restart detection](https://github.com/thanachai10096-arch/Sofia_agents/pull/80): a subprocess exits with a running job; a fresh Node.js process reads the persisted record and detects the interruption.
- [PR #81 — Job API owner isolation](https://github.com/thanachai10096-arch/Sofia_agents/pull/81): tests owner-scoped reads, resume, cancel, and list responses for durable jobs.
- [PR #82 — ProcessSandbox environment allowlist](https://github.com/thanachai10096-arch/Sofia_agents/pull/82): restricts child environment inheritance to baseline and explicit variable names; runtime injection variables remain blocked.
- [PR #83 — Reserved tool effects in Brain gateway](https://github.com/thanachai10096-arch/Sofia_agents/pull/83) and [PR #85 — legacy execution follow-up](https://github.com/thanachai10096-arch/Sofia_agents/pull/85): prevent tools in Sofia-reserved namespaces from downgrading inferred security effects.
- [PR #84 — Benchmark domain coverage](https://github.com/thanachai10096-arch/Sofia_agents/pull/84): expands the harness to 13 deterministic cases covering coding, data, localization, security, documentation, source-grounded research, and automation. [Benchmark CI](https://github.com/thanachai10096-arch/Sofia_agents/actions/runs/38384329679) passed the fixture self-test and reference/no-op controls.
- [PR #86 — Brain tool input validation](https://github.com/thanachai10096-arch/Sofia_agents/pull/86): validates tool arguments against registered schemas before approval or execution.
- [PR #87 — Private persisted state files](https://github.com/thanachai10096-arch/Sofia_agents/pull/87): applies owner-only POSIX permissions to job records and Brain snapshots and checks the permissions in tests.
- [PR #88 — Checkpoint resume across a real process restart](https://github.com/thanachai10096-arch/Sofia_agents/pull/88): a second Node.js process loads the persisted checkpoint and successfully resumes the interrupted job.
- [PR #90 — Configurable persistent state directory](https://github.com/thanachai10096-arch/Sofia_agents/pull/90): configures job records, run snapshots, and project memory under `SOFIA_STATE_DIR`; default temp storage remains suitable only for development/tests, and the file-backed stores are not yet multi-worker coordinated.

Evidence:
- [Runtime recovery CI](https://github.com/thanachai10096-arch/Sofia_agents/actions/runs/38364742744) — all four jobs succeeded.
- [Security helper CI](https://github.com/thanachai10096-arch/Sofia_agents/actions/runs/38365206348) — all four jobs succeeded.
- [ProcessSandbox regression CI](https://github.com/thanachai10096-arch/Sofia_agents/actions/runs/38365656642) — all four jobs succeeded; the Ubuntu suite reported 174 tests passed and 0 failed.
- [Lockfile / npm ci CI](https://github.com/thanachai10096-arch/Sofia_agents/actions/runs/38366148663) — all four jobs succeeded with the committed lockfile.
- [Desktop child environment CI](https://github.com/thanachai10096-arch/Sofia_agents/actions/runs/38366620524) — all four jobs succeeded; the Ubuntu suite reported 182 tests passed and 0 failed.
- [Docker sandbox integration CI](https://github.com/thanachai10096-arch/Sofia_agents/actions/runs/38368698288) — all five jobs succeeded across Ubuntu, Windows, and macOS, including a live Docker smoke test on Ubuntu.
- [Browser proxy and Playwright smoke CI](https://github.com/thanachai10096-arch/Sofia_agents/actions/runs/38370179400) — all six jobs succeeded; the Ubuntu suite reported 191 tests passed and 0 failed. Live tests confirmed public HTTP/HTTPS through DNS-pinned proxy connections and a real Playwright Chromium navigation to `https://example.com` while private-IP navigation was rejected.
- [Evidence-backed evaluation CI](https://github.com/thanachai10096-arch/Sofia_agents/actions/runs/38371312572) — all six jobs succeeded; the Ubuntu suite reported 199 tests passed and 0 failed, including seven evaluation false-positive regression tests.

**Remaining security limitation:** `ProcessSandbox` is still a child-process runner, not an OS/container sandbox. `ContainerSandbox` is integrated with the local workspace runtime when `SOFIA_SANDBOX_MODE=docker` and a preloaded SHA-256-pinned `SOFIA_SANDBOX_IMAGE` are configured. Live Docker CI verifies dropped capabilities, `no-new-privileges`, workspace write access, inability to read a host file outside the workspace mount, read-only root filesystem, and blocked outbound TCP with `network=none`. This is a meaningful container boundary, not a guarantee against kernel/container-runtime escapes. Keep host-level egress policy, image provenance, Docker daemon access control, and target-environment validation as deployment gates. Other execution paths must explicitly select the container backend; direct process mode is not OS-level isolation.

## Current architecture documented by the repository

`Zuse / SDK -> Sofia API -> Agent -> Brain -> Tool Gateway -> central Policy -> capabilities`

The documented Brain lifecycle is `understand -> plan -> execute -> observe -> verify -> diagnose -> repair`. The README describes a central tool registry/policy gateway, persisted learned skills, a Playwright browser runtime, durable jobs/checkpoints, profiles/templates, an evaluation runner, and a model-agnostic API.

## Capability matrix

| Capability | Current evidence in Sofia | Maturity assessment | Gap / risk to close | Priority |
|---|---|---|---|---|
| Brain planning and repair loop | README documents the lifecycle, planner/executor, verification and repair | Implemented/documented; task-level reliability needs measured proof | Build a repeatable task suite and assert that verification is based on observable evidence, not model claims | P0 |
| Tool registry and policy gateway | PRs #83, #85 and #86 enforce reserved-name effects in Brain and legacy paths and validate Brain tool schemas before approval/execution | Central controls have stronger regression coverage; complete privileged-tool matrix still not proven | Test every privileged tool, malformed nested arguments, approval denial, cancellation/timeout, permission revocation, and custom-tool declarations | P0 |
| CI and cross-platform support | PR #69 merged; lockfile committed; CI uses `npm ci`; lockfile branch CI passed typecheck, tests and build on Ubuntu, macOS and Windows | Reproducible dependency resolution is now enforced in CI; local and production environments still need their own validation | Keep exact-commit Linux/macOS/Windows checks required for runtime/security changes; add explicit desktop packaging and live-service checks where relevant | P0 |
| Durable jobs and recovery | PR #66 adds recovery hardening; PR #80 proves interrupted-job detection across a real process restart; PR #88 proves checkpoint resume across a real process restart; PR #81 tests owner isolation; PR #87 restricts local record/snapshot permissions; PR #90 adds configurable persistent storage | Single-worker restart detection/resume are tested; concurrent multi-process writes/claims are not proven, and deployments must configure `SOFIA_STATE_DIR` on persistent storage | Add cross-process coordination/locking or a transactional shared job store, orphan recovery, cancellation-race coverage, and corrupted-snapshot recovery tests | P0 |
| Browser automation | PR #77 adds DNS-pinned HTTP/CONNECT egress proxy; blocks private targets and non-standard ports; disables QUIC and non-proxied WebRTC UDP; CI passes raw HTTP/HTTPS proxy smoke plus real Playwright Chromium smoke | Core browser egress policy is implemented and integration-tested; broad website compatibility and host-level isolation still need deployment validation | Keep host/container egress policy; add broader redirect, websocket, DNS edge-case, timeout, cleanup, screenshot, and OS-level network isolation tests | P0 |
| Codebase understanding and editing | README documents repository intelligence and edit engine | Foundation documented | Validate multi-file edits with baseline tests, minimal diffs, rollback, and no success report until tests/verification pass | P0 |
| Skills and learning | README documents built-in and persisted learned skills; platform includes skills and evaluation runner | Platform foundation documented; learning quality unproven | Add confidence calibration, outcome history, failure memory, ranking, versioning and rollback; promote skills only after evaluation | P1 |
| Persistent memory | PR #90 makes project-memory storage location configurable; existing tests cover persistence across store instances and prompt-injection filtering | Local persistence is available when configured, but multi-process consistency, retention/deletion policy, and learning quality remain unproven | Add scoped memory for user/project/task, provenance, freshness, retrieval tests, deletion controls, concurrency guarantees, and protection against prompt injection in stored content | P1 |
| Multi-agent delegation | PR list and README establish profiles/templates, but not proof of reliable general delegation | Not yet proven as production-grade capability | Implement bounded delegation with explicit task contracts, per-agent budgets, shared trace, conflict handling, cancellation and final independent review | P1 |
| Computer / desktop operation | README links a permission-gated local runtime foundation; PR #11 describes native driver and pairing primitives | Foundation only; not a complete installed desktop agent | Complete authenticated loopback transport, installer/service lifecycle, revocation, platform permission tests and hands-on Windows/macOS/Linux validation. Do not expose a local driver directly on a public API | P1 |
| Security and permissions | PRs #71, #82–#83, #85–#87 and #90 strengthen environment allowlisting, reserved tool effects, Brain input validation, job ownership, and private persisted state; PR #74/#77 test Docker and browser egress boundaries | Important guards are covered by targeted tests; Docker is opt-in, direct process mode is not OS isolation, and Windows file ACLs/host egress still need target-environment validation | Keep host/container egress policy; validate Docker daemon/image provenance; add full negative tests for every privileged tool, approval denial, revocation, cross-user access, and Windows ACL behavior | P0 |
| Mobile/browser clients and streaming | README documents async runs, polling, cancellation, SSE and CORS | API surface documented; integration E2E not proven here | Test disconnect/reconnect, sleep/background, cancellation, CORS/auth, and ensure privileged API keys remain server-side | P1 |
| Model routing and cost control | README says model-agnostic public surface and internal model routing | Design direction documented | Test routing policy, fallback/circuit breaker, per-run budgets, usage accounting and deterministic behavior when providers fail; model selection remains internal | P1 |
| Evaluation and benchmarking | PR #78 requires evidence-backed criterion probes; PR #84 adds 13 deterministic cases across seven task categories and reports category pass rates, duration, and available usage metrics | Harness self-test and controls pass; no measured Sofia score, historical baseline, scheduled trend, or authoritative provider-cost metric is claimed | Run against Sofia API in a disposable workspace; store versioned baselines; add independent probes for recovery/security, authoritative cost accounting, latency distributions, and scheduled regression comparisons | P0 |
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
