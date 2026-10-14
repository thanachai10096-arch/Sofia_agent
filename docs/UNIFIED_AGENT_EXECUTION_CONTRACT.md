# Unified Agent Execution Contract

Status: implementation requirements, not a claim that every capability is implemented.

## One core, many channels
Web, desktop, mobile, messaging adapters, SDK, and API must use the same versioned job/session contract and Sofia Core. Clients are transport/presentation layers and must not bypass core authorization or tool policy.

## Canonical lifecycle
1. Authenticate the caller and resolve user/tenant identity.
2. Normalize request, workspace, acceptance criteria, deadline, and separate resource budgets.
3. Plan using schema-validated model output.
4. Re-authorize each action at execution time.
5. Execute only through the central tool registry and policy-enforcing adapters.
6. Record bounded, redacted traces with action IDs, state transitions, evidence references, approval decisions, and usage.
7. Verify outcomes independently against acceptance criteria.
8. Recover through bounded diagnosis/replanning, cancellation, timeout, checkpoint, and rollback.
9. Return truthful completed/partial/blocked/failed status with evidence and usage.

Missing evidence or verification must never be reported as success.

## Runtime invariants
- Check ownership on every job, trace, checkpoint, cancel, resume, and mutation operation.
- Durable workers require atomic claims, leases/heartbeats, and duplicate-side-effect protection.
- Cancellation/completion races must yield one terminal result and prevent new side-effecting actions after cancellation is observed.
- Checkpoints are atomic and versioned; resume revalidates current permissions.
- Bound time, model/tool calls, output bytes, tokens, concurrency, and provider cost separately.
- Unknown provider cost remains unknown, not zero.
- Approval denial, expired approval, permission revocation, timeout, cancellation, malformed input, and ownership mismatch fail closed.
- Model output, tool output, files, web pages, memory, and skills are untrusted data, never policy instructions.
- A skill can guide routing but cannot grant authority or alter security policy.
- Model routing can change provider selection, never authorization policy.
- A child-process runner is not an OS/container security boundary. State actual sandbox boundaries and residual risk.

## Skills and learning
- Skills have stable IDs, versions, declared capabilities, schemas, and acceptance criteria.
- External/model-generated skills remain quarantined until reviewed and explicitly installed.
- Select skills deterministically for a given task, policy, and catalogue.
- Persist outcomes only after independent verification; record skill version, task type, sanitized failure category, evidence status, and sample count.
- Ranking uses bounded evidence; a single success must not dominate.
- Memory excludes secrets and raw unfiltered tool output. Retrieved memory is context, not authority.
- Learning may recommend changes, but cannot alter permissions, approval rules, or budgets.

## Multi-model routing and usage
Route by capability, privacy, provider availability, latency target, and budget. Prefer the lowest-cost model that meets verified requirements; escalate only under explicit failure/confidence rules. Validate structured outputs, bound retries/concurrency, and record provider/model, token usage when available, latency, retries, and cost with secrets redacted. Do not claim quality improvements without reproducible evaluations.

## Gateway and clients
The gateway enforces authentication, scopes, quotas, request-size limits, cancellation, streaming/backpressure, idempotency, audit events, and version compatibility. Desktop capabilities are opt-in and explicitly granted. Mobile clients must not imply access to local desktop resources they do not possess.

## Required adversarial integration tests
- Invalid/expired/revoked auth and malformed authorization headers.
- Cross-user job/trace/checkpoint read, cancel, resume, and mutation.
- Approval denied/expired and permission revoked after planning.
- Cancellation/timeout before, during, and racing with completion.
- Duplicate worker claims, stale leases, process restart, and duplicate side effects.
- Path traversal, symlink escape, secret-file access, oversized inputs/outputs, and malformed tool schemas.
- Browser redirect to private/reserved IP, DNS edge cases, and disallowed egress.
- Terminal environment secret filtering and denied executable/argument policy.
- Sandbox unavailable, image mismatch, mount boundary, and network denial.
- Corrupted/old checkpoint, prompt-injected skill, poisoned memory, and forged success evidence.
- Budget exhaustion in planning, execution, diagnosis, and finalization.

Tests must assert that the forbidden action did not occur; an error response alone is insufficient.

## Release evidence
Use distinct labels: implemented, unit-tested, integration-tested, CI-verified, production-validated. Reports include commit SHA, exact commands, OS/runtime matrix, pass/fail and skipped tests, limitations, and benchmark version. Do not publish readiness percentages without a reproducible scoring formula and evidence.

## Execution order
1. Fix reproducible typecheck/test/CI blockers.
2. Prove ownership, authorization, approval, cancellation, and concurrency.
3. Prove sandbox/browser/terminal negative cases.
4. Connect skills to actual routing/execution and persist verified outcomes.
5. Add capability-based model routing and real provider usage/cost accounting.
6. Expand versioned benchmarks and unify gateway/client contracts.

This document defines requirements to implement and test; it does not prove that the current repository satisfies them.
