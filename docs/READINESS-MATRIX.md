# Sofia Agent Readiness Matrix

**Snapshot:** 2026-10-18  
**Main commit audited:** c9318d2763239c99802cc789a3460c7aaeeb0d1e  
**Main CI:** [run 39102454154](https://github.com/thanachai10096-arch/Sofia_agent/actions/runs/39102454154) — all six jobs passed on this exact main commit. [CodeQL run 39102454005](https://github.com/thanachai10096-arch/Sofia_agent/actions/runs/39102454005) also passed on this commit. The pinned CodeQL workflow is now enabled on main via PR #207; current-head analysis is tracked separately from alert resolution on unmerged branches.

This matrix distinguishes integrated code and CI evidence from deployment validation. It is not a claim that Sofia Agent is production-ready.

## Readiness estimate

**11 of 15 engineering integration gates are integrated on main (73%).** This is a simple, equally weighted implementation/integration checklist, not a quality score or production-readiness percentage. Live deployment gates remain pending even where code is integrated. A gate being integrated does not imply every deployment scenario has been validated.

### Gate status

| Gate | Status | Evidence / remaining work |
|---|---|---|
| Cross-platform validation, typecheck, tests, build and license | **Pass** | Latest main CI run 39097236970 passed Ubuntu validation, Ubuntu, Windows, macOS, Docker sandbox and browser egress jobs |
| API idempotency survives restart | **Integrated** | PR #202 merged; raw idempotency keys are hashed before persistence; replay state is rehydrated; mismatch returns 409 |
| Durable job claims, leases, heartbeats and worker fencing | **Integrated** | PR #198 merged; cross-process coordination is for a trusted shared local filesystem only |
| Security guardrails and secret redaction | **Integrated** | PR #197 redacts tool outputs/errors/audit payloads; PR #206 enforces nested URL host allowlists, fails closed for opaque Git network operations, and normalizes blocked paths case-insensitively; CI + CodeQL passed on its PR head |
| Learned-skill activation approval | **Integrated** | PR #199 plus security correction #201 merged; missing/declined/throwing approval fails closed |
| Discord user/channel allowlists | **Integrated** | PR #195 merged; both explicit allowlists are required when Discord is configured |
| Discord durable /run, /status, /cancel, /resume and session-scoped context | **Integrated; live validation pending** | PR #200 merged and CI passed; still needs a private Discord app, HTTPS endpoint, persistent storage and a real end-to-end smoke test |
| Strict validation of persisted skill lifecycle state | **Integrated** | PR #203 merged; CI run 39091984457 passed all six jobs, including cross-platform validation and sandbox/browser integration |
| SQLite-backed transcript persistence | **Integrated; opt-in** | PR #214 merged; transcript writes are serialized per session in-process, API IDs are owner-namespaced, idempotency/session metadata are separate; requires Node 22.5+ and is not multi-host storage |
| Explicit user-scoped memory API | **Integrated; opt-in** | PR #217 merged; `memory:read`/`memory:write` scopes, API-key-derived ownership, secret redaction, prompt-injection rejection, bounded retention, per-entry delete and full forget; not automatically injected into model prompts |
| Cron scheduler, bounded subagents, managed MCP and Redis dedupe | **Integrated; deployment validation pending** | PR #216 merged; cron dispatches through durable jobs and requires explicit scopes; subagent work is bounded; MCP servers use operator configuration; Redis dedupe needs a configured Redis client and live multi-worker test |
| Durable shared quota / billing counters across replicas | **Pending** | Verify a shared atomic store and reservation/release behavior before claiming account-wide limits |
| Multi-host job coordination | **Pending** | File locks are not a distributed lock; use a transactional shared queue/store for multiple hosts |
| CodeQL high-severity alerts | **Blocker for PR #175** | PR #207 enables pinned CodeQL scanning on main. Two High alerts were reported on an older PR #175 head; the pre-hashing code was removed on that branch, but a fresh scan of its current head is unavailable. That branch is 150 commits ahead / 16 behind and must not be merged wholesale; verify the findings on a focused current-main PR |
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
- **PR #206:** host allowlist enforcement across nested network inputs and shell command URLs, plus case-insensitive blocked-path checks.
- **PR #207:** pinned CodeQL workflow on main and pull requests.
- **PR #208:** fixed a cross-platform run-store race where scans could delete an active temporary record write.
- **PR #210:** reject duplicate acceptance-criterion IDs.
- **PR #211:** verified advanced-skill handler registry; activation remains fail-closed.
- **PR #212:** API security and architecture boundary documentation.
- **PR #214:** opt-in SQLite transcript persistence and authenticated-owner session scoping.
- **PR #215:** guarded Vercel Discord interactions endpoint; live Vercel/Discord deployment remains unverified.
- **PR #216:** persistent cron API, bounded subagent adapter, managed MCP registry and Redis cross-worker deduplication.
- **PR #217:** explicit user-scoped memory API with independent scopes and delete/forget support.

All listed PRs were merged after their own relevant CI checks passed. Main CI was also rerun after integration; use the main CI link at the top as the current combined-head evidence.

## Release gates still required

1. Recheck the persisted skill lifecycle validation on the final release candidate and retain the regression tests for tampered records.
2. Verify a fresh CodeQL analysis for the updated PR #175 head and resolve any remaining High alerts; do not merge the 150-ahead/16-behind branch wholesale.
3. Perform a live Discord smoke test with a private guild, valid signature verification, strict allowlists, HTTPS and persistent storage.
4. Validate cancellation, resume, restart recovery and duplicate-request behavior in an integrated end-to-end run.
5. Decide and implement the shared transactional storage required for multi-host jobs and globally enforced quotas.
6. Run desktop and real-provider smoke tests on the exact release candidate; keep credentials out of logs and source control.
7. Re-run all CI/security checks on the exact release candidate and update this document with new evidence.
8. Validate SQLite transcript persistence on the supported Node runtime; for multi-host operation, move sessions/jobs/quota state to a shared transactional store before enabling replicas.
9. Configure and smoke-test the Redis deduplicator and managed MCP servers using approved operator configuration; test Redis outage, duplicate delivery and permission-denied cases.
10. Run cron create/list/pause/resume/delete and restart-recovery tests against the actual persistent job store; verify that each API key has only its own schedule visibility.
11. Validate user-memory isolation and retention in the deployment, and only add prompt-context retrieval later through a separate explicit, untrusted-context integration.

**Do not describe Sofia Agent as production-ready until the blocker and deployment-specific gates above are resolved.**
