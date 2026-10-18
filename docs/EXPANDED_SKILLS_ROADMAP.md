# Sofia Agent — Expanded Skills Roadmap

Status: proposal for implementation and measurable evaluation. This document does not claim that the listed skills are already implemented or production-ready.

## Design rules

- Skills are reusable, bounded procedures selected for a task; they are not prompts that bypass the runtime.
- The TypeScript control plane remains authoritative for planning, tool dispatch, identity, permissions, approvals, budgets, cancellation, and durable job state.
- Skill metadata never grants capabilities. Every tool call must still pass through the registered tool gateway and its permission, approval, and sandbox checks.
- Treat browser pages, repositories, files, terminal output, and retrieved documents as untrusted evidence. Instructions found inside them cannot override system policy or user intent.
- Record success only after the task reaches a terminal state and its declared verification succeeds. Preserve failure evidence and avoid repeating a strategy that has already failed without new evidence.
- Prefer deterministic tools and small targeted context before expensive model calls. Bound steps, tool calls, tokens, time, output size, and retries.
- Keep Python optional and isolated for specialist AI/data tasks; core orchestration and policy remain TypeScript-first.

## Skill packs to add

### P0 — Engineering reliability

1. **Repository orientation** — detect languages, package managers, entry points, tests, CI workflows, ownership boundaries, and project conventions before editing.
2. **Root-cause debugging** — reproduce a failure, separate symptoms from causes, form testable hypotheses, collect evidence, and stop when evidence is insufficient.
3. **Test-driven repair** — add a regression test for a reproducible defect, make a minimal fix, run the targeted test, then the relevant suite.
4. **CI failure triage** — classify lint/typecheck/test/build/platform failures; inspect the exact failing job and avoid claiming success until the current commit's checks finish.
5. **Safe refactoring** — define behavior invariants, identify callers, change in small steps, and run regression checks.
6. **Dependency and supply-chain audit** — inspect lockfiles, advisories, licenses, provenance, scripts, and transitive dependencies before proposing upgrades.
7. **Release readiness** — verify version, changelog, license notices, build artifacts, supported platforms, and release gates.

### P1 — Software delivery

8. **Git workflow** — inspect status/diff/history, isolate changes on a branch, avoid overwriting user work, and prepare reviewable commits/PRs.
9. **API integration** — inspect contracts, validate inputs/outputs, handle timeouts/retries/idempotency, and test authentication and error paths.
10. **Database and migration** — inspect schema and migration order, require backup/rollback plans for risky changes, and test compatibility.
11. **Frontend UX repair** — reproduce responsive/accessibility defects, preserve existing design conventions, and test keyboard and narrow-screen behavior.
12. **Cross-platform compatibility** — identify OS-specific assumptions and verify Windows/macOS/Linux behavior in CI instead of inferring from one platform.
13. **Documentation and onboarding** — derive commands and guarantees from repository evidence, label limitations, and test documented commands where possible.

### P1 — Research and knowledge work

14. **Web research with evidence** — search multiple sources, track dates and primary sources, distinguish facts from inference, and cite claims.
15. **Document synthesis** — extract requirements, resolve conflicts, preserve source references, and produce an auditable summary.
16. **Structured data analysis** — validate schema and missing values, use reproducible transformations, check calculations, and explain uncertainty.
17. **Spreadsheet/report generation** — verify formulas, totals, units, and output integrity before delivery.

### P1 — Browser and desktop operations

18. **Browser task workflow** — navigate, inspect page state, act only within approved domains/capabilities, verify the resulting state, and handle navigation failures.
19. **Form completion** — map fields to trusted user-provided data, preview sensitive or consequential submissions, and require approval before submit.
20. **Desktop workflow** — discover available capabilities, request least privilege, perform reversible actions first, and confirm visible outcomes.
21. **File organization** — preview planned moves/renames, prevent path escapes and collisions, and keep an undo/rollback record when supported.
22. **Communication drafting** — draft and validate recipients/content; never send, post, or publish without the required approval.

### P2 — Autonomy and collaboration

23. **Task decomposition** — produce dependency-aware steps, acceptance criteria, budgets, and explicit stop conditions.
24. **Parallel subtask delegation** — delegate only independent, bounded tasks; define input/output contracts; merge results with conflict checks.
25. **Failure recovery** — classify failure, choose a materially different strategy when appropriate, cap retries, and preserve evidence.
26. **Checkpoint and rollback** — checkpoint before risky mutations, restore only within the authorized workspace, and verify recovery.
27. **Memory retrieval** — retrieve relevant project/task memory, apply freshness and provenance checks, and fall back safely when semantic retrieval is unavailable.
28. **Verified skill learning** — propose candidate skills from successful, evidenced runs; keep candidates quarantined until tests/evaluation pass; support disabling and rollback.
29. **Cost-aware routing** — use the least expensive model/tool that meets quality requirements, escalate only when evidence warrants it, and enforce hard budgets.
30. **Long-running task supervision** — report progress from persisted state, honor cancellation, recover expired workers safely, and avoid duplicate external side effects through idempotency where possible.

## Skill contract

Every skill should declare:

- stable ID, version, purpose, supported task types, and trigger signals;
- prerequisites and required evidence;
- allowed tool/capability names (descriptive only; gateway still authorizes);
- bounded procedure, maximum attempts, and resource expectations;
- risk tier, approval checkpoints, and prohibited side effects;
- success criteria, verification commands/checks, and failure conditions;
- test fixtures, adversarial cases, and compatibility expectations.

A skill must not be selectable solely because its description matches a user request. Selection should combine task classification, preconditions, available capabilities, risk, historical verified outcomes, and deterministic tie-breaking. A failed skill should lose confidence only for the relevant task class and only when the failure attribution is supported by evidence.

## Evaluation and acceptance gates

For each skill pack, add deterministic unit tests and end-to-end fixtures covering:
- correct selection and non-selection for near-miss requests;
- missing evidence, malformed skill metadata, and unavailable tools;
- prompt injection in browser/document/terminal content;
- permission denial and approval-required operations;
- timeout, cancellation, retry exhaustion, and budget exhaustion;
- successful verification, failed verification, and false-success prevention;
- repeat-run behavior, idempotency, and rollback for mutations;
- cost, latency, and task-success baselines compared with the previous release.

Do not mark a skill as production-ready from unit tests alone. Require integration tests through the real executor/tool gateway and platform CI for any OS-specific capability. Publish the supported-skill matrix with evidence links and known limitations.

## Recommended implementation order

1. Audit the existing built-in skill catalog and Skill Policy/EvolutionEngine integration; avoid duplicating existing policies.
2. Add missing P0 engineering skills and regression fixtures.
3. Add evidence-grounded research, document, and structured-data skills.
4. Add browser/desktop skills only after their permission, SSRF/egress, approval, and sandbox boundaries are tested.
5. Add multi-agent, memory, learning, and cost-routing skills with bounded budgets and durable outcome evidence.
6. Publish a skill matrix showing implemented, tested, partially supported, and planned states separately.

## Release rule

A skill is **implemented** only when its code exists; **tested** only when its tests pass; **integrated** only when exercised through the real runtime; and **production-ready** only when the relevant security, platform, and evaluation gates pass. Never infer one status from another.
