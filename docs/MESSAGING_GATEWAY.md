# Messaging Gateway (incremental integration)

Status: opt-in gateway, command bridge, Telegram Bot API long polling transport, and Discord interaction verification/REST transport. Live credentials and production route configuration are not included.

## Safety defaults

- Messaging is disabled unless `enabled: true` is explicitly supplied.
- Unknown users/channels are denied unless an explicit `allowUser` policy permits them.
- The gateway calls an injected message handler. Adapters never invoke tools or a separate agent runtime directly.
- `createSofiaMessagingHandler` bridges to the existing `createChatCommandHandler` and Sofia SDK/API client contract. Only explicit `/run <task>` messages (or a configured exact prefix such as `/run@SofiaBot`) start a run. Ordinary chat and attachments do not trigger execution.
- Use `createMessagingAccessCheck` to adapt the existing `ChatAccessPolicy` to the gateway allowlist callback. The existing command handler performs its own authorization check too. Do not pass the same deduplicator to both the gateway and `createSofiaMessagingHandler`, because the existing command handler claims the provider/channel/message key itself.
- Keep bot tokens and Sofia API keys in server-side environment variables or an approved secret provider. Never expose them in client bundles, tests, errors, or logs.
- The Telegram HTTP transport uses HTTPS long polling against the official Telegram Bot API. Choose either polling or a separately implemented webhook deployment, not both for the same bot.
- The Discord interaction transport verifies the signature against the exact raw request body and timestamp before parsing. Use `handleDiscordInteractionHttpRequest` to preserve raw bytes and enforce the body limit, mounted on an HTTPS POST route in the existing server composition. This module intentionally does not create another server or silently alter Sofia's central API router.
- Discord slash commands are deferred immediately. The transport edits the deferred original response and uses interaction webhooks for extra message chunks, clearing the Discord loading state. Register the matching application command (default `/run` with a string option named `task`) in Discord.
- Treat attachment URLs as untrusted; do not download or open them without a separately secured downloader that blocks private/loopback/link-local destinations, re-checks redirects and DNS, caps response size/time, and avoids forwarding credentials.
- Gateway rate limits are in-memory and per process. Multi-instance production deployments need a shared limiter and durable deduplication store.

## Composition contract

Implementations of `MessagingAdapter` normalize incoming events only after provider authentication and identity mapping. The Telegram transport handles long polling and outbound Bot API calls. The Discord interaction transport exposes a request handler for mounting in an existing HTTPS route and uses Discord's interaction webhook token for the deferred response.

The existing `createChatCommandHandler` remains the shared command dispatcher for `run` tasks. The bridge reuses its authorization, deduplication, and idempotency behavior rather than creating a second command runtime. Do not inject the bridge's deduplicator into the gateway as well, or each event would claim the same key twice.

## Configuration outline

At the application composition root:
1. Construct the existing Sofia SDK client with a server-side API key that has the required `agent:run` scope.
2. Reuse the existing `ChatAccessPolicy` and atomic `ChatMessageDeduplicator`.
3. Construct the Telegram adapter with `createTelegramAdapter(createTelegramHttpTransport({ token: process.env.TELEGRAM_BOT_TOKEN! }))`.
4. Construct the Discord transport with `createDiscordInteractionTransport({ publicKeyHex, botToken: process.env.DISCORD_BOT_TOKEN! })`; wrap it with `createDiscordAdapter` and mount `handleDiscordInteractionHttpRequest` on a raw-body-preserving HTTPS POST route.
5. Create the gateway with `enabled: process.env.SOFIA_MESSAGING_ENABLED === "true"`, `allowUser: createMessagingAccessCheck(policy)`, and `onMessage: createSofiaMessagingHandler({ client, accessPolicy: policy, deduplicator })`.
6. Ensure the command prefix configured for the handler matches the prefix configured for Discord's interaction transport.

The code outline above is not a claim that the repository's API server is already wired to these transports. Keep secrets out of checked-in config, client builds, test fixtures, and logs.

## Current limitations

- No real provider tokens or production webhook URL are configured or tested here.
- The Discord route still must be mounted by the host application's HTTPS server; the central Sofia API router has intentionally not been changed in this adapter PR.
- Attachment downloading, shared multi-process rate limiting, durable cross-host gateway rate limits, provider registration, and end-to-end live tests remain follow-up work.
