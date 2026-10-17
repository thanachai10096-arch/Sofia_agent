# Sofia Agent Readiness Matrix

**Snapshot:** 2026-10-17  
**Default branch observed during this audit:** `main` at `1ef56342262dd880c3bead0b72af285e6f4e029d`  
**Purpose:** distinguish code present in the default branch from isolated pull requests, tested behavior, and production readiness. This is an evidence snapshot, not a promise that every feature is production-ready.

## Status definitions

- **On main:** code is present in the default branch.
- **PR only:** implementation is proposed on an open pull request and is not yet integrated.
- **CI on PR head:** a GitHub Actions run passed for the specific recorded commit. This does not prove integration with other PRs or production suitability.
- **Pending evidence:** the final integrated branch still needs tests, review, or deployment-specific validation.

## Capability matrix

| Capability | Current evidence | Status | Required before release |
|---|---|---|---|
| Typecheck, tests, build across Linux/Windows/macOS | Previously inspected main workflow reported success for the tested commit; refresh against the current main head | Baseline evidence; refresh needed | Run full workflow on the exact final integrated commit |
| Brain planner/executor and verify/repair loop | `src/brain/executor.ts`, planner, verification and executor tests exist | Implemented foundation; integration quality still needs E2E proof | End-to-end task → authorized tool → evidence verification → repair/replan → final report |
| Workspace containment and tool policy | Runtime path containment, policy checks and sandbox-related tests exist in inspected baseline | Implemented foundation | Re-test symlink/path escape, permission denial, and cancellation on integrated branch |
| Tool output secret redaction | PR #117, head `3f6fad4918689d3dcf7b670cc8bc56053367f1a3`; previously observed CI run `39006577254` passed its reported jobs | PR only; CI on that head | Review encoded/obfuscated secret cases and re-run on integrated base |
| API concurrency limits | PR #111, head `41b42ed7a791cffbc3776983120a05258d2a965d`; previously observed CI run `38849930575` passed its reported jobs | PR only; CI on that head | Verify reservations are released on every terminal path; exercise all run modes and concurrent requests |
| API idempotency | PR #116, head `699bea5130c28fdd3c3272d44b9c065d51bb2664`; previously observed CI run `38847933156` passed its reported jobs | PR only; CI on that head | Verify canonical request fingerprints, owner isolation, duplicate races and restart behavior |
| Acceptance criteria validation | PR #110, head `05d9d75eee7f3f8e71c8f18710ee1c5e5a5b8d8c`; previously observed CI run `38523417558` passed its reported jobs | PR only; CI on that head | Validate sync/async/SSE, persisted and replayed requests, and boolean-only pass evaluation |
| API tool-call quotas | PR #114, latest audited head `5d32992c65cd105a96a21f125dd6db59e3c5ce72`; includes Brain event bridge, pre-execution abort guard, abort-reason propagation/listener cleanup, and regression tests. An earlier head failed because the test expected a rejected promise instead of a failed CompletionReport; the test was corrected. Latest-head CI run `39008941188` passed all six reported jobs on `5d32992c65cd105a96a21f125dd6db59e3c5ce72`; branch is still 16 commits ahead / 42 behind main and integrated-base validation remains required | PR only; PR-head CI passed | Require green CI on latest head and integrated base; test quota behavior across sync/async/SSE |
| Durable job-state serialization | PR #95, head `852ddbd983fc7bdae6b2a031dc899e67f8c18fce`; previously observed CI run `38667510464` passed its reported jobs | PR only | Validate cross-process and cross-OS contention; document that local file locking is not a distributed lock |
| Durable claims, leases and worker fencing | PR #101, head `c903a83548be0d169f51bdab448f4365aeebed55`; previously observed CI run `38667707872` passed its reported jobs; PR is based on #95 and reports non-mergeable | PR only; dependency/conflict gate | Integrate and test #95 + #101 together, including stale lease, fencing, cancellation, resume and worker contention |
| Unified chat access foundation | PR #104, head `6ed39392af0010d301a1bbff871f01e6144fc71e`; reports non-mergeable | PR only; conflict gate | Rebase/resolve conflicts; test shared core/policy path and principal/capability propagation |
| Persistent conversation sessions | PR #112, head `5b6a51c5dd31a9c4934c20b1ff6e867102f4c529`; previously observed CI run `38848024137` passed its reported jobs | PR only | Test ownership isolation, persistence/restart, cancellation and secret-safe transcripts |
| User memory and expanded skills | PR #108, head `2e952c660db9b6a90d65eae2fdb9f038d3b0d3d6`; previously observed CI run `38932929113` passed its reported jobs | PR only | Test consent, per-principal scope, clear/delete, secret filtering, quarantine and restart persistence |
| Skill policy integration | PR #94, head `b80920cedaeb20ad72afc6692e301d16477ca777`; reports non-mergeable and no PR workflow run was found in the audit | PR only; conflict/CI gate | Resolve conflicts; prove ranking uses verified outcomes only and external skills remain quarantined until trusted |
| Bounded agent coordination | PR #113, head `6e16187599816f4acc26fc3c8ffd5c9df201508e`; previously observed CI run `38850030018` passed its reported jobs | PR only | Test inherited principal, permissions, workspace, budgets, bounded fanout/depth, cancellation and audit continuity |

## API quota constraints

The current `UsageLimiter` is process-local and in-memory. Counters reset after the 24-hour window or process restart; separate API replicas do not share a single cap. Treat this as a per-process guard, not a durable billing ledger or account-wide abuse-prevention boundary. A shared atomic store and concurrency-safe reservation model are required before advertising global quotas across replicas.

## Release gates

1. Refresh the default branch SHA and collect CI evidence for that exact commit.
2. Resolve all branch conflicts and dependencies; do not merge a dependent PR against an unintegrated parent.
3. Run typecheck, tests, build, license checks, and security/sandbox integration on the exact combined head.
4. Add end-to-end evidence for execution, verification, repair/replan, restart recovery, cancellation, idempotency and multi-worker contention.
5. Verify principal isolation and permissions across API, chat, memory, skills and delegated agents.
6. Update this matrix from actual final-head evidence. Do not convert “PR exists” or “isolated CI passed” into “production-ready.”
