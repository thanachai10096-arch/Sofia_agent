# Sofia Agent Code Quality Gates

These gates define when a change may be called complete. They extend the existing runtime and security architecture; they do not create a second policy, test, or release system.

## Gate 0 — Change safety

- Inspect current branch, working-tree status, diff, target base SHA and dependent PRs.
- Preserve uncommitted work, secrets, runtime data and existing interfaces.
- Make the smallest additive, backward-compatible change.
- Do not rewrite history, force-push, delete branches, remove data or merge automatically.
- Record files changed and why each change is needed.

## Gate 1 — Static validation

- License/compliance check.
- Typecheck.
- Lint/format checks where configured.
- Build.
- No new unhandled promise rejections or unsafe casts without justification.

## Gate 2 — Automated tests

- Focused unit tests for changed behavior.
- Regression tests for every fixed bug.
- Full repository test suite.
- Cross-platform tests where the change affects OS/process/filesystem behavior.
- Integration tests for Docker, browser egress, databases or external adapters where applicable.

## Gate 3 — Security and privacy

- Authentication and principal/tenant isolation.
- Authorization rechecked at action time.
- Secret redaction and no credentials in logs, prompts, artifacts or frontend bundles.
- Untrusted user/project memory fenced and never treated as policy.
- Path traversal/symlink protections for file operations.
- Rate limits, deduplication, cancellation, timeouts and bounded input/output.
- No privilege escalation through learned skills or provider/model output.

## Gate 4 — Integration and runtime acceptance

- Verify actual wiring from public entrypoint to runtime to adapter/store.
- Test restart/recovery and concurrency where persistence is involved.
- Use test credentials and allowlists for Telegram/Discord/provider smoke tests.
- Verify failures are observable and do not silently fall back in unsafe ways.
- Confirm feature behavior on the deployed test environment; CI alone is insufficient for live integrations.

## Gate 5 — Evidence freshness

Every PASS must identify:
- Exact commit SHA.
- Workflow run IDs and conclusions.
- Required job results.
- Test environment and date for live integration tests.
- Known exclusions and limitations.

A result on a parent commit does not validate a later head. A PR's body text is not proof unless corroborated by current GitHub checks. An empty workflow lookup is UNKNOWN/PENDING, not PASS or FAIL.

## Gate 6 — Merge/release

- Diff reviewed against the intended base.
- PR dependencies and overlapping changes reconciled.
- Required CI and CodeQL green on the exact head/merge snapshot.
- No unresolved high-severity security issue.
- Release notes and rollback plan prepared.
- Production deployment only after explicit owner approval.

## Status vocabulary

- PASS-CI: required automated checks passed on exact SHA.
- PASS-INTEGRATION: live integration acceptance passed in a named test environment.
- REPAIR: concrete failure evidence exists and a fix is needed.
- PENDING: required evidence is missing or stale.
- BLOCKED: a dependency or failure prevents progress.
- MERGED: code is in the target branch; this is not itself proof of runtime integration.
- RETIRE-CANDIDATE: possible duplicate/obsolete code requiring dependency review; not permission to delete.
