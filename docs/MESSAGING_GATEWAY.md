# Messaging Gateway (incremental integration)

Status: opt-in gateway with Telegram, Discord, Slack, LINE, WhatsApp Cloud API, and Matrix runtime/transport code. The standalone API entrypoint now mounts configured Slack/LINE/WhatsApp signed webhook routes and starts/stops their runtimes with the existing server lifecycle; Matrix uses authenticated polling. Public factory functions and configuration types are exported from `src/index.ts`. Live credentials and production route configuration are not included.

## Safety defaults

- Messaging is disabled unless `enabled: true` is explicitly supplied.
- Unknown users/channels are denied unless an explicit `allowUser` policy permits them.
- The gateway calls an injected message handler. Adapters never invoke tools or a separate agent runtime directly.
- `createSofiaMessagingHandler` bridges to the existing `createChatCommandHandler` and Sofia SDK/API client. `allowPlainText` is opt-in at the handler level; Telegram, Slack, LINE, WhatsApp Cloud API, and Matrix runtimes enable it in the current draft branch. Explicit `/run <task>` remains supported. Discord's current HTTP Interactions transport is slash-command-only and does not receive ordinary channel messages.
- Use `createMessagingAccessCheck` to adapt the existing `ChatAccessPolicy` to the gateway allowlist callback. The existing command handler performs its own authorization check too. Do not pass the same deduplicator to both `createMessagingGateway` and `createSofiaMessagingHandler`, because the existing command handler claims the provider/channel/message key itself.
- Keep bot tokens and Sofia API keys in server-side environment variables or an approved secret provider. Never expose them in client bundles, tests, errors, or logs.
- The Telegram HTTP transport uses HTTPS long polling against the official Telegram Bot API. Choose either polling or a separately implemented webhook deployment, not both for the same bot.
- The Discord interaction transport verifies the signature against the exact raw request body and timestamp before parsing. It can be mounted through the existing `createSofiaApi` using the optional `discordInteractionRoute` config; the route helper preserves raw bytes and enforces the body limit. The route is disabled unless a transport is explicitly configured. The host must expose the route over HTTPS. Unexpected transport errors return a generic 503, and no second server is created.
- Discord slash commands are deferred immediately. The transport edits the deferred original response and uses interaction webhooks for extra message chunks, clearing the Discord loading state. Register the matching application command (default `/run` with a string option named `task`) in Discord.
- The standalone API entrypoint requires both `DISCORD_ALLOWED_USER_IDS` and `DISCORD_ALLOWED_CHANNEL_IDS` whenever Discord is enabled. Both must be comma-separated numeric Discord IDs; empty, malformed, or duplicate entries fail startup. Do not omit the user allowlist: channel membership alone must not grant permission to execute Sofia tasks.
- Treat attachment URLs as untrusted; do not download or open them without a separately secured downloader that blocks private/loopback/link-local destinations, re-checks redirects and DNS, caps response size/time, and avoids forwarding credentials.
- The default gateway rate limiter is in-memory and per process. For shared deployments, `RedisMessagingRateLimiter` provides an atomic fixed-window implementation using a node-redis v4-compatible `eval(script, { keys, arguments })` client; inject it as `rateLimiter: new RedisMessagingRateLimiter({ client })`. The Lua counter operation is atomic across workers, raw scope identifiers are SHA-256 hashed before being used as Redis keys, and Redis errors fail closed (the message is rate-limited). For cross-worker message deduplication, `RedisChatMessageDeduplicator` provides atomic `SET NX PX` claims and ownership-checked release; inject it into the command handler, not twice in both layers.

## Standalone Telegram runtime configuration

The API entrypoint now wires the existing Telegram long-polling adapter into the same Sofia API/Core when explicitly enabled. Configure these variables on the intended service (start with the Test service, not Production):

- `SOFIA_MESSAGING_ENABLED=true` — opt in; otherwise Telegram remains off.
- `TELEGRAM_BOT_TOKEN` — BotFather token, stored only as a server-side secret.
- `TELEGRAM_ALLOWED_USER_IDS` — comma-separated immutable Telegram user IDs.
- `TELEGRAM_ALLOWED_CHAT_IDS` — comma-separated chat IDs. Private chats usually use the same numeric ID as the user; group IDs may be negative.
- `SOFIA_API_BASE_URL` — optional HTTPS base URL for the existing Sofia API. Railway can fall back to `https://${RAILWAY_PUBLIC_DOMAIN}`; on Ubuntu, set the public HTTPS API URL explicitly.

Both allowlists are required and checked together. Missing or malformed optional configuration disables Telegram without stopping the API. In the current draft branch, Telegram is configured for chat-first mode: ordinary text starts a run without `/run`; explicit `/run <task>` remains supported, and unsupported slash commands are ignored. The bridge uses the existing Sofia API key server-side, existing command authorization, rate limiting, and message deduplication. Do not expose the bot token or API key in chat, source control, or logs. This branch is not merged or live-tested yet.

