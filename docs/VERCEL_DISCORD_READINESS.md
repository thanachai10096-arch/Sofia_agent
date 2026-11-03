# Vercel + Discord deployment readiness

## Architecture

Sofia Preview is hosted on Vercel only:

`Discord Interactions → Vercel /api/discord/interactions → Vercel /api/v1/* → Sofia Agent Core → DeepSeek`

No Railway service, external Sofia API host, or upstream Railway URL is part of this design.

## Current implementation

- `api/health.ts` is a deployment smoke-test endpoint. It confirms Vercel function routing only; it intentionally does not claim the agent Core is ready.
- `api/v1/[...path].ts` adapts Vercel Node Function requests to Sofia's existing `createSofiaApi` router.
- `src/platform/vercel-api-runtime.ts` lazily creates the Sofia Agent dependencies and reuses one Core instance per warm function instance.
- `api/discord/interactions.ts` verifies Discord's Ed25519 signature against the exact raw bytes, answers PING, enforces both user and channel allowlists, and calls the same Vercel deployment's `/api/v1/agent/runs` endpoint.
- The Discord route uses `SOFIA_INTERNAL_API_KEY`; it does not use `SOFIA_UPSTREAM_API_KEY` or an external API host.
- `VERCEL_URL` is used to resolve the current Preview deployment host. `SOFIA_API_BASE_URL` remains an optional local override only and should be unset on Vercel.
- `public/index.html` exists as the static output directory required by the project's framework-less Vercel configuration.

## Preview-only environment variables

Set these only on the `docs/vercel-cloud-first-migration` Preview branch:

- `DISCORD_PUBLIC_KEY` — Discord application's public key.
- `DISCORD_ALLOWED_USER_IDS` — explicit comma-separated user allowlist.
- `DISCORD_ALLOWED_CHANNEL_IDS` — explicit comma-separated channel allowlist.
- `SOFIA_INTERNAL_API_KEY` — server-to-server key used only between the Discord route and Sofia Core.
- `SOFIA_CAPABILITY_SECRET` — capability security secret required by production-mode policy.
- `SOFIA_AUDIT_SECRET` — encryption secret for security audit records.
- `SOFIA_MODEL_PROVIDER=deepseek`, `DEEPSEEK_API_KEY`, and `DEEPSEEK_BASE_URL` — DeepSeek provider configuration.

Never expose these values to browser code or commit them. Do not decrypt or print secrets in logs.

## Important runtime limitation

The current Core adapter uses the Vercel function's writable temporary directory for file-backed state. Vercel temporary storage is not durable across cold starts, deployments, or independent function instances. The current file-backed job/session/memory stores therefore do **not** satisfy production durability or cross-instance coordination.

Long-running agent execution also cannot be assumed to continue after a serverless response completes. Before production use, move run/job state, idempotency, quotas, sessions, and memory to a shared transactional store, and execute long-running jobs through a Vercel-supported durable workflow/queue mechanism. Do not claim durable autonomous execution until those adapters and restart/concurrency tests exist.

## Acceptance checklist

- [x] Vercel project configured for framework-less static output plus Node API functions.
- [x] Preview deployment built successfully.
- [x] `GET /` returns HTTP 200.
- [x] `GET /api/health` returns HTTP 200 and explicitly reports Core/storage/execution as not connected/not configured.
- [x] `GET /api/discord/interactions` returns HTTP 405 with `Allow: POST`.
- [ ] `GET /api/v1/health` returns HTTP 200 from the in-process Sofia Core.
- [ ] DeepSeek provider call succeeds from a real Preview agent run.
- [ ] Discord PING succeeds using a real signed request.
- [ ] Invalid/stale Discord signatures fail closed.
- [ ] Allowed `/run` interaction starts exactly one Sofia run.
- [ ] Verify actual run completion and Discord follow-up delivery.
- [ ] Replace temporary file-backed state with shared durable storage and durable workflow execution.
- [ ] Re-run typecheck, build, tests, and security checks on the exact release candidate.
- [ ] Review and approve production separately; no production deployment is authorized by this checklist.
