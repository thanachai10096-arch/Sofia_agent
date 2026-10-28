# Messaging Gateway (incremental integration)

Status: opt-in gateway, natural-chat command bridge, Telegram Bot API long polling transport, Discord interaction verification/REST transport, and a Slack adapter plus signed Events API HTTP receiver (`api/slack/events.ts`). The Slack receiver handles URL verification, validates the exact raw request body and replay window, requires explicit user/channel allowlists, and forwards accepted tasks to the existing Sofia API. App creation, secret configuration, live credentials, and live smoke tests remain deployment work.

## Safety defaults

- Messaging is disabled unless `enabled: true` is explicitly supplied.
- Unknown users/channels are denied unless an explicit `allowUser` policy permits them.
- The gateway calls an injected message handler. Adapters never invoke tools or a separate agent runtime directly.
- `createSofiaMessagingHandler` bridges to the existing `createChatCommandHandler` and Sofia SDK/API client contract. Its default is natural chat: ordinary text from an authorized conversation is dispatched without requiring `/run`. Set `mode: "command"` to require the configured prefix. Attachments are metadata only and are not downloaded or executed automatically.
- Use `createMessagingAccessCheck` to adapt the existing `ChatAccessPolicy` to the gateway allowlist callback. The existing command handler performs its own authorization check too. Do not pass the same deduplicator to both `createMessagingGateway` and `createSofiaMessagingHandler`, because the existing command handler claims the provider/channel/message key itself.
- Keep bot tokens and Sofia API keys in server-side environment variables or an approved secret provider. Never expose them in client bundles, tests, errors, or logs.
- The Telegram HTTP transport uses HTTPS long polling against the official Telegram Bot API. Choose either polling or a separately implemented webhook deployment, not both for the same bot.
- The Discord interaction transport verifies the signature against the exact raw request body and timestamp before parsing. It can be mounted through the existing `createSofiaApi` using the optional `discordInteractionRoute` config; the route helper preserves raw bytes and enforces the body limit. The route is disabled unless a transport is explicitly configured. The host must expose the route over HTTPS. Unexpected transport errors return a generic 503, and no second server is created.
- Discord slash commands are deferred immediately. The transport edits the deferred original response and uses interaction webhooks for extra message chunks, clearing the Discord loading state. Register the matching application command (default `/run` with a string option named `task`) in Discord.
- The standalone API entrypoint requires both `DISCORD_ALLOWED_USER_IDS` and `DISCORD_ALLOWED_CHANNEL_IDS` whenever Discord is enabled. Both must be comma-separated numeric Discord IDs; empty, malformed, or duplicate entries fail startup. Do not omit the user allowlist: channel membership alone must not grant permission to execute Sofia tasks.
- Treat attachment URLs as untrusted; do not download or open them without a separately secured downloader that blocks private/loopback/link-local destinations, re-checks redirects and DNS, caps response size/time, and avoids forwarding credentials.
- The default gateway rate limiter is in-memory and per process. For shared deployments, `RedisMessagingRateLimiter` provides an atomic fixed-window implementation using a node-redis v4-compatible `eval(script, { keys, arguments })` client; inject it as `rateLimiter: new RedisMessagingRateLimiter({ client })`. The Lua counter operation is atomic across workers, raw scope identifiers are SHA-256 hashed before being used as Redis keys, and Redis errors fail closed (the message is rate-limited). For cross-worker message deduplication, `RedisChatMessageDeduplicator` provides atomic `SET NX PX` claims and ownership-checked release; inject it into the command handler, not twice in both layers.


## Standalone Slack Events API receiver

The optional serverless route is `POST /api/slack/events`. It disables automatic body parsing so `X-Slack-Signature` is checked against the exact raw bytes, and handles Slack's signed `url_verification` challenge before accepting events. Only ordinary human `message` events are considered; bot/subtype events and unapproved users/channels are ignored. Attachments are not downloaded.

Configure these server-side environment variables on a Test/Preview deployment first:

