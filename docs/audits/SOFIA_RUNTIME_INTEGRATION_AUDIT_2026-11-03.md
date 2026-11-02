# Sofia Agent Runtime Integration Audit — 2026-11-03

Status: repository review and implementation plan. This document is additive; it does not authorize merging, deployment, data migration, or changes to production secrets.

## Scope and evidence

Reviewed the repository `thanachai10096-arch/Sofia_agent` on 2026-11-03, using:
- Main base commit: `4189b70ba0dc7068af52f2296a345bed613e8b14`
- Vercel migration / Discord gateway candidate: `3e9966057e5f9bc8e3ddacc929ce702e73a6e4a1`
- Open PRs inspected: #349, #348, #347, #350, #308, #303, #301, #296, #297.
- Files inspected include the Vercel API adapter, Discord Gateway daemon, Telegram webhook, Job Runtime, model configuration, and related PR patches.

This was a source and PR review. No local build, typecheck, unit test, integration test, or production smoke test was executed as part of this review. A green Vercel build is not evidence that Core durability or end-to-end messaging works.

## Executive assessment

Sofia has substantial existing runtime components. The immediate weakness is not a lack of features; it is the gap between component-level implementation and a verified, durable, end-to-end platform.

The Vercel candidate is honest about several limitations: its API adapter caches one Core instance per warm Function, stores state under the temporary filesystem, and explicitly says it is suitable for Preview smoke tests rather than durable production jobs. The migration must not be described as production-ready until the storage and execution boundaries are replaced and tested.

## Findings

### P0 — Cloud state is not durable or shared

Evidence:
- `src/platform/vercel-api-runtime.ts` creates workspace/state under `os.tmpdir()`.
- It uses `FileRunRecordStore` and the normal Agent dependency factory.
- The comments explicitly limit this adapter to Preview smoke tests.
- The Job Runtime's `FileJobStateStore` documents itself as local/single-host and requires atomic shared storage for multi-host workers.

Impact:
- Warm instances may not share run, job, session, idempotency, usage, or memory state.
- Temporary files can disappear between invocations or instances.
- A successful HTTP response cannot prove restart recovery.

Required direction:
- Define storage ports for jobs, run records, sessions, idempotency, usage/quotas, memory, and cron.
- Implement a transactional shared adapter (Postgres is the current target in the migration plan).
- Add schema/versioning, owner scoping, transaction boundaries, uniqueness constraints, and migration/rollback tests.
- Keep file-backed stores for local development and single-process use.

### P0 — Long-running work needs a durable execution owner

Evidence:
- The candidate API adapter dispatches through the existing in-process API server.
- The current Job Runtime owns local execution and file-backed state.
- The Vercel migration plan itself calls for a durable workflow/queue layer before production.

Impact:
- A Function or daemon restart can interrupt work.
- Process-local timers and in-memory maps cannot provide distributed scheduling, deduplication, or exactly-once effects.
- A request timeout can leave ambiguous outcomes unless job acceptance and idempotency are durable.

Required direction:
- Keep the existing Brain/Executor as the execution engine; do not create a second Agent Runtime.
- Add a durable orchestration adapter around it, with claim/lease fencing, heartbeat, checkpoint, cancellation, retry policy, resume, and terminal notification.
- Use an outbox or equivalent transactional delivery record so completion notifications are not lost or duplicated.
- Test crash/restart at every transition: accepted, claimed, checkpointed, tool side-effect started, completed, notification pending, notification delivered.

### P0 — Discord Gateway needs stricter boundary validation and complete lifecycle behavior

Evidence:
- The daemon reads `SOFIA_API_BASE_URL`, constructs API URLs from it, and calls the Sofia API.
- The Discord Gateway candidate checks user and channel allowlists before dispatch.
- The worker uses process-local `seen`, `inflight`, and pending-message collections.
- The current task path submits a run and extracts a limited set of response fields.

Impact:
- Gateway restarts can forget in-flight/deduplication state.
- A configured upstream URL is a security boundary and must be validated as a strict HTTPS origin with an explicit host allowlist, not merely trusted because it parses.
- A queued/accepted response is not the same as a completed result; the channel needs durable job status and completion delivery.
- Response schema drift can produce a generic fallback instead of the actual final answer.

Required direction:
- Keep the explicit user + channel allowlists and owner identity binding.
- Validate the configured API origin against an explicit deployment allowlist; reject unexpected ports, credentials, path, query, fragment, and non-HTTPS protocols.
- Move dedupe and message/job correlation to shared durable storage.
- Define one normalized API response contract for accepted jobs, running jobs, completed results, and errors.
- Add tests for normal text, `/run`, duplicate gateway events, unauthorized users/channels, empty content, rate limits, timeout, API errors, restart recovery, and outbound Discord delivery.
- Do not log message bodies, tokens, API keys, or private task content. Existing diagnostic logging of message excerpts should be removed or redacted before general use.

### P1 — Telegram webhook is an ingress adapter, not yet a complete chat channel

Evidence:
- `api/telegram/webhook.ts` validates the Telegram webhook secret and user/chat allowlists.
- It forwards the task to an API endpoint and sends an immediate accepted/job-ID acknowledgement.
- Its comments state completion delivery is outside the ingress endpoint and that upstream idempotency must be shared.

