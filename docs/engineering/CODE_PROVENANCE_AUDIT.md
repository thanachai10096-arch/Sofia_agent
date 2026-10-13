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
| `src/brain/skills.ts`, `src/brain/executor.ts` | Recovery selection adapter, policy prompt metadata, attempt receipts and success-learning gate | New integration changes are recorded in this branch; legacy source lines still need complete provenance attribution. |
| `src/brain/evolution.ts`, `tests/evolution.test.ts` | Existing success/failure ranking and JSON persistence; added bounded-load regression coverage | Persisted state is size-bounded and sanitized before ranking. The origin of every pre-existing line remains unverified. |
| `src/brain/verification.ts`, `src/brain/types.ts`, `src/brain/verification.test.ts` | Structured project-check evidence and propagation of actual assertion metrics | Missing test metrics remain absent; the policy learning gate does not invent assertion counts. Existing lines still need provenance attribution. |
| `package.json`, `LICENSE`, `scripts/check-license.mjs` | Declared project license and current checker behavior | The project declares Apache-2.0; the current checker is not a source-provenance scanner. |

## External similarity spot-checks

Limited public GitHub code searches were run for distinctive Skill Policy phrases and identifiers. No clear exact-expression match for the queried policy prose was found; a generic `boundedHistory`/`SkillOutcome` query returned an unrelated Java test. This is only a spot-check: code search is incomplete and does not establish independent authorship, legal compatibility, or the absence of similar code. No claim is made that a full repository-wide similarity scan has been completed.

The official [NousResearch/hermes-agent repository](https://github.com/NousResearch/hermes-agent) and [OpenClaw repository](https://github.com/openclaw/openclaw) each state that the project is distributed under MIT; OpenClaw also points to `THIRD_PARTY_NOTICES.md`. This confirms only those repositories' stated project licenses, not the license of every file or any right to copy particular code. If Sofia retains any third-party code, preserve the applicable notices and assess the exact file/range and any bundled third-party licenses separately.

## Reproducible line-attribution inventory

Run `npm run provenance:report` from a full Git clone. The script uses `git blame --line-porcelain` on tracked text/source files and writes a CSV containing path, line number, introducing commit, Git author metadata, commit summary, and a SHA-256 hash of each line. Pass a destination path as the first argument to choose the report location. It refuses shallow clones because their attribution is incomplete.

This report is an audit aid, not a copyright detector. Git blame cannot establish that a commit author independently wrote the code, and a line hash does not compare it with third-party sources. Each suspicious range still needs comparison with upstream code and license terms, and unknown provenance still needs an owner attestation or clean-room replacement. The Sofia CI workflow also uploads this line-attribution CSV as the `sofia-code-provenance-lines` artifact for pull requests and manual runs (retained for 14 days).

## Required audit procedure before a release

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
- Skill capability/permission fields and per-skill resource limits are currently catalog contracts exposed to the planner; the existing ToolGateway and Brain-wide budgets remain the hard enforcement layer. The per-skill sub-budget is not yet a separately enforced runtime account, so do not treat those catalog limits as a hard security boundary.
- External or learned skills remain quarantined until separately reviewed and explicitly enabled by trusted runtime policy.
- Only trusted runtime observations may establish execution success. A self-reported skill outcome, copied JSON receipt, or success claim in prose is not sufficient evidence.
- Security review completion and a security-clear result are distinct states. A completed review may still contain confirmed findings.
- Keep this file updated whenever a source file is added, imported, generated, or materially rewritten.

## Current limitation

This pass does **not** certify every line in the entire repository as original or legally compatible. The available GitHub file and commit views are sufficient to inspect the changed Skill Engine area, but a complete line-by-line audit needs the exact release tree, full history/blame data, source comparison, dependency/license review, and provenance attestations. Any final release claim must wait for that evidence.
