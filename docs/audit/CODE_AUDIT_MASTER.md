# Sofia Agent — Code Audit Master

Audit date: 2026-11-01
Repository: https://github.com/thanachai10096-arch/Sofia_agent
Audited base: `main` at `4189b70ba0dc7068af52f2296a345bed613e8b14`
Audit branch: `audit/code-recovery-quality-2026-11-01`

## Executive summary

This is an evidence-based partial audit of the repository's current mainline and selected high-impact pull requests. It is not a claim that every source file or every historical PR has been exhaustively reviewed.

The main issue is integration and evidence freshness, not proof that most code is defective. Multiple useful features have merged, while many open PRs are stacked, overlapping, or still awaiting current-head validation. A passing workflow on an earlier commit does not validate later commits.

No source implementation was changed by this audit. No PR was merged, closed, rebased, or deleted. No deployment was triggered.

## Mainline snapshot

- Main HEAD: `4189b70ba0dc7068af52f2296a345bed613e8b14`.
- The latest inspected main commit is a README formatting correction.
- The combined commit-status endpoint returned two Railway deployment status contexts: `ideal-truth - Sofia_agent = failure` and `accurate-determination - Sofia_API_Test = success`.
- The workflow-run lookup for this exact main SHA returned no GitHub Actions workflow runs through the inspected endpoint. Therefore this audit cannot claim that the current main SHA has a fresh full CI pass.
- A deployment status is not equivalent to a source test suite result.

## PR inventory sample

A GitHub PR search returned 100 records for the requested repository and sort window. Within that returned sample:

| State | Count |
| --- | ---: |
| Open | 74 |
| Closed and merged | 18 |
| Closed without merge | 8 |
| Draft among open | 43 |
| Non-draft among open | 31 |

These are counts of the returned 100-record sample, not the repository's lifetime totals, not a failure rate, and not a measure of defective code.

## Verified evidence highlights

### Current-head CI failures