For first rollout, configure and verify this on `Sofia_API_Test` only. Do not enable Production until a real Telegram smoke test confirms an allowed user can submit a task and an unallowlisted user is denied. The file-based dedupe store is local to the service filesystem; use a shared atomic store before running multiple replicas or relying on cross-deployment deduplication.

## Slack Events API integration

Sofia now includes `createSlackEventsTransport`, `createSlackAdapter`, `createSlackMessagingRuntime`, and an optional `slackEventsRoute` on `createSofiaApi`. The transport verifies Slack's `X-Slack-Signature` against the exact raw request bytes, enforces a five-minute timestamp window, handles URL verification and event retry de-duplication, ignores bot/subtype messages, and sends replies through `chat.postMessage` with a server-side bot token. The API route is bounded and returns generic errors.

Required environment:
- `SOFIA_MESSAGING_ENABLED=true`
- `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`
- `SLACK_ALLOWED_USER_IDS`, `SLACK_ALLOWED_CHANNEL_IDS` (both required; no wildcard access)
- `SOFIA_API_KEY`, `SOFIA_API_BASE_URL`

Composition outline:
1. The standalone API entrypoint creates `createSlackMessagingRuntime(process.env, workspace)` and passes its transport to the existing API route when configuration is valid.
2. Start/stop is tied to the existing API lifecycle. The route defaults to `/v1/integrations/slack/events`.
4. In Slack API settings, enable Event Subscriptions, use that HTTPS Request URL, subscribe to `message.channels` and/or `message.im` as appropriate, install the app, and grant only needed scopes such as `chat:write` and the relevant message history/event scopes. Do not grant broad scopes unnecessarily.
5. Test URL verification, allowed and denied user/channel pairs, retries, duplicate events, and actual outbound replies in a non-production workspace before enabling production.

This adds a signed HTTP transport and app composition path, but **live workspace installation and end-to-end validation have not been performed here**. The runtime uses a local file deduplicator by default; multi-replica deployments should inject a shared atomic deduplicator.

## LINE Messaging API integration

Sofia also includes `createLineWebhookTransport`, `createLineAdapter`, `createLineMessagingRuntime`, and the optional `lineWebhookRoute` on `createSofiaApi`. It verifies LINE's `X-Line-Signature` against the raw request body before parsing, de-duplicates webhook event IDs, accepts text messages, and sends text through LINE's push API. Sender and conversation allowlists are mandatory.

Required environment:
- `SOFIA_MESSAGING_ENABLED=true`
- `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_ALLOWED_USER_IDS`, `LINE_ALLOWED_CONVERSATION_IDS`
- `SOFIA_API_KEY`, `SOFIA_API_BASE_URL`

Composition outline:
1. Call `createLineMessagingRuntime(process.env, workspace)`.
2. Pass `lineRuntime.transport` to `createSofiaApi(deps, { ...config, lineWebhookRoute: { transport: lineRuntime.transport } })`.
3. Start and stop the runtime with the API lifecycle. The route defaults to `/v1/integrations/line/webhook`.
4. In LINE Developers Console, set that HTTPS webhook URL, enable webhook use, and validate the endpoint. Test only in a non-production channel first.

The code and deterministic transport tests are present, but live LINE channel setup and real-account end-to-end testing have not been performed. Push messages are subject to LINE channel/account eligibility and platform limits.

## WhatsApp Cloud API integration

Sofia now includes a Meta WhatsApp Cloud API adapter, signed webhook transport, bounded HTTP route, and allowlisted runtime. It supports Meta's GET webhook challenge verification, validates `X-Hub-Signature-256` against raw POST bytes, accepts text messages for the configured phone-number ID, de-duplicates message IDs, and sends outbound text via the Graph API. The Graph API version is explicitly configured rather than silently defaulted.

Required environment:
- `SOFIA_MESSAGING_ENABLED=true`
- `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_API_VERSION`
- `WHATSAPP_ALLOWED_PHONE_IDS` (explicit allowlist; no wildcard)
- `SOFIA_API_KEY`, `SOFIA_API_BASE_URL`

Composition:
1. Create the runtime with `createWhatsAppMessagingRuntime(process.env, workspace)`.
2. Mount `whatsAppRuntime.transport` using `createSofiaApi(deps, { ...config, whatsAppWebhookRoute: { transport: whatsAppRuntime.transport } })`.
3. Start/stop the runtime with the API. The route defaults to `/v1/integrations/whatsapp/webhook`; configure this HTTPS URL in Meta's app dashboard.
4. Set the same verify token in Meta's webhook configuration, subscribe only to the required WhatsApp message fields, and test against a non-production number first.

This is the **WhatsApp Cloud API** path, not QR-based WhatsApp Web. The code and deterministic transport tests are present; Meta business/app setup and live end-to-end validation have not been performed. Messaging windows, template requirements, quotas, and account eligibility remain governed by Meta.

