# Code Recovery Registry

Audit date: 2026-11-01
Base main SHA: `4189b70ba0dc7068af52f2296a345bed613e8b14`

This registry records evidence and the next safe action. Status applies only to the exact inspected PR head SHA.

| PR | Scope | Inspected head | Evidence | Classification | Next action |
| ---: | --- | --- | --- | --- | --- |
| #344 | Markdown USER/MEMORY projections and maintenance | `cb5819e7e0a32b11eb57b304a20654175902438a` (fix commit) | Original head failed: five literal `\\n` sequences in `src/brain/memory-versioning.ts` caused TS1127/TS1434 on all OS typechecks and downstream Build failures. Five separators corrected; fresh CI for fix commit not yet observed. | REPAIR / PENDING-RETEST | Confirm CI on fix commit; inspect full test/build results; keep Draft until fresh checks and full diff review pass. |
| #343 | Shared voice contracts and Telegram voice building blocks | `41d516f2b40a7b350b9d14678582ff03b981ea8d` | Sofia CI + CodeQL pass | PASS-CI / INTEGRATION-PENDING | Keep Draft until provider/decoder registration, live channel tests, auth/dedupe and host wiring are verified. |
| #342 | Verified learning policy recheck | `7ebc4fded239a1eb603fa3e3428310dc1f88055b` | No workflow runs returned for inspected head; PR body reports earlier base-snapshot failures and says fresh run is needed | PENDING | Re-run current PR merge-snapshot CI; review final activation transaction and policy revision checks. |
| #341 | In-memory skill ledger defensive copies | `3ea2f66d7620f21ee4125192d422bc717c922e79` | Sofia CI + CodeQL pass | PASS-CI | Review whether the fix is already covered by later mainline code before merging; avoid duplicate implementation. |
| #340 | Model capability metadata and routing safeguards | `2af2a0a65a3f67a788c4863236c0cca589155d82` | No workflow runs returned for inspected head; PR body says current head was pending | PENDING | Trigger/inspect current-head CI; verify capability metadata semantics and token budget persistence tests. |
| #338 | Persistent skill ledger hardening and principal session scoping | `9e1973322d05afd9805b58e73fa04681dbd4852a` | Sofia CI + CodeQL pass | PASS-CI / REVIEW-INTEGRATION | Inspect full diff against #341 and main; verify session-key migration/backward compatibility and persistence failure visibility. |
| #337 | Telegram HTTP 409 poll conflict handling | `c75483c5f625baf330f5f0ef6c12618e6f13b39d` | Sofia CI + CodeQL pass | PASS-CI / LIVE-TEST-PENDING | Run safe test-bot smoke test: allowed user, denied user, conflict stop, explicit restart and result delivery. |
| #334 | Fence retrieved project memory in model context | `a826e82ae3cae63a67be5ca1cda0319a7c0d3ea4` | Sofia CI + CodeQL pass | PASS-CI | Check overlap with main and #344 memory projections; preserve untrusted-context boundary and total context limits. |
| #333 | Deterministic SQLite session search ordering | `5a1fedefdeab48510cb3273546be358095d18c03` | No current-head workflow evidence retrieved in this audit | PENDING | Run test on supported Node/SQLite versions; review SQL alias/FTS ordering and pagination stability. |
| #332 | Skill provenance/evidence validation | `e7915d55694d0faeaa1d18f659b354f011938b6e` | No current-head workflow evidence retrieved in this audit | PENDING | Run current-head CI; review prototype-pollution-safe own-property handling and schema bounds. |
| #331 | Concurrent project-memory writes and job execution tracking | `a2007b143bcc3c0ec399018c2cbd9ff00ffeb1a4` | No current-head workflow evidence retrieved in this audit | PENDING | Run cross-instance concurrent-write tests; inspect locking/atomicity and graceful shutdown behavior. |
| #329 | Backup manifest, restore adapters and journal primitives | `3395dc56ba0fb259942b299fdaea7441d7d4ea6a` | Sofia CI + CodeQL pass | PASS-CI / FEATURE-INCOMPLETE-BY-DESIGN | Preserve documented limits; do not claim full crash recovery until journal, durable rollback snapshots and startup reconciliation are wired and process-kill tested. |
| #328 | Independent providers per model route | `6d5e58eeeb81bd48b5bfaf709a266aeef65f4c0c` | No workflow runs returned for current inspected head; PR body reports CI on an earlier commit and later unverified credential tests | PENDING | Rerun current-head CI/CodeQL; review provider secret isolation, route selection and fallback budget behavior. |
| #324 | Inject relevant user memory into authenticated agent context | `96c48cd25ac9f9743f6b082b0c664e80d826409a` | Merged to main | MERGED | Treat main implementation as canonical; preserve authenticated principal scoping and untrusted-context treatment. |
| #323 | Selectable OpenAI-compatible model providers | `e5d583288098836a3ff6b876c7bb58eb8eb1c325` | Merged to main | MERGED | Treat as canonical provider foundation; add adapters rather than replacing the gateway. |
| #321 | Persist verified workflow patterns | `1453af12768718d83565adde9bcbb64e713d2a33` | Merged to main | MERGED | Inspect interaction with newer learning lifecycle; avoid parallel skill/learning stores. |
| #318 | Natural-language messaging without /run | `891d511507f4102efd16c231856eae3e17caf998` | Merged to main | MERGED | Treat as baseline; test actual deployed Telegram/Discord routes separately. |

## Duplicate / overlap clusters

- Skill ledger: #335 and #336 are closed unmerged attempts; #338 and #341 touch the same skill-ledger/session-security area. Compare exact changed files before merging any overlapping branch.
- User/project memory: #324 is already merged; #334 hardens project-memory prompt boundaries; #344 adds Markdown projections. Do not create a second canonical memory database or make Markdown snapshots an independent source of truth.
- Messaging/Discord: #315/#316/#317/#325/#337 and #318/#314/#313 touch stacked natural-chat and transport behavior. Map dependency ancestry and shared files before choosing one path.
- Model routing: #323/#326/#327 are merged foundations; #319/#328/#340 overlap in provider selection, per-route configuration and capabilities. Extend the merged gateway.
- Backup: #329 is a large PR with multiple groundwork primitives. Do not duplicate existing job/session/memory stores to complete it.

## Safe disposition policy

- Do not delete branches or close PRs just because they are stale, overlapping or unverified.
- Do not merge a PR solely because an older commit passed CI.
- For duplicate PRs, identify the canonical implementation, compare file-level diffs, port only unique fixes, and preserve regression tests.
- Require explicit review before schema/API breaking changes, data migrations, production deployment or destructive cleanup.