- `SLACK_SIGNING_SECRET` — Slack app signing secret.
- `SLACK_BOT_TOKEN` — bot token with the minimum required `chat:write` scope.
- `SLACK_ALLOWED_USER_IDS` — comma-separated Slack user IDs; an empty list denies all users.
- `SLACK_ALLOWED_CHANNEL_IDS` — comma-separated channel IDs; an empty list denies all channels.
- `SOFIA_API_BASE_URL` and `SOFIA_API_KEY` — existing HTTPS Sofia API endpoint and server-side key.
- `SOFIA_SLACK_CALLBACK_SECRET` — a random secret of at least 32 characters, configured on both the Slack receiver host and the long-lived Sofia API service. It signs the originating user/channel/thread metadata and the SHA-256 digest of the exact task text, so the proof cannot be reused to route a different task result into that Slack thread.

Set the Slack Event Subscriptions Request URL to `https://<your-host>/api/slack/events` and subscribe only to the required `message.*` event types. Install the app only in the intended workspace and restrict bot access. Requests are timestamp-window checked and task creation uses a stable idempotency key derived from Slack's `event_id`, so retries do not intentionally create a second run when the Sofia API honors that key. The route returns a retryable 503 when the Sofia API does not confirm run creation, instead of acknowledging and silently dropping the task. If API acceptance is uncertain, the route returns a retryable error; check the run status before manually resubmitting. The route posts an acceptance message in the originating thread. The long-lived Sofia API process can also post the final completed/failed/cancelled status and redacted result to that same Slack thread when `SLACK_BOT_TOKEN`, `SLACK_ALLOWED_USER_IDS`, `SLACK_ALLOWED_CHANNEL_IDS`, and `SOFIA_SLACK_CALLBACK_SECRET` are configured on the API service as server-side secrets. The receiver signs the callback metadata and exact task digest with HMAC-SHA256; the API verifies it using a constant-time comparison before posting. A valid proof is therefore bound to the submitted task text, not just the destination thread. Completion delivery is best-effort; run status remains authoritative. The final result is truncated to a bounded size and secrets are redacted before sending.

This route follows the repository's Node serverless `api/` convention; it is not automatically mounted by the separate Railway API process unless that deployment explicitly serves the same route. Do not describe Slack as live-ready until URL verification, allowlist denial, duplicate/retry behavior, message delivery, and genuine Slack workspace smoke tests pass.

## Standalone Telegram runtime configuration

The API entrypoint now wires the existing Telegram long-polling adapter into the same Sofia API/Core when explicitly enabled. Configure these variables on the intended service (start with the Test service, not Production):

- `SOFIA_MESSAGING_ENABLED=true` — opt in; otherwise Telegram remains off.
- `TELEGRAM_BOT_TOKEN` — BotFather token, stored only as a server-side secret.
- `TELEGRAM_ALLOWED_USER_IDS` — comma-separated immutable Telegram user IDs.
- `TELEGRAM_ALLOWED_CHAT_IDS` — comma-separated chat IDs. Private chats usually use the same numeric ID as the user; group IDs may be negative.
- `SOFIA_API_BASE_URL` — optional HTTPS base URL for the existing Sofia API. Railway can fall back to `https://${RAILWAY_PUBLIC_DOMAIN}`; on Ubuntu, set the public HTTPS API URL explicitly.

Both allowlists are required and checked together. Missing or malformed optional configuration disables Telegram without stopping the API. The shared handler defaults to natural chat, so ordinary text can start a task without `/run`; set `mode: "command"` when a deployment intentionally requires a prefix. The bridge uses the existing Sofia API key server-side, existing command authorization, rate limiting, and message deduplication. Do not expose the bot token or API key in chat, source control, or logs.

For first rollout, configure and verify this on `Sofia_API_Test` only. Do not enable Production until a real Telegram smoke test confirms an allowed user can submit a task and an unallowlisted user is denied. The file-based dedupe store is local to the service filesystem; use a shared atomic store before running multiple replicas or relying on cross-deployment deduplication.

## Slack adapter (incremental; transport host required)

The repository exports `verifySlackRequest` and `createSlackAdapter`.

