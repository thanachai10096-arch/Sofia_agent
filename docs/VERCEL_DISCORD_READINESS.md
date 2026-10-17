# Vercel + Discord deployment readiness

## Status

**Not production-ready on Vercel yet.** The repository has Discord signature verification and a Node HTTP route, but that is not by itself a Vercel Functions entry point. Do not configure the Discord Developer Portal to point at a guessed URL or deploy this integration until the serverless lifecycle and persistence requirements below are addressed.

## What already exists

- `createDiscordInteractionTransport()` verifies Discord Ed25519 signatures against the exact raw request bytes.
- `handleDiscordInteractionHttpRequest()` enforces POST-only requests and a bounded raw body.
- `createSofiaApi()` can mount the optional route at `/v1/integrations/discord/interactions` when a transport is supplied.
- `createSofiaMessagingHandler()` routes explicit `/run <task>` commands through Sofia's existing authorization and idempotency contract.
- Messaging is opt-in and unknown users must be denied by the injected policy.

## Why a direct Vercel wrapper is unsafe without more work

1. The current API is a Node `createServer` composition, not a Vercel Functions handler. No Vercel entry point or `vercel.json` was found on `main`.
2. The Discord transport has an in-memory active flag, callback, abort controller, and pending interaction-token map. A serverless entry point must initialize this lifecycle correctly for each invocation and complete the Discord response work within the platform's invocation lifetime. Starting a transport in one invocation and expecting it to remain active in another is not valid.
3. The default run, memory, checkpoint, job, and message-deduplication stores include file/process-local implementations. Vercel function instances are not a durable shared filesystem or a single long-lived process. A production deployment needs reviewed durable/shared storage and concurrency-safe deduplication.
4. Sofia's local workspace/process tools are not automatically safe or available in a serverless function. The serverless composition must explicitly limit capabilities and use an approved remote execution/workspace backend; it must not silently enable local terminal or workspace access.
5. Discord requires a prompt initial interaction response. The handler must be tested for the three-second acknowledgement deadline, background continuation, token expiry, and retries on the actual Vercel runtime.

## Required implementation before deployment

- Add a real Vercel Function entry point that accepts the raw request body without JSON reserialization and calls the existing signature-verification logic.
- Build a serverless-specific composition with explicit, least-privilege tool capabilities; do not blindly use the local factory.
- Use durable stores for deduplication, run status, and any state that must survive a cold start or be shared across instances. Ensure idempotency is atomic across concurrent invocations.
- Keep `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, Sofia API credentials, and database credentials in Vercel server-side environment variables only. Never prefix secrets with `NEXT_PUBLIC_` and never commit them.
- Keep the bot disabled until an explicit allowlist/access policy is wired and tested. Preserve the existing command handler's authorization check and do not double-claim the same deduplication key.
- Register the Discord `/run` application command with a `task` string option using a separate controlled setup step. Do not invent the deployed interaction URL.
- Add automated tests for valid/invalid/stale signatures, malformed and oversized bodies, unauthorized users, duplicate/replayed interactions, cold starts, and concurrent invocations.
- Run `npm run typecheck`, `npm run build`, and `npm test` on the PR head, then perform a staging-only live Discord smoke test before production approval.

## Safe environment variable names

Use server-side Vercel Environment Variables (Production/Preview/Development as appropriate):

- `DISCORD_PUBLIC_KEY` — Discord application's public key (not the bot token).
- `DISCORD_BOT_TOKEN` — bot token, server-only.
- `SOFIA_API_BASE_URL` — actual HTTPS base URL of the separately hosted Sofia API, if using the SDK bridge.
- `SOFIA_API_KEY` — narrowly scoped server-side key for the SDK bridge.
- `SOFIA_MESSAGING_ENABLED` — keep unset or set to `false` until all gates pass.
- Durable database / Redis variables only after the corresponding store and client are implemented and tested.

Do not put placeholder values into production settings. Do not enable the integration until the deployment URL, data stores, access policy, and end-to-end tests are verified.
