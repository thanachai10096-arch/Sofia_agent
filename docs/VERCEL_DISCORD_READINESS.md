# Vercel + Discord deployment readiness

## Status

A first-pass Vercel Node Function now exists at `api/discord/interactions.ts` on this PR branch. It verifies Discord's Ed25519 signature against the exact raw request bytes, answers the Discord PING handshake, enforces an explicit user + channel allowlist, and forwards `/run task` to the existing Sofia HTTPS API using its async-run and idempotency-key contract.

**This is not yet approved for production.** No Vercel deployment, environment configuration, Discord command registration, build, or live test has been performed.

## Function behavior

- Route file: `api/discord/interactions.ts` (Vercel Node Function route: `/api/discord/interactions`).
- Request body parsing is disabled; signature verification uses the original raw bytes and has a 64 KiB request limit.
- Invalid/stale signatures are rejected. PING interactions receive `{ "type": 1 }`.
- User IDs and channel IDs must both be explicitly present in the server-side allowlists. Empty allowlists deny all commands.
- The function sends `POST /v1/agent/runs` with `async: true` to a separately hosted Sofia API, using a stable idempotency key derived from the Discord interaction ID.
- The response is an immediate ephemeral acceptance/rejection message; it does not wait for the agent task to finish.
- It does not require the Discord bot token for this slash-command-only path because replies use the interaction response itself. Do not add a bot token unless a separately reviewed feature needs it.
- Sofia API request timeout is bounded to 1.8 seconds to leave room under Discord's acknowledgement deadline. Real-world latency still needs staging verification.

## Vercel server-side environment variables

Set these only in Vercel Project Settings → Environment Variables. Never commit values or expose them in client bundles.

- `DISCORD_PUBLIC_KEY` — the application's public key from Discord Developer Portal.
- `DISCORD_ALLOWED_USER_IDS` — comma-separated Discord user IDs allowed to start runs. No wildcard support.
- `DISCORD_ALLOWED_CHANNEL_IDS` — comma-separated Discord channel IDs allowed to start runs. No wildcard support.
- `SOFIA_API_BASE_URL` — root HTTPS base URL of the separately hosted Sofia API, without credentials/query/fragment.
- `SOFIA_API_KEY` — a narrowly scoped server-side API key allowed to start runs.
- Optional `DISCORD_COMMAND_NAME` — defaults to `run`.

Do not configure Production variables until Preview has passed the acceptance checklist. The actual deployment URL must come from Vercel after a deployment; do not guess it.

## Important remaining limitations

1. **No live verification yet.** The new file has not been typechecked or run in a Vercel Preview environment in this workflow.
2. **Sofia API must already be hosted separately.** This function does not run the Sofia agent runtime inside Vercel; it calls the configured HTTPS API.
3. **The Sofia API currently documents process-local idempotency.** The stable key helps retry safety, but cross-instance atomic deduplication and durable run-state storage remain production requirements.
4. **Access policy is an explicit static allowlist.** Keep both lists restrictive. If you need dynamic policy, wire a reviewed server-side policy/store before broadening access.
5. **Discord command registration is a separate setup step.** Register `/run` with one required string option named `task` using the correct application ID and test guild. Do not publish the endpoint until the Preview URL is confirmed.
6. The serverless function must not be composed with Sofia's local workspace/terminal runtime. Execution capability boundaries belong in the separately hosted Sofia API and must be reviewed there.

## Acceptance checklist before production

- [ ] Install dependencies and run `npm run typecheck`, `npm run build`, and `npm test`.
- [ ] Deploy to Vercel Preview and verify the generated function route exists.
- [ ] Configure Preview-only environment variables and narrow test user/channel allowlists.
- [ ] Discord PING succeeds; invalid and stale signatures fail.
- [ ] Oversized body, malformed JSON, non-POST methods, and missing configuration fail closed.
- [ ] Unallowlisted users and channels cannot start runs.
- [ ] A valid `/run task` starts exactly one Sofia run and returns the run ID before Discord's deadline.
- [ ] Retry/replay behavior is verified under concurrent requests and API timeout cases.
- [ ] Replace process-local idempotency with a shared atomic durable store before relying on duplicate suppression across API instances or restarts.
- [ ] Confirm Sofia API run status remains available after restarts and across instances.
- [ ] Register the command against the verified Preview URL and perform a live staging smoke test.
- [ ] Review the PR and explicitly approve production deployment separately.
