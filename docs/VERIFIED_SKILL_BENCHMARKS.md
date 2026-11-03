# Verified Skill Benchmarks

Sofia already has a versioned skill lifecycle, persistent provenance, evaluator checks, explicit approval before promotion, and rollback to a prior managed version. This module adds a reusable benchmark evaluator that can compare a proposed skill with the active version against the same repeatable fixtures.

## Evaluation contract

- Every benchmark fixture has a stable ID, task type, bounded input, and expected outcome.
- The caller supplies an `IsolatedSkillBenchmarkRunner`. It must run the skill inside an isolated workspace/sandbox and enforce Sofia's existing tool policy, permissions, and execution limits. This module does not execute procedure text.
- The candidate is run against every fixture. The evaluator records per-fixture pass/fail evidence, aggregate pass rate, and mean score.
- If an active baseline is supplied, the candidate and baseline run on the same fixtures. Promotion evidence fails if pass rate or score regresses beyond the configured tolerance.
- Invalid metrics, per-fixture timeouts, exhausted total wall-clock budget, failed fixtures, duplicate fixtures, or insufficient fixtures fail closed. The total benchmark budget defaults to 120 seconds and is capped at 30 minutes; each individual fixture also has its own timeout. Active-baseline lookup receives an AbortSignal and is cancelled when the budget expires; lookup adapters should honor it to release held resources.
- The lifecycle still owns persistence, confidence thresholds, approval, promotion, and rollback. Passing a benchmark does not itself activate a skill.

## Current integration boundary

The evaluator is an additive building block and has unit tests with deterministic fixture runners. It is **not yet connected to Sofia's production skill runner** because learned skills currently store human-readable procedures rather than executable, sandboxable actions. The existing factory evaluator checks metadata/procedure shape only; treating that as proof of task-level performance would be misleading.

Next integration step: adapt the existing Brain/tool execution trace into a restricted fixture runner that executes candidate skills in a temporary workspace, then provide a trustworthy active-version baseline. Do not auto-promote candidates until that integration is isolated and measured.

### Required adapter contract before production wiring

1. **Executable representation:** introduce a typed, versioned action/step representation for learned skills. Do not interpret the current free-form `procedure: string[]` as shell commands, JavaScript, prompts, or tool invocations.
2. **Execution path:** route every action through the existing Tool Registry and Policy Gateway. Re-authorize each action at execution time; never call a tool implementation directly from the benchmark adapter.
3. **Isolation:** allocate a fresh temporary workspace for each fixture and each candidate/baseline run. Use the configured container sandbox for untrusted execution; do not describe child-process mode as an OS sandbox.
4. **Evidence:** collect bounded, redacted execution traces and structured verifier results. A runner must not mark a fixture passed solely because a tool returned exit code zero; it must verify the fixture's declared expected outcome.
5. **Budgets:** enforce fixture and whole-benchmark deadlines, cancellation, tool-call limits, model-call/token budgets, output limits, and cleanup on success, failure, or abort.
6. **Baseline integrity:** load the active package through the lifecycle store, verify matching skill identity/version, and run candidate and baseline against the same immutable fixture set and equivalent policy.
7. **Promotion boundary:** benchmark success only changes evaluation evidence. Keep explicit approval, confidence checks, lifecycle persistence, and rollback as separate mandatory gates.

### Acceptance criteria for the adapter

- Tests prove that candidate and baseline cannot read or modify each other's workspace or host files outside the allowed mount.
- Tests prove that denied tools, network access, secret reads, and out-of-workspace paths remain denied during benchmark execution.
- Tests cover timeout/abort cleanup, malformed evidence, partial baseline runs, duplicate fixture IDs, and deterministic replay.
- CI exercises the real sandbox backend used by the adapter; mocked runners remain unit tests only.
- Until these checks pass, production continues using the existing metadata evaluator and no learned skill is treated as benchmark-verified.