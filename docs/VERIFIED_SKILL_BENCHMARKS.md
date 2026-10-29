# Verified Skill Benchmarks

Sofia already has a versioned skill lifecycle, persistent provenance, evaluator checks, explicit approval before promotion, and rollback to a prior managed version. This module adds a reusable benchmark evaluator that can compare a proposed skill with the active version against the same repeatable fixtures.

## Evaluation contract

- Every benchmark fixture has a stable ID, task type, bounded input, and expected outcome.
- The caller supplies an `IsolatedSkillBenchmarkRunner`. It must run the skill inside an isolated workspace/sandbox and enforce Sofia's existing tool policy, permissions, and execution limits. This module does not execute procedure text.
- The candidate is run against every fixture. The evaluator records per-fixture pass/fail evidence, aggregate pass rate, and mean score.
- If an active baseline is supplied, the candidate and baseline run on the same fixtures. Promotion evidence fails if pass rate or score regresses beyond the configured tolerance.
- Invalid metrics, per-fixture timeouts, exhausted total wall-clock budget, failed fixtures, duplicate fixtures, or insufficient fixtures fail closed. The total benchmark budget defaults to 120 seconds and is capped at 30 minutes; each individual fixture also has its own timeout.
- The lifecycle still owns persistence, confidence thresholds, approval, promotion, and rollback. Passing a benchmark does not itself activate a skill.

## Current integration boundary

The evaluator is an additive building block and has unit tests with deterministic fixture runners. It is **not yet connected to Sofia's production skill runner** because learned skills currently store human-readable procedures rather than executable, sandboxable actions. The existing factory evaluator checks metadata/procedure shape only; treating that as proof of task-level performance would be misleading.

Next integration step: adapt the existing Brain/tool execution trace into a restricted fixture runner that executes candidate skills in a temporary workspace, then provide a trustworthy active-version baseline. Do not auto-promote candidates until that integration is isolated and measured.