- Verify the exact raw HTTP request body using the Slack signing secret, `X-Slack-Request-Timestamp`, and `X-Slack-Signature` before parsing JSON. Reject stale timestamps and oversized bodies. Do not verify a re-serialized JSON body.
- Respond to Slack's URL-verification challenge in the HTTP receiver only after validating the request signature; do not pass the challenge as a user message.
- Pass only normalized message events from the authenticated receiver to the adapter. The adapter expects `signatureVerified: true`, stable event/message identifiers, channel and user IDs from Slack metadata, and ignores bot messages.
- Implement `SlackTransport.start` to receive verified events and `postMessage` to call Slack's authenticated Web API. Keep the bot token and signing secret server-side. Request only the Slack scopes/events needed by the deployment and configure an explicit user/channel allowlist.
- Treat `url_private` file URLs as untrusted metadata; this adapter does not download files. Add bounded retry handling and durable event deduplication in the host/gateway before production use.

This is an adapter plus signature-verification primitive, **not yet a turnkey Slack webhook server or verified live Slack integration**. Use a test Slack app and validate signature failures, retries, bot echoes, allowlist denial, and outbound delivery before enabling it for users.

## Composition contract

Implementations of `MessagingAdapter` normalize incoming events only after provider authentication and identity mapping. The Telegram transport handles long polling and outbound Bot API calls. The Discord interaction transport exposes a request handler for mounting in an existing HTTPS route and uses Discord's interaction webhook token for the deferred response.

The existing `createChatCommandHandler` remains the shared command dispatcher for `run` tasks. The bridge reuses its authorization, deduplication, and idempotency behavior rather than creating a second command runtime. Do not inject the bridge's deduplicator into the gateway as well, or each event would claim the same key twice.

## Configuration outline

At the application composition root:
1. Construct the existing Sofia SDK client with a server-side API key that has the required `agent:run` scope.
2. Reuse the existing `ChatAccessPolicy` and atomic `ChatMessageDeduplicator`.
3. Construct the Telegram adapter with `createTelegramAdapter(createTelegramHttpTransport({ token: process.env.TELEGRAM_BOT_TOKEN! }))`.
4. Construct the Discord transport with `createDiscordInteractionTransport({ publicKeyHex, botToken: process.env.DISCORD_BOT_TOKEN! })`; wrap it with `createDiscordAdapter` and pass the transport to `createSofiaApi` as `discordInteractionRoute: { transport }` (default path `/v1/integrations/discord/interactions`). Expose that route only over HTTPS. For the standalone entrypoint, configure `DISCORD_ALLOWED_USER_IDS=123...,456...` and `DISCORD_ALLOWED_CHANNEL_IDS=789...`; both lists are mandatory and validated before the transport starts.
5. Create the gateway with `enabled: process.env.SOFIA_MESSAGING_ENABLED === "true"`, `allowUser: createMessagingAccessCheck(policy)`, and `onMessage: createSofiaMessagingHandler({ client, accessPolicy: policy, deduplicator })`.
6. Ensure the command prefix configured for the handler matches the prefix configured for Discord's interaction transport.
7. Keep lifecycle ownership at the existing application composition root: call `start()` after server readiness and `stop()` during graceful shutdown. Do not instantiate a second Sofia runtime.

The code outline above is not a claim that the repository's API server is already wired to these transports. Keep secrets out of checked-in config, client builds, test fixtures, and logs.


- The shared Sofia SDK supports an optional `idempotencyKey` for async runs. Reuse a key only for the same logical request; the API returns `409 idempotency_key_reused` if the same key is presented with a different request payload. This protection is currently process-local and is not persisted across server restarts.

## Production acceptance checklist

- [ ] Typecheck, build, and full test suite pass on the PR head, including `tests/api/slack-events.test.ts` (signature/challenge, allowlist denial, retryable Sofia API failure).
- [ ] Telegram test bot receives a message, rejects an unallowlisted user, and returns a long reply in bounded chunks.
- [ ] Duplicate Telegram updates do not start duplicate runs, including after process restart when a durable dedupe store is configured.
- [ ] Discord application command is registered; signature verification rejects invalid/stale signatures and accepts a genuine interaction.
- [ ] Discord deferred response is edited and all follow-up chunks are delivered within the interaction token lifetime.
- [ ] Unauthorized users/channels cannot invoke runs; policy errors fail closed.
- [ ] Standalone Discord deployment has explicit, non-empty user and channel allowlists; startup rejects missing, malformed, or duplicate IDs.
- [ ] API keys and bot tokens never appear in logs, client assets, test snapshots, or error messages.
- [ ] Graceful shutdown stops polling and rejects new dispatches.
- [ ] Enable `discordInteractionRoute` only when a Discord transport is configured; expose it over HTTPS and keep the raw-body size limit enabled.
- [ ] Multi-instance production deployment configures Redis connectivity, injects `RedisMessagingRateLimiter`, and injects `RedisChatMessageDeduplicator` for cross-worker replay protection; verify behavior under concurrent requests and store outages.
- [ ] Attachment downloading stays disabled until a separately reviewed SSRF-safe downloader exists.

