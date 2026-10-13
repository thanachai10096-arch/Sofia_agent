# Sofia Agents — Code Provenance and Copyright Audit

## Status

This is an evidence log, not a legal opinion or a blanket claim that the repository is copyright-clean.

- Repository-declared license: Apache-2.0 (`package.json` and `LICENSE`).
- Existing `scripts/check-license.mjs` verifies only the package license field and the presence of the Apache-2.0 license text. It does **not** establish the origin or license compatibility of individual source lines.
- The Skill Policy v1 code was present in draft PR #92 before this integration branch. The repository history proves when it entered this repository, but does not by itself prove whether every line was independently authored or derived from a third-party source.
- Do not treat renaming identifiers, changing formatting, or rewriting comments as a cure for copied expression.
- No code is certified as legally safe solely because it compiles, passes tests, or carries the repository's top-level license.

## Scope reviewed in this pass

| File / area | What was inspected | Provenance conclusion |
| --- | --- | --- |
| `src/brain/skill-policy-v1.ts` | Full draft file, schema validation, matching, history projection, attempt receipts and evidence handling | Origin of the initial PR #92 contribution remains unverified. Changes in this integration branch are recorded in Git history. |
| `tests/skill-policy-v1.test.ts` | Full draft test file and test assumptions | Initial test origin remains unverified; additional regression cases are authored in this integration branch. |
| `src/brain/skills.ts` | Existing legacy skill adapter and the changed integration path | Existing code predates this branch; the new adapter changes are recorded in this branch. A full repository-wide line-origin audit is still required. |
| `src/brain/evolution.ts`, `tests/evolution.test.ts` | Existing success/failure ranking and JSON persistence; added bounded-load regression coverage | Persistence handling was hardened in this branch. The origin of every pre-existing line remains unverified. |
| `package.json`, `LICENSE`, `scripts/check-license.mjs` | Declared project license and current checker behavior | The project declares Apache-2.0; the current checker is not a source-provenance scanner. |

## External similarity spot-checks\n\nLimited public GitHub code searches were run for distinctive Skill Policy phrases and identifiers. No clear exact-expression match for the queried policy prose was found; a generic `boundedHistory`/`SkillOutcome` query returned an unrelated Java test. This is only a spot-check: code search is incomplete and does not establish independent authorship, legal compatibility, or the absence of similar code. No claim is made that a full repository-wide similarity scan has been completed.\n\n## Required audit procedure before a release

1. Freeze the exact commit SHA being reviewed. Do not audit a moving branch.
2. Enumerate every tracked source, test, script, workflow, generated file, vendored file, and asset.
3. For each file, inspect `git log --follow` and `git blame` to identify introduced ranges and authorship history. History is evidence of repository entry, not proof of independent authorship.
4. Compare suspicious or externally attributed ranges against the original upstream repositories and their exact licenses, including notices and attribution requirements. Check dependencies separately through lockfiles and license metadata.
5. Classify each range as `first-party attested`, `third-party compatible with required notices`, `generated with recorded provenance`, or `unknown/quarantined`. Do not mark unknown code clean by default.
6. For uncertain code, stop distribution of that component, retain evidence, and replace it with a clean-room implementation from a behavior-level specification. Keep required third-party notices for code that remains.
7. Add regression tests for behavior and security boundaries, then run typecheck, tests, build, license checks, and the repository's CI. Record exact commands, commit SHA, and outcomes.
8. Have the project owner confirm authorship or licensing for any code whose provenance cannot be established from records.

## Integration rules

- Skill descriptions, prompts, browser content, learned procedures, and model-generated code are untrusted data. They cannot grant capabilities or permissions.
- External or learned skills remain quarantined until separately reviewed and explicitly enabled by trusted runtime policy.
- Only trusted runtime observations may establish execution success. A self-reported skill outcome, copied JSON receipt, or success claim in prose is not sufficient evidence.
- Security review completion and a security-clear result are distinct states. A completed review may still contain confirmed findings.
- Keep this file updated whenever a source file is added, imported, generated, or materially rewritten.

## Current limitation

This pass does **not** certify every line in the entire repository as original or legally compatible. The available GitHub file and commit views are sufficient to inspect the changed Skill Engine area, but a complete line-by-line audit needs the exact release tree, full history/blame data, source comparison, dependency/license review, and provenance attestations. Any final release claim must wait for that evidence.
