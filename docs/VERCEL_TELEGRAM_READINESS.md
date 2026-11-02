# Vercel + Telegram deployment readiness

## Status

A Vercel Node Function exists at `api/telegram/webhook.ts` on this PR branch. It validates Telegram's `X-Telegram-Bot-Api-Secret-Token` header using a constant-time comparison, limits raw request bodies to 64 KiB, requires explicit user and chat allowlists, ignores unsupported update types, and forwards accepted text messages to the configured Sofia HTTPS API using an update-scoped idempotency key.

**This is a Preview-stage channel ingress adapter, not a complete Vercel-hosted Sofia Core deployment.** It does not run Sofia Core inside the Function, does not make local file stores durable, and does not independently run long tasks or deliver final job results. It currently sends an immediate “accepted” message after the upstream API accepts the job. Completion delivery requires the durable worker/callback workstream.

## Route and behavior

- Route: `POST /api/telegram/webhook`.
- Request body parsing is disabled; verification and size checks use raw bytes.
- Invalid webhook secrets are rejected with HTTP 401.
- Both `TELEGRAM_ALLOWED_USER_IDS` and `TELEGRAM_ALLOWED_CHAT_IDS` are mandatory. Empty allowlists deny all messages.
- Only normal text messages are dispatched in this first version.
- A stable key derived from Telegram `update_id` is sent as `Idempotency-Key`.
- The adapter calls `POST /v1/agent/runs` with `async: true` on the separately hosted Sofia API.
- Transient upstream failures (`408`, `425`, `429`, and `5xx`) return a retryable HTTP `503` to Telegram; permanent upstream rejections are acknowledged without retry loops. A malformed successful upstream response returns `502` because acceptance is ambiguous.
- The upstream API key is `SOFIA_UPSTREAM_API_KEY`, deliberately separate from the model-provider `SOFIA_API_KEY`.
- Never expose the bot token, webhook secret, or upstream API key to a browser/client.

## Preview environment variables

Set these in Vercel Project Settings → Environment Variables, Preview only:

- `TELEGRAM_BOT_TOKEN` — Telegram bot token.
- `TELEGRAM_WEBHOOK_SECRET` — random 32+ character secret containing only letters, digits, underscore, and hyphen.
- `TELEGRAM_ALLOWED_USER_IDS` — comma-separated Telegram numeric user IDs.
- `TELEGRAM_ALLOWED_CHAT_IDS` — comma-separated chat IDs; group/supergroup IDs may be negative.
- `SOFIA_API_BASE_URL` — root HTTPS URL of the currently hosted Sofia API.
- `SOFIA_UPSTREAM_API_KEY` — narrowly scoped API key for starting runs on that API.

Do not use `SOFIA_API_KEY` for the upstream API credential: that name is already used by Sofia's model-provider configuration.

## Configure Telegram webhook after Preview deployment

Use the exact deployed Preview URL shown by Vercel; do not guess it. Call Telegram's `setWebhook` method with:

- `url`: `https://<verified-preview-host>/api/telegram/webhook`
- `secret_token`: the same value configured as `TELEGRAM_WEBHOOK_SECRET`
- `allowed_updates`: `["message"]`
- `drop_pending_updates`: `false`

Do not put the bot token or webhook secret in a public issue, chat, screenshot, source file, or commit. The Telegram Bot API URL itself contains the bot token, so use a private trusted method to call `setWebhook`.

## Acceptance checks

- [ ] `npm run typecheck`, `npm test`, and `npm run build` pass on the exact Preview commit.
- [ ] Vercel Preview exposes `/api/telegram/webhook`.
- [ ] Missing configuration fails closed.
- [ ] Invalid secret, malformed JSON, oversized body, and non-POST requests are rejected.
- [ ] Unallowlisted user or chat cannot start a job.
- [ ] Replayed `update_id` does not create a second job under concurrent delivery and upstream restart.
- [ ] Valid text message is accepted and produces a job ID.
- [ ] Final job completion is delivered to the originating chat through a durable worker/outbox, not by relying on this request remaining alive.
- [ ] Session, job state, checkpoints, idempotency, quotas, and memory use shared durable storage before production.
- [ ] The actual Sofia Core runs through the Vercel cloud execution architecture, not an undocumented external API dependency, before claiming Vercel-only hosting.

## Known limitations

1. This endpoint currently proxies to `SOFIA_API_BASE_URL`; it does not execute Sofia Core inside Vercel.
2. The current upstream API's idempotency/run state is not yet a shared atomic store across instances.
3. There is no completion callback/outbox in this adapter yet. The immediate Telegram message confirms acceptance only, not completion.
4. Do not enable this endpoint for Production until durable storage, durable execution, completion delivery, and live end-to-end checks pass.