## Current limitations

- No real provider tokens or production webhook URL are configured or tested here.
- The Discord route is opt-in via `SofiaApiConfig.discordInteractionRoute`; the host deployment must still terminate TLS/serve the API over HTTPS. No live production credentials are configured here.
- The related chat/idempotency base branch had a TypeScript narrowing error in `src/api/server.ts`; it was fixed with an explicit entry guard in the base PR. CI for this updated stack must still confirm the fix.
- Attachment downloading, durable cross-host message deduplication, Redis integration testing against a live Redis service, provider registration, and end-to-end live tests remain follow-up work. `RedisMessagingRateLimiter` is included, but the application must supply and manage the Redis client/connection.

## Cross-platform integration target

The shared `ChatPlatform` contract now recognizes Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Microsoft Teams, Google Chat, Facebook Messenger, Instagram, LINE, WeChat, iMessage, Web Chat, Desktop, Mobile, and SDK clients. This is a routing/type contract, **not a claim that every provider transport is implemented or live-tested**.

Each provider still needs its own authenticated adapter, event verification, identity mapping, outbound delivery, retry/replay handling, and signed-fixture tests. Use official APIs and supported business/platform access; some networks restrict bots, require business approval, or do not expose public messaging APIs. Never bypass those restrictions or scrape private sessions.

Recommended implementation order: finish natural-chat behavior and Telegram/Discord smoke tests; then Slack, WhatsApp Business Platform, Microsoft Teams, Google Chat, Matrix, and Signal where supported; then LINE and Meta messaging channels; finally add community-maintained adapters only behind the same stable gateway contract. Keep each connector optional and independently configured.


## Architecture contract

See [Messaging Gateway Architecture](./MESSAGING_GATEWAY_ARCHITECTURE.md) for the shared adapter contract, message flow, readiness states, security requirements, implementation phases, and acceptance criteria. The architecture document is a target contract; it does not imply that every listed platform is implemented or live-tested.


## Connector capability matrix (this branch)

This matrix describes code in the repository, not a claim of live account connectivity.

| Platform | Code present in this branch | Important boundary |
|---|---|---|
| Telegram | Adapter, Bot API long-poll transport, optional runtime | Requires bot token, Sofia API credentials, and explicit user/chat allowlists. |
| Discord | Adapter and interaction transport/route | Requires application setup, valid signature verification, and explicit user/channel allowlists. |
| Slack | Adapter and signed Events API receiver | Requires a Slack app, signing secret, bot token, allowlists, and a deployed HTTPS callback. |
| LINE, WhatsApp, Signal, Matrix, Teams, Google Chat, Messenger, Instagram, WeChat, iMessage, Viber, KakaoTalk, Zalo, Mattermost, Rocket.Chat, Zulip, IRC, email, SMS | Not confirmed as end-to-end adapters by this matrix | Do not show as connected or available until a concrete adapter, authentication path, send/receive transport, tests, and setup instructions exist. |

A platform string in `ChatPlatform` is only a type-level identifier. At runtime, the adapter registry lists only the concrete adapters passed to it. Unit tests and CI do not prove a real provider account has been connected; record provider smoke tests separately.

## Natural chat behavior

`createSofiaMessagingHandler` defaults to `mode: "natural"`: ordinary non-empty text from an authorized conversation is submitted as a task. The configured `/run` prefix is still accepted, while unrelated slash commands are ignored. Set `mode: "command"` explicitly for deployments that require the prefix. Natural chat does not bypass authorization, deduplication, rate limits, API policy, or runtime safety checks.