- PR #344 originally failed on head `87cf1d5b3e973e4a3b28045678e388aff857cefa`. The exact job logs identify the root cause: `src/brain/memory-versioning.ts` contained five literal backslash-`n` sequences between TypeScript statements. TypeScript reported `TS1127 Invalid character` and `TS1434 Unexpected keyword or identifier` at lines 12 and 41. This single source syntax defect caused Typecheck failures on Ubuntu, macOS and Windows and downstream Build failures in Docker and Playwright jobs.
- A minimal correction replaced only those five literal `\\n` separators with actual newline characters on the PR branch. Fix commit: `cb5819e7e0a32b11eb57b304a20654175902438a`. The file was re-read from GitHub and verified to contain zero remaining literal backslash-`n` separators. Fresh CI for the fix commit had not appeared at the time of this audit update; the fix is therefore pending validation, not passed.
- CI run #3307 on merge snapshot `f8dbb88211c8943fd34104bd6c449811ae64ffa3` confirmed the original syntax error is gone: Ubuntu typecheck/tests, Windows cross-platform, Docker sandbox, Playwright egress and CodeQL passed. macOS ran 613 tests and failed one pre-existing timing-sensitive `DurableJobRuntime` test (`src/brain/job-runtime.test.ts`, expected `failed`, observed `queued` after a 500 ms polling window); 612/613 tests passed. The test is also present unchanged on main, so this is not attributed to the memory feature. A bounded 5-second polling deadline was committed to the PR branch as `c405358eb0306a4606bce6e219b29ee31b329a25`; current-head Sofia CI #3310 and CodeQL #1768 are queued/in progress and not yet passed.
- Original failing run: [Sofia CI #3304](https://github.com/thanachai10096-arch/Sofia_agent/actions/runs/41288474621); CodeQL had passed on the pre-fix head: [CodeQL #1763](https://github.com/thanachai10096-arch/Sofia_agent/actions/runs/41288474573).

### Current-head passes observed

- PR #343, head `41d516f2b40a7b350b9d14678582ff03b981ea8d`: Sofia CI and CodeQL both succeeded. This validates the tested code on that exact head, not live voice-provider availability or live Telegram voice behavior. The PR itself documents missing live tests, concrete STT/TTS provider registration, decoder integration and deployment wiring.
- PR #341, head `3ea2f66d7620f21ee4125192d422bc717c922e79`: Sofia CI and CodeQL succeeded.
- PR #338, head `9e1973322d05afd9805b58e73fa04681dbd4852a`: Sofia CI and CodeQL succeeded on the inspected head.
- PR #337, head `c75483c5f625baf330f5f0ef6c12618e6f13b39d`: Sofia CI and CodeQL succeeded on the inspected head. Live Telegram smoke testing remains a separate acceptance requirement.
- PR #329, head `3395dc56ba0fb259942b299fdaea7441d7d4ea6a`: Sofia CI and CodeQL succeeded on the inspected head. The PR's own contract describes important backup/restore functionality as groundwork, not a complete end-to-end crash-recovery system.
- PR #334, head `a826e82ae3cae63a67be5ca1cda0319a7c0d3ea4`: Sofia CI and CodeQL succeeded on the inspected head.

### No current-head workflow evidence observed

For PR #340, #342 and #328, the workflow-run lookup for the fetched current head returned no workflow runs. Earlier PR descriptions mention previous CI results on different commits, but those results must not be used to mark the current heads as passing.

PR #328's body records successful six-job CI and CodeQL for an earlier commit, while explicitly noting later credential-leak/authentication regression assertions were added after that tested commit.

## Merged capabilities confirmed by PR metadata/diffs

- #323: OpenAI-compatible model provider configuration merged.
- #326: selectable configured model route merged.
- #327: native Anthropic Messages provider merged.
- #324: relevant user memory injection into authenticated principal context merged.
- #321: verified workflow patterns persistence merged.
- #318: natural-language messaging without requiring `/run` merged.
- #322: Windows job-lock retry fix merged.

These merge records establish that code entered main; they do not independently prove every production deployment or external integration is live.

## Structural risks identified

1. Stacked PRs target feature branches rather than main. Their validation depends on exact base/head ancestry and may not be independently mergeable.
2. Several PRs have overlapping scope: messaging/Discord, model providers/routing, memory/skill ledger.
3. Current-head validation is sometimes missing even when a previous commit passed.
4. Feature contracts sometimes describe extension seams or primitives rather than a fully wired user-facing capability.
5. Main's latest inspected SHA lacks a fresh workflow run in the inspected result; one Railway deployment context is failing.
6. The current PR search sample does not cover every historical PR. A complete historical inventory needs paginated enumeration beyond the returned 100 records.

## Required next actions

1. Retrieve full logs for PR #344's failed Typecheck and Build steps; fix only the confirmed causes on its branch and rerun all required workflows.
2. Map PR dependency ancestry and file overlap before selecting merge order.
3. Validate current heads of #340, #342 and #328; do not infer from older CI runs.
4. Perform real, credential-safe smoke tests for Telegram, Discord, model providers and voice in the test environment.
5. Verify backup restore by process-kill/restart and rollback tests before claiming crash recovery.
6. Verify persistent memory and skill ledger under restart, concurrent writes and principal isolation.
7. Obtain a fresh mainline CI result and investigate the failing Railway deployment context before release.

## Audit integrity rules

- PASS is attached to an exact commit SHA and exact test evidence.
- A PR being open, closed, merged, or draft is not a code-quality verdict.
- Unit tests do not prove live provider/channel integration.
- A successful build does not prove runtime correctness.
- No destructive cleanup is permitted based only on this audit.

## Additional merge blockers found in PRs #328, #340, and #342

### PR #340 — model capability / gateway settlement
- The branch is based on an older merge base (`59785c78aae8d57fc00a7f7be9251076e5a388fc`); comparison reports 89 commits ahead / 2 behind current main, with 30 changed files. It is not mergeable and no workflow runs were observed for its inspected head.
- Blocking correctness issue in the added `TokenAwareGateway`: `checkedJournalRuns` caches a run ID after the initial `hasUnresolved()` check. If a provider call later fails with unknown usage, the journal attempt intentionally remains unresolved, but a subsequent call for the same `runId` skips `hasUnresolved()` because the ID is cached. That can permit a second provider call despite ambiguous billing. Fix the guard and add a regression test that invokes the gateway twice with the same run ID after an unknown-usage failure and proves the second provider call is blocked.
- Other changes touch core execution, billing settlement, token budgets, and run identity restoration; require focused review and fresh CI.

### PR #328 — independent providers per route
- The five-file patch is narrow and adds useful tests for complete/partial route configuration, URL validation, `/v1/models` authentication and credential non-disclosure, and refusing unhealthy explicitly selected routes.
- Passing CI evidence is for older commit `d9a072a24a1ce9dc0a1c3f5425fe162ce549dbd5`, not current head `6d5e58eeeb81bd48b5bfaf709a266aeef65f4c0c`. Latest API security assertions and unhealthy-route test are not covered by those runs.
- Branch comparison: 8 ahead / 3 behind current main; not mergeable. Current main has newer native Anthropic protocol support and provider configuration changes. Reconcile route-specific OpenAI-compatible overrides with the current adapter abstraction; preserve native Anthropic support.

### PR #342 — verified-learning policy recheck
- This is stacked on `feat/verified-learning-loop` / PR #308, not a standalone feature branch. Direct comparison to main shows 156 ahead / 9 behind; review the parent stack and merge base, not only the six-file patch.
- Added checks after promotion and before activation are directionally important. Verify `currentPolicyRevision()` reads from the same transactional consistency boundary as `tx.activateSkill`; otherwise policy can still race between the revision read and activation. Add a deterministic final-persistence-boundary test and run fresh CI on the actual merge snapshot. No current-head workflow run was observed.

- **Blocking correctness issue found and patched on the PR branch:** `checkedJournalRuns` cached a run ID after the initial `hasUnresolved()` check, allowing a second call for that run after unknown-usage failure left a journal attempt unresolved. Added `blockedJournalRuns` and fail-closed handling for unknown usage, invalid metered usage, and journal-settlement persistence failure; added a same-run repeated-call regression test. Fix commits: `78b006040fa3afeb198148d28cce73d6505ff0bf`, `0b8c1dea28e014dd421310caa2dcc9bf66d780c3`, `e9cc317d7bc2b0ab6e64e92bfc87efb917466993`. The latest commit has no workflow run/status yet, so the fix is pending CI and review.
