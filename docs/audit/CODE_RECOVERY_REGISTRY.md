# Code Recovery Registry

Audit date: 2026-11-01
Base main SHA: `4189b70ba0dc7068af52f2296a345bed613e8b14`

This registry records evidence and the next safe action. Status applies only to the exact inspected PR head SHA.

| PR | Scope | Inspected head | Evidence | Classification | Next action |
| ---: | --- | --- | --- | --- | --- |
| #344 | Markdown USER/MEMORY projections and maintenance | `c405358eb0306a4606bce6e219b29ee31b329a25` | Original syntax defect fixed in `cb5819e7e0a32b11eb57b304a20654175902438a`. Current-head Sofia CI #3310 passed Ubuntu, macOS, Windows, Docker and Playwright; CodeQL #1768 passed. | PASS-CI / REVIEW-INTEGRATION | Complete full diff/security review; keep Draft until integration readiness and final merge checks are confirmed. |
| #343 | Shared voice contracts and Telegram voice building blocks | `41d516f2b40a7b350b9d14678582ff03b981ea8d` | Sofia CI + CodeQL pass | PASS-CI / INTEGRATION-PENDING | Keep Draft until provider/decoder registration, live channel tests, auth/dedupe and host wiring are verified. |
| #342 | Verified-learning policy recheck and SQLite integrity | `7ebc4fded239a1eb603fa3e3428310dc1f88055b` | Adds malformed receipt/evidence/regression guards, SQLite payload/index identity checks, transaction serialization and post-promotion policy rechecks. Remaining TOCTOU: `currentPolicyRevision()` is still a host callback invoked from inside the learning transaction, not proven to read from the same transactional policy store as `tx.activateSkill`; policy may change after the callback resolves and before activation write. | HOLD / POLICY-ATOMICITY-UNPROVEN / STACKED-DEPENDENCY | Introduce an authoritative atomic policy-revision compare-and-activate operation at the policy store boundary; add deterministic race test changing policy after the final read but before the active-skill write; rerun CI on exact merge snapshot. |
| #341 | In-memory skill ledger defensive copies | `3ea2f66d7620f21ee4125192d422bc717c922e79` | Sofia CI + CodeQL pass | PASS-CI | Review whether the fix is already covered by later mainline code before merging; avoid duplicate implementation. |
| #340 | Model capability metadata and routing safeguards | `bba5d3e9c3da73c230d25ddd9acbb6364331ace2` | Added same-run in-flight guard. Added checkpoint durability guard: the factory now waits for the durable Job snapshot callback, or retries and requires FileRunStore persistence for direct callers, before acknowledging the settlement checkpoint. Cross-process atomic claim remains unimplemented. Exact-head CI unavailable; branch divergence and 30-file integration scope still require review. | PARTIAL-REPAIR / JOURNAL-ATOMICITY-OPEN / PENDING-CI | Add a cross-process per-run claim or enforce single-writer use; add failure-injection and multi-process tests; run exact-head CI/CodeQL and reconcile mainline divergence. |
| #338 | Persistent skill ledger hardening and principal session scoping | `9e1973322d05afd9805b58e73fa04681dbd4852a` | Sofia CI + CodeQL pass | PASS-CI / REVIEW-INTEGRATION | Inspect full diff against #341 and main; verify session-key migration/backward compatibility and persistence failure visibility. |
| #337 | Telegram HTTP 409 poll conflict handling | `c75483c5f625baf330f5f0ef6c12618e6f13b39d` | Sofia CI + CodeQL pass | PASS-CI / LIVE-TEST-PENDING | Run safe test-bot smoke test: allowed user, denied user, conflict stop, explicit restart and result delivery. |
| #334 | Fence retrieved project memory in model context | `a826e82ae3cae63a67be5ca1cda0319a7c0d3ea4` | Sofia CI + CodeQL pass | PASS-CI | Check overlap with main and #344 memory projections; preserve untrusted-context boundary and total context limits. |
| #333 | Deterministic SQLite session search ordering | `5a1fedefdeab48510cb3273546be358095d18c03` | No current-head workflow evidence retrieved in this audit | PENDING | Run test on supported Node/SQLite versions; review SQL alias/FTS ordering and pagination stability. |
| #332 | Skill provenance/evidence validation | `e7915d55694d0faeaa1d18f659b354f011938b6e` | No current-head workflow evidence retrieved in this audit | PENDING | Run current-head CI; review prototype-pollution-safe own-property handling and schema bounds. |
| #331 | Concurrent project-memory writes and job execution tracking | `a2007b143bcc3c0ec399018c2cbd9ff00ffeb1a4` | No current-head workflow evidence retrieved in this audit | PENDING | Run cross-instance concurrent-write tests; inspect locking/atomicity and graceful shutdown behavior. |
| #329 | Backup manifest, restore adapters and journal primitives | `3395dc56ba0fb259942b299fdaea7441d7d4ea6a` | Sofia CI + CodeQL pass | PASS-CI / FEATURE-INCOMPLETE-BY-DESIGN | Preserve documented limits; do not claim full crash recovery until journal, durable rollback snapshots and startup reconciliation are wired and process-kill tested. |
| #328 | Per-route model providers | `6d5e58eeeb81bd48b5bfaf709a266aeef65f4c0c` | Adds four independent OpenAI-compatible route overrides, auth/credential non-disclosure tests, and rejects unhealthy explicit routes. Integration blocker: current main adds native Anthropic protocol metadata (`protocol: anthropic-messages`) but this branch's provider config shape and fallback construction omit protocol, while its gateway is still OpenAI Chat Completions-only. Merging as-is risks dropping native Anthropic protocol on shared-provider fallback. Branch is 8 ahead / 3 behind main. | HOLD / PROTOCOL-RECONCILIATION / STALE-BASE | Rebase/reconcile against current config and gateway; preserve selected.protocol for shared providers and explicitly mark per-route overrides OpenAI-compatible; add mixed Anthropic+route-override regression tests and exact-head CI. |
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
