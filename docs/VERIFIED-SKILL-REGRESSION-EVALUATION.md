# Verified skill regression evaluation

Sofia's versioned skill lifecycle accepts an injected evaluator. A metadata-only evaluator can confirm that a package is well-formed, but it cannot prove that a learned skill improves task outcomes. The helper in `src/brain/skill-regression-evaluator.ts` adds a repeatable, baseline-compared evaluation contract for hosts that can provide a trusted isolated runner.

## Evaluation flow

1. Provide a non-empty set of stable synthetic fixtures with unique IDs and task types.
2. The host runner executes each fixture against baseline behavior (the current active version, or no skill when none exists) and the candidate.
3. The evaluator records candidate pass/fail, normalized quality score, latency, and token usage when the runner can measure them.
4. Promotion evidence fails closed if fixtures are missing/duplicated, the baseline or candidate run errors, any candidate fixture fails, quality regresses, or latency/token usage exceed configured regression ratios.
5. The existing `VersionedSkillLifecycle` still applies its confidence threshold, persistence rules, and explicit approval workflow. Evaluation alone never activates a skill.

## Security contract

- The helper does not interpret or execute procedure text. The injected runner is responsible for running in a disposable isolated workspace, enforcing time/resource limits, and withholding ambient secrets and network access unless explicitly required by a test.
- Use synthetic, non-sensitive fixtures. Never include API keys, private user data, or production credentials in fixture inputs or evaluation details.
- Keep the existing policy gateway, approval checks, lifecycle provenance, and rollback behavior.
- A passing test suite is evidence for the fixtures and environment used, not proof of universal skill correctness.

## Integration status

This helper is opt-in and additive. The default model factory's existing metadata evaluator is not silently replaced by a runner that may execute repository commands or arbitrary skill instructions. A host must deliberately wire a trusted isolated runner and real fixtures before claiming outcome-based self-improvement. Until then, the evaluation framework is available but end-to-end automatic learning is not complete.
