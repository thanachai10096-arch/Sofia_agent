# Sofia Agent Readiness Matrix

**Snapshot:** 2026-10-18  
**Main commit audited:** 771836910305917f73b1c6071c04f5a773c313d9  
**Main CI:** [run 39092077515](https://github.com/thanachai10096-arch/Sofia_agent/actions/runs/39092077515) — all six jobs passed on this exact main commit.

This matrix distinguishes integrated code and CI evidence from deployment validation. It is not a claim that Sofia Agent is production-ready.

## Readiness estimate

**8 of 12 engineering integration gates are present on main (67%).** This is a simple, equally weighted integration checklist, not a quality score or production-readiness percentage. A gate being integrated does not imply every deployment scenario has been validated.

### Gate status

| Gate | Status | Evidence / remaining work |
|---|---|---|
| Cross-platform validation, typecheck, tests, build and license | **Pass** | Latest main CI run 39091932727 passed Ubuntu validation, Ubuntu, Windows, macOS, Docker sandbox and browser egress jobs |
| API idempotency survives restart | **Integrated** | PR #202 merged; raw idempotency keys are hashed before persistence; replay state is rehydrated; mismatch returns 409 |
| Durable job claims, leases, heartbeats and worker fencing | **Integrated** | PR #198 merged; cross-process coordination is for a trusted shared local filesystem only |
| Tool-output and trace secret redaction | **Integrated** | PR #197 merged; tool outputs, errors and audit payloads are redacted |
| Learned-skill activation approval | **Integrated** | PR #199 plus security correction #201 merged; missing/declined/throwing approval fails closed |
| Discord user/channel allowlists | **Integrated** | PR #195 merged; both explicit allowlists are required when Discord is configured |
| Discord durable /run, /status, /cancel, /resume and session-scoped context | **Integrated; live validation pending** | PR #200 merged and CI passed; still needs a private Discord app, HTTPS endpoint, persistent storage and a real end-to-end smoke test |
| Strict validation of persisted skill lifecycle state | **Integrated** | PR #203 merged; CI run 39091984457 passed all six jobs, including cross-platform validation and sandbox/browser integration |
| Durable shared quota / billing counters across replicas | **Pending** | Verify a shared atomic store and reservation/release behavior before claiming account-wide limits |
| Multi-host job coordination | **Pending** | File locks are not a distributed lock; use a transactional shared queue/store for multiple hosts |
| CodeQL high-severity alerts | **Blocker** | PR #175's CodeQL check reported two new high-severity alerts; identify and resolve the alerts before merging that PR or claiming the audit is clean |
| Live production E2E, including desktop and deployed integrations | **Pending** | CI does not prove live provider, Discord, desktop, secrets-management or deployment behavior |

## Recently integrated changes

- **PR #194:** shared concurrency limit across subagent batches.
- **PR #195:** explicit Discord user and channel allowlists.
- **PR #196:** skill lifecycle avoids overwriting unmanaged skills and validates the restore set before platform mutation.
- **PR #197:** secret redaction for tool outputs, errors and audit traces.
- **PR #199:** learned-skill lifecycle approval integration.
- **PR #198:** durable job claims, leases, recovery and worker fencing.
- **PR #200:** Discord durable jobs and bounded, user/channel-scoped historical context.
- **PR #201:** fail-closed learned-skill activation when approval is absent.
- **PR #202:** hashed, restart-safe API idempotency.
- **PR #203:** strict validation of persisted skill packages, provenance, evaluation evidence and active pointers.

All listed PRs were merged after their own relevant CI checks passed. Main CI was also rerun after integration; use the main CI link at the top as the current combined-head evidence.

## Release gates still required

1. Recheck the persisted skill lifecycle validation on the final release candidate and retain the regression tests for tampered records.
2. Resolve the two high-severity CodeQL alerts reported on PR #175.
3. Perform a live Discord smoke test with a private guild, valid signature verification, strict allowlists, HTTPS and persistent storage.
4. Validate cancellation, resume, restart recovery and duplicate-request behavior in an integrated end-to-end run.
5. Decide and implement the shared transactional storage required for multi-host jobs and globally enforced quotas.
6. Run desktop and real-provider smoke tests on the exact release candidate; keep credentials out of logs and source control.
7. Re-run all CI/security checks on the exact release candidate and update this document with new evidence.

**Do not describe Sofia Agent as production-ready until the blocker and deployment-specific gates above are resolved.**
