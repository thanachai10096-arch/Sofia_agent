# Vercel owner-first rollout

Status: active migration plan for the project owner's private deployment. This is not a multi-user SaaS rollout and does not authorize Production cutover.

## Product scope

The first Vercel deployment is for the project owner only. Do not build user signup, tenant provisioning, per-user billing, self-service Vercel linking, or public API-key issuance as prerequisites for this phase.

Use one private owner identity and one owner-controlled Vercel project. Keep owner data, API credentials, sessions, memory, schedules, and artifacts scoped to that identity. Keep the existing authenticated API boundary and least-privilege scopes; a single-owner rollout is not permission to remove authentication.

Multi-user support is a later phase. It must be added only after the owner's deployment is stable, with explicit tenant isolation, key lifecycle, quotas, retention, and deletion semantics.

## Current verified state

- Vercel project: `i888`, connected to `thanachai10096-arch/Sofia_agent`.
- Current migration branch: `docs/vercel-cloud-first-migration`.
- Vercel Preview deployments have reached `READY`; that proves build/deployment completion only.
- `api/health.ts` is an isolated function smoke endpoint. A successful health response proves Vercel routing only, not Sofia Core readiness.
- `api/telegram/webhook.ts` and `api/discord/interactions.ts` are ingress adapters that forward accepted work to an HTTPS Sofia API. They do not host the Core or provide durable execution.
- The current long-running `src/api/entrypoint.ts` must not be imported by a Vercel Function: it starts an HTTP listener, local stores, optional polling, and process-owned timers.
- The Vercel project environment-variable listing returned no configured variables at the time of this audit. Do not assume credentials or provider connections exist.
- No database provider/region/retention policy has been approved. Do not create a database or migrate personal data without explicit approval.

## Owner-first implementation sequence

### O0 — Private Preview foundation

- Keep the existing Vercel project and repository connection.
- Pin the project Node runtime explicitly to Node.js 22.x in `package.json`; do not rely on a conflicting dashboard default.
- Keep the deployment target on Preview while health, function routing, and build behavior are verified.
- Verify `GET /api/health` and `POST /api/health` from a real client. Record HTTP status and response body without exposing secrets.
- Keep Preview and Production environment variables separate. Do not set Production secrets during this phase.

### O1 — Owner-only Sofia API boundary

- Create a Vercel-compatible request handler/composition root that does not call `listen()`, start polling, or own a process timer.
- Preserve the existing Sofia Core, model router, tool registry, security controller, approval policy, and execution lifecycle. Do not create a second Brain or channel-specific runtime.
- Authenticate the owner using a server-side secret. Never place a master API key in browser code, Telegram, Discord, or a mobile app bundle.
- Keep owner scopes explicit. Start with the minimum scopes needed for chat/run/status; do not grant desktop, shell, filesystem, or admin scopes unless the relevant host capability is actually configured and tested.
- Keep Telegram and Discord ingress disabled until their Preview secrets and owner allowlists are configured and the upstream execution path is durable.

### O2 — Durable state and execution

Before using Vercel Functions for long-running Agent work, provide shared durable storage and a durable workflow/worker path. Do not use function memory, `/tmp`, detached promises, `setInterval`, or a warm instance as the source of truth.

Required owner data domains:
- job records, leases/fencing, checkpoints, cancellation, and completion outbox;
- run records, owner-scoped idempotency, request fingerprints, and usage reservations;
- sessions and conversation context;
- user memory and project memory, retaining prompt-injection fencing and secret redaction;
- cron schedules, execution history, retry and misfire state;
- provider event deduplication and delivery receipts.

Keep existing file-backed stores for local/single-host compatibility. Add cloud adapters behind additive interfaces and verify transaction/concurrency behavior before switching the owner's Preview deployment. Define backup, restore, retention, export, and deletion behavior before storing personal conversations or memory in a hosted database.

### O3 — Owner channel acceptance

- Telegram webhook: verify the secret header, raw input size, immutable owner user/chat allowlists, replay/idempotency, and final result delivery.
- Discord interactions: verify the Ed25519 signature and timestamp, explicit owner user/channel allowlists, fast acknowledgement, replay/idempotency, and final result delivery.
- Ordinary text should be natural-language tasks on enabled/allowlisted chat channels; do not require `/run` for normal conversation where the provider protocol permits message events.
- Discord slash-command HTTP interactions alone do not provide arbitrary message events. Natural Discord chat requires a separately hosted Gateway worker or another supported event transport; do not start a persistent Gateway socket inside a Vercel Function.
- Run live tests with the owner's private accounts only. Do not invite public users during this phase.

### O4 — Owner Production gate

Production remains disabled until all are true:
- Preview health route is externally verified.
- Exact deployed commit has passing license, typecheck, test, build, and security checks.
- Owner API cold-start and repeat-invocation tests pass.
- Job state, memory, sessions, schedules, idempotency, and completion delivery survive function termination and deployment replacement.
- Telegram and Discord live tests pass for both allowed and denied identities.
- Security, privacy, backup/restore, retention, cancellation, and recovery procedures are documented and tested.
- Cost and Vercel plan limits are measured for the owner's actual workload.

Do not switch DNS, delete Railway/local rollback paths, or promote a Preview deployment merely because its build is READY.

## Environment-variable handling

Configure values only in Vercel Project Settings → Environment Variables, scoped to Preview first. Never commit values or paste secrets into chat.

Ingress adapters currently expect:
- `SOFIA_API_BASE_URL`: HTTPS URL of the Sofia API that actually executes tasks.
- `SOFIA_UPSTREAM_API_KEY`: a dedicated server-side Sofia API credential with only the required run scope. It is not a model-provider key.
- Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_ALLOWED_CHAT_IDS`.
- Discord: `DISCORD_PUBLIC_KEY`, `DISCORD_ALLOWED_USER_IDS`, `DISCORD_ALLOWED_CHANNEL_IDS`, optional `DISCORD_COMMAND_NAME`.

These variables alone do not make Sofia Core run on Vercel. Do not configure them until the upstream API URL is real, HTTPS, durable, and owner-controlled. The Core's model-provider credentials are separate and must remain server-side in the Core execution environment.

## Later multi-user phase (out of scope now)

Only after O4:
- add tenant records and tenant-scoped API key lifecycle;
- enforce tenant isolation in every store, job, channel, workspace, and artifact;
- add per-tenant provider/model preferences, quotas, rate limits, billing, export/deletion, and audit controls;
- offer self-service onboarding and deployment options.

No part of the owner-first phase should depend on these later features.