## Natural-language scheduled tasks

When the authenticated agent exposes the `schedule_task` tool, users can ask for simple schedules in ordinary language, for example:

- "Every day at 8 am, summarize the news."
- "Every weekday at 9:30 am, check my project status."
- "In 30 minutes, remind me to review the build."

The parser intentionally accepts a small, deterministic set of phrases (daily/morning, weekdays, named weekdays, and relative minute/hour/day delays). Ambiguous wording is rejected rather than guessed. Recurring schedules use the explicit `timeZone` supplied by the model or `SOFIA_DEFAULT_TIME_ZONE`; if neither is set, the safe documented default is UTC. Configure the timezone to the user's intended locale.

A scheduled result is sent to a chat only when the originating integration supplied a verified, signed messaging identity and destination. The destination is captured by the trusted host; it cannot be selected or overridden by model-generated tool arguments. Without a verified destination, results remain available through durable schedule/job history. Live provider acceptance and real-account delivery still require platform-specific smoke tests.

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

- [ ] Typecheck, build, and full test suite pass on the PR head.
- [ ] Telegram Test bot accepts plain text without `/run`, rejects an unallowlisted user, and returns a long reply in bounded chunks.
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


## Matrix Client-Server API integration

Sofia includes an opt-in Matrix adapter and client-server API polling transport. It authenticates with the configured homeserver using a server-side access token, uses `/_matrix/client/v3/sync` for incoming events, ignores its own messages and non-text events, and sends replies through the Matrix send-event API. The homeserver must be a public HTTPS origin; redirects are rejected, and the transport resolves the hostname before each request and rejects DNS answers containing private, loopback, link-local, or other non-public IP ranges. This DNS preflight is defense-in-depth; deployments exposed to hostile DNS should also enforce outbound network egress rules because DNS can change between validation and connection. User and room allowlists are both mandatory and there is no wildcard mode.

Required environment:
- `SOFIA_MESSAGING_ENABLED=true`
- `MATRIX_HOMESERVER_URL` — public HTTPS origin, such as your Matrix homeserver origin
- `MATRIX_ACCESS_TOKEN` — server-side bot account access token
- `MATRIX_ALLOWED_USER_IDS` — comma-separated immutable Matrix user IDs beginning with `@`
- `MATRIX_ALLOWED_ROOM_IDS` — comma-separated room IDs beginning with `!`
- `SOFIA_API_KEY`, `SOFIA_API_BASE_URL`

Create `createMatrixMessagingRuntime(process.env, workspace)` and start/stop it with the existing application lifecycle. Messages may be submitted as plain text or with `!run <task>` in an allowlisted room. Invite the bot account only to the rooms it needs, and test with a non-production account first. The code includes deterministic transport tests; live homeserver setup and end-to-end validation have not been performed.


## Scheduled result delivery

- Set `SOFIA_MESSAGING_CONTEXT_SECRET` to a random secret of at least 32 characters in the trusted Sofia API/messaging process. Keep it server-side and never send it to the model or a client app.
- Messaging adapters sign the normalized platform, immutable sender ID, conversation ID, message ID, and task hash. The API verifies the HMAC and binds the trusted destination and user principal before executing the task.
- `schedule_task` stores the verified destination with the schedule. Completion notices are sent through the configured messaging adapter and retried on later scheduler ticks until the provider accepts the send. Delivery is at-least-once if the process crashes after provider acceptance but before the durable delivery marker is saved.
- If the secret is unset or invalid, ordinary chat tasks still work, but scheduled results are not bound to a chat destination; they remain in durable schedule history.


## Per-user model profiles

- Set `SOFIA_MODEL_PROFILE_ENCRYPTION_KEY` to a randomly generated base64-encoded 32-byte key to enable encrypted profiles. Do not commit it. Without it, profile endpoints return `503 model_profile_storage_not_configured` and Sofia uses the operator's server-side provider configuration.
- The authenticated API key owns its own profile. Grant `model:profile:read` to read metadata and `model:profile:write` to set/delete it. The API never returns a stored provider key.
- `PUT /v1/model-profile` accepts `provider`, `model`, `apiKey`, and (only for `openai-compatible`) `baseUrl`. Gemini and OpenRouter use fixed HTTPS endpoints. Custom OpenAI-compatible endpoints must use HTTPS and an operator-allowlisted hostname; add exact hostnames to `SOFIA_MODEL_PROFILE_ALLOWED_HOSTS`.
- Profile keys are encrypted with AES-256-GCM and keyed by a hash of the authenticated principal. When `SOFIA_STATE_DIR` is set, profiles are stored under `$SOFIA_STATE_DIR/sofia-agents/model-profiles.json`; otherwise they live in the workspace `.sofia` directory. Use a persistent volume for hosted deployments. Per-user model profiles are separate from local `sofia setup` and from the operator's default provider environment.