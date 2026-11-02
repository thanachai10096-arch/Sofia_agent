# Vercel Discord Gateway worker

Status: implementation scaffold added; **not deployed or live-tested**.

## Why a daemon is required

Discord guild messages such as `MESSAGE_CREATE` arrive over the Discord Gateway WebSocket. The existing `api/discord/interactions.ts` endpoint handles signed HTTP interactions and slash commands only; it cannot receive ordinary channel messages.

Vercel Functions have a bounded invocation lifetime. A Gateway client needs a continuously running process that maintains heartbeat, sequence, session resume, and reconnect behavior. Vercel Daemons are the Vercel-native worker primitive for this workload. Daemons are currently in public beta and run in Production deployments, not Preview deployments. Do not add an active daemon declaration to the main `i888` project until an isolated Vercel test project and its production environment are approved.

## Added worker files

- `workers/discord-gateway/worker.mjs` — Node 22 Gateway client using the built-in WebSocket implementation.
- `workers/discord-gateway/Dockerfile` — minimal container image.

The worker:
- requests only GUILDS, GUILD_MESSAGES, and MESSAGE_CONTENT intents;
- supports Gateway HELLO, heartbeat/ACK, IDENTIFY, RESUME, reconnect backoff, and invalid-session reset;
- processes only allowlisted user and channel IDs and ignores bot messages and slash commands;
- bounds concurrent Sofia requests and limits task length;
- posts ordinary message text to the existing Vercel-hosted Sofia API using the internal API key and Discord message ID as the idempotency key;
- sends bounded replies through Discord REST and avoids logging task text, tokens, or provider payloads.

## Required server-side environment

Configure only on a dedicated Vercel test project (not the current `i888` Production environment):

- `DISCORD_BOT_TOKEN` — bot token secret.
- `DISCORD_ALLOWED_USER_IDS` — comma-separated Discord user IDs.
- `DISCORD_ALLOWED_CHANNEL_IDS` — comma-separated Discord channel IDs.
- `SOFIA_API_BASE_URL` — HTTPS origin of the same test project's Sofia API.
- `SOFIA_INTERNAL_API_KEY` — internal API key with the required agent run scope.
- `VERCEL_PROTECTION_BYPASS` — optional secret only if the test API deployment requires Vercel protection bypass.

Never paste or commit these values. Do not configure a public client bundle with them.

## Deliberately not activated yet

The worker is not yet registered in `vercel.toml` / `vercel.json`, and no daemon instance is running. This is intentional: Vercel Daemons currently start only for Production deployments, so adding the daemon declaration to the existing `i888` project could start a live bot on its next Production deployment. The current project has no authorization to deploy or promote Production.

Next safe rollout:
1. Create or designate a separate Vercel test project linked to this repository/branch.
2. Confirm the test project has Daemons beta access and configure the variables above in that project's isolated Production environment.
3. Add the daemon declaration for that test project and deploy there only.
4. Verify Gateway READY, message receipt, allowlist rejection, Sofia API success, reply delivery, reconnect/resume, and restart behavior.
5. Only after these tests pass, decide separately whether to activate it on the main project.

## Known limitations of this first worker milestone

- This worker submits a normal message as one synchronous Sofia API run. Conversation history/session memory and durable multi-step job completion notifications are not yet bridged into this worker.
- API run state still uses the current Vercel Core adapter's temporary file-backed storage; that is not durable across cold starts or independent instances.
- The worker has not been typechecked or integration-tested against a live Discord bot, and no successful Gateway session is claimed.
- Message Content Intent must be enabled in the Discord Developer Portal.
- No slash-command registration or Interactions Endpoint URL is required for ordinary Gateway message reception.