Impact:
- Users can receive an acknowledgement without receiving the final answer.
- If upstream state is process-local, Telegram retries may create duplicate logical runs after restarts.
- A webhook should acknowledge only after durable acceptance, then rely on a durable notification path.

Required direction:
- Reuse the same shared Job/Session/Outbox services as Discord.
- Persist update ID idempotency before acknowledging Telegram.
- Send accepted, progress, and completed messages through a durable notifier.
- Test webhook retries, duplicate update IDs, secret mismatch, allowlist denial, API outage, and bot delivery failure.

### P1 — Model configuration and credential separation must be consolidated

Evidence:
- PR #347 separates Sofia API authentication (`SOFIA_API_KEY`) from the custom model credential (`SOFIA_MODEL_API_KEY`) while retaining a legacy alias.
- PR #349 adds Kimi and DeepSeek provider environment examples.
- Provider configuration remains server-side and server-wide in the inspected Web Chat design.

Required direction:
- Merge provider configuration through one validated config schema.
- Preserve backward compatibility for legacy aliases with explicit deprecation behavior.
- Never let API authentication keys be used as provider credentials.
- Add provider contract tests for text, structured JSON, streaming, tool calls, timeout, retry, rate-limit, malformed response, and capability mismatch.
- Distinguish provider/model discovery from a successful live provider call.

### P1 — Memory and model preferences are not yet cloud-safe by default

Evidence:
- PR #296 adds owner-scoped memory context to synchronous API runs.
- PR #301 carries owner-scoped memory into durable API jobs.
- PR #297 stores model preferences in a file-backed store keyed by derived API-key identity.
- The Vercel adapter uses temporary local storage.

Impact:
- Owner-scoped retrieval is a good boundary, but file-backed preferences/memory are not shared across Function instances.
- Key rotation changes the derived identity and may orphan preferences.
- Memory injection must remain bounded, explicitly untrusted, and unable to change tool permissions.

Required direction:
- Use shared transactional stores and stable principal IDs rather than API-key-derived identity for long-term user preferences.
- Keep API-key-to-principal mapping scoped and revocable.
- Preserve memory as untrusted reference context; enforce current request, system policy, and tool authorization independently.
- Add cross-user isolation and key-rotation tests.

### P1 — Verified Learning must be gated by reproducible evidence

Evidence:
- PR #308 adds a substantial Verified Learning Loop, SQLite stores, reconciliation, repair, and lifecycle promotion logic.
- The repository already has skills and approval boundaries.

Required direction:
- Do not promote generated skills based only on model self-evaluation.
- Require reproducible cases, regression repeats, security review, provenance, rollback, and a minimum quality gain.
- Keep learned artifacts quarantined until approval and policy checks pass.
- Test interruption and recovery during each learning lifecycle stage.

### P1 — Static analysis findings require adjudication before release

Evidence:
- GitHub CodeQL review comments on PR #349 report URL/SSRF-related findings in the Telegram URL validation tests and Discord Gateway worker, plus a user-controlled timer finding.
- The worker constructs a request URL from configured environment data and consumes a Gateway-provided heartbeat interval.

Required direction:
- Review each alert against the exact dataflow and document true-positive/false-positive rationale.
- Prefer strict URL origin allowlisting and bounded numeric timer validation.
- Do not suppress alerts without tests that demonstrate the boundary.
- Require CodeQL and dependency/security checks on the exact release commit.

## PR integration order (do not merge automatically)

1. #347 — credential separation. Review config compatibility and deployment environment impact.
2. #296 and #301 — memory context integration. Verify they do not conflict and both preserve owner scoping.
3. #297 — model preferences. Replace file-backed cloud persistence before claiming multi-instance support.
4. #303 — Web Chat. Keep same-origin, HttpOnly cookie, CSRF/origin validation, and server-side credentials; replace process-memory sessions before multi-instance use.
5. #308 — Verified Learning. Review separately due its broad surface area and promotion/security implications.
6. #349 — Vercel migration. Treat as architecture/Preview candidate until shared storage and durable execution are real.
7. #348 — Discord Gateway. Integrate only after the normalized job API and durable notification contract are defined.
8. #350 — health endpoint. Keep its degraded/not-ready semantics; it must not be used as a readiness badge.

This is a dependency-oriented review order, not approval to merge. Resolve conflicts and rerun checks after each integration.

## Release acceptance gates

A release candidate is not ready until all applicable checks pass on the exact commit:

- [ ] typecheck and build
- [ ] complete unit/regression suite
- [ ] security checks including CodeQL and dependency audit
- [ ] durable shared-store concurrency and owner-isolation tests
- [ ] restart/recovery tests for jobs, sessions, cron, idempotency, and notifications
- [ ] Discord normal chat + `/run` end-to-end, including unauthorized identity/channel cases
- [ ] Telegram webhook + final-result delivery end-to-end
- [ ] model provider contract and live smoke tests for each configured provider
- [ ] Web Chat authentication, origin/CSRF, cookie, and multi-instance tests
- [ ] learning/skill promotion rollback and provenance tests
- [ ] preview soak test and observability review
- [ ] explicit production approval and rollback plan

## Non-goals and safety constraints

- Do not replace the existing Sofia Brain/Executor with a parallel runtime.
- Do not remove local file-backed stores; keep them as supported local adapters.
- Do not merge open PRs automatically.
- Do not modify production secrets, domains, or deployment targets as part of this audit.
- Do not claim tests, readiness, or provider compatibility without exact evidence.
