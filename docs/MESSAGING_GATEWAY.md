# Messaging Gateway (incremental integration)

Status: opt-in gateway, command bridge, Telegram Bot API long polling transport, and Discord interaction verification/REST transport. Public factory functions and their configuration types are exported from `src/index.ts`. Live credentials and production route configuration are not included.

## Safety defaults

- Messaging is disabled unless `enabled: true` is explicitly supplied.
- Unknown users/channels are denied unless an explicit `allowUser` policy permits them.
- The gateway calls an injected message handler. Adapters never invoke tools or a separate agent runtime directly.
- `createSofiaMessagingHandler` bridges to the existing `createChatCommandHandler` and Sofia SDK/API client contract. By default, ordinary text messages are sent to Sofia as natural-language tasks; users do not need to type `/run`. Set `naturalLanguageEnabled: false` to retain command-only behavior. The configured `/run` prefix remains supported, and other slash commands (such as `/start`, `/help`, or `/status`) are ignored rather than dispatched as tasks. Attachment-only messages do not trigger execution.
- Natural-language dispatch does not bypass authorization, deduplication, task-size validation, or the API's normal policy/tool controls. Keep the gateway disabled or restricted by explicit user/channel allowlists; do not expose an unrestricted public bot.
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

Both allowlists are required and checked together. Missing or malformed optional configuration disables Telegram without stopping the API. Only explicit `/run <task>` commands dispatch work; ordinary messages do not start runs. The bridge uses the existing Sofia API key server-side, existing command authorization, rate limiting, and message deduplication. Do not expose the bot token or API key in chat, source control, or logs.

For first rollout, configure and verify this on `Sofia_API_Test` only. Do not enable Production until a real Telegram smoke test confirms an allowed user can submit a task and an unallowlisted user is denied. The file-based dedupe store is local to the service filesystem; use a shared atomic store before running multiple replicas or relying on cross-deployment deduplication.

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


## Telegram voice media building block

`createTelegramVoiceMediaClient` is an opt-in media helper for a future Telegram voice adapter. It is separate from the existing text messaging poller and does not start a second polling loop or automatically execute voice messages.

- `downloadVoice(fileId, signal)` calls Telegram `getFile`, validates the returned relative path, permits only known audio extensions, and downloads only from the fixed `https://api.telegram.org/file/` origin.
- File metadata and the streamed response are both checked against a configurable byte limit (10 MiB by default; maximum configurable limit 50 MiB).
- `sendVoice(chatId, audio, signal)` uploads audio using multipart form data and validates the chat ID, MIME type, and byte limit.
- Requests use HTTPS, reject redirects, support cancellation, and never accept a caller-provided download URL.
- This helper does not verify actual media duration or decode the audio. The future voice adapter must validate the Telegram-provided duration against decoded media duration before invoking `VoiceWorkflow`.
- It is an opt-in building block; text messaging behavior remains unchanged unless the host supplies the optional voice handler to `createTelegramMessagingRuntime`. A single Telegram update dispatcher routes voice and text events without running two competing `getUpdates` loops.

Automated tests cover fixed-origin downloads, path traversal rejection, extension allowlisting, streamed size limits, multipart upload, and cancellation. These are mocked HTTP tests, not a live Telegram bot test.

### Telegram voice update handoff

The Telegram adapter can optionally expose voice messages through `TelegramAdapterOptions.onVoiceMessage`. This callback runs from the existing Telegram update poller; it does not create a second `getUpdates` loop and voice messages are not misrouted as text commands. The callback receives the sender/chat identifiers, Telegram file ID, MIME hint, byte-size hint, and Telegram-reported duration.

This is an integration seam, not an enabled voice runtime. A host must still apply the existing user/chat access policy and durable deduplication before downloading media, use `createTelegramVoiceMediaClient` for bounded fixed-origin downloads, independently inspect/decode the audio to verify its actual format and duration (Telegram metadata is untrusted), then pass verified bytes to `VoiceWorkflow`. Only deliver a generated audio reply after the normal Sofia policy/runtime path succeeds. No concrete codec/decoder, STT/TTS provider, audio storage, or live Telegram voice processing is enabled by this callback alone; the host must supply and validate those components before enabling voice.

### Opt-in Telegram voice ingress

The Telegram adapter can pass voice updates from its existing long-polling callback to an optional host-composed handler. `createTelegramMessagingRuntime` accepts a fourth, optional `{ voice: { handle(message, signal) } }` argument; omitting it preserves the current text-only behavior. The callback receives the poller's abort signal so shutdown/cancellation can propagate without creating a second `getUpdates` loop.

Use `createTelegramVoiceMessageHandler` to compose the bounded media client, a trusted `TelegramAudioInspector`, the existing `VoiceWorkflow`, the same Telegram user/chat allowlist policy, a durable `FileChatMessageDeduplicator`-compatible claim store, and outbound text/audio delivery. The handler checks access and claims the message before downloading media. It deliberately requires an injected decoder/inspector: Telegram duration, MIME and file extension are untrusted hints, not proof of actual audio format or duration. Do not enable voice until a sandboxed decoder is configured and tested with malformed, truncated, oversized and adversarial media fixtures. The host should pass the same allowlists and a durable dedupe store. If the deduplicator supports `release(key)`, the handler releases a claim only when download/inspection fails before Sofia agent execution begins. Once agent execution starts, the claim is retained even if a later stage fails, avoiding accidental duplicate task execution on retry. This is an at-most-once boundary, not guaranteed exactly-once delivery.


### Container-isolated Telegram audio inspection

`createSandboxedTelegramAudioInspector` provides a concrete `TelegramAudioInspector` implementation using Sofia's existing `ContainerSandbox`. It refuses process/policy isolation, writes the input to a unique temporary workspace containing only that audio file, and invokes `ffprobe` without a shell, with networking disabled and bounded execution/output. The temporary workspace is removed after inspection. It validates that an audio stream exists, derives duration from decoded container metadata rather than Telegram hints, enforces configured size/duration limits, and maps a deliberately limited set of common audio containers to MIME types.

The configured `SOFIA_SANDBOX_IMAGE` must be digest-pinned and preloaded and must include `ffprobe`; this repository does not bundle or install FFmpeg. Missing decoder binaries fail closed. Container isolation uses the existing Docker resource limits (memory, CPU, PIDs, dropped capabilities, no-new-privileges, read-only root, and no network). This is metadata inspection, not a guarantee against decoder or container-runtime vulnerabilities. Test the exact immutable image with malformed, truncated and adversarial media before enabling the feature. No live Telegram or production deployment is implied.
