# Sofia Messaging Gateway Architecture

## Goal

Connect multiple messaging platforms to the existing Sofia API and Agent Runtime without creating one runtime per platform. Add integrations incrementally and keep platform-specific authentication and transport behavior inside each adapter.

This document describes the intended architecture. It is not a claim that every named platform has a working connector.

## Current implementation boundary

The current messaging code already includes shared message types, a gateway, a Sofia handler, and Telegram/Discord transports plus Slack adapter/receiver work on the associated feature branch. The shared `ChatPlatform` type is an identifier type, not a capability list. A platform is usable only when a concrete adapter and its required transport/configuration are present and tested.

Use `createMessagingAdapterRegistry` to expose the concrete adapters wired into an application. It deliberately does not manufacture placeholder adapters for unsupported platforms.

## Layers and responsibilities

1. **Platform transport** — receives updates or webhooks and sends messages using the provider's supported API. It validates provider signatures/timestamps where applicable and preserves raw request bytes until signature validation completes.
2. **Platform adapter** — maps provider events into `InboundMessage`, maps Sofia replies to provider send operations, handles provider message limits, thread/reply identifiers, and provider-specific delivery receipts.
3. **Adapter registry** — records only concrete adapters supplied at startup. Duplicate identifiers and malformed platform IDs fail startup rather than silently selecting one adapter.
4. **Messaging gateway** — coordinates adapter lifecycle, sender/channel authorization, input validation, rate limiting, deduplication, dispatch, and reply delivery. Reuse the existing gateway rather than creating a second dispatcher.
5. **Sofia handler/API bridge** — routes normalized user text into the existing Sofia API/Agent Runtime. Natural-chat mode may treat ordinary text as a task; command-only mode remains an explicit compatibility option.
6. **Session and memory** — resolve a platform/account/user/conversation/thread binding to a Sofia session. Do not merge identities from different platforms merely because display names match. Cross-platform account linking must be explicit and authenticated.
7. **Durable run and delivery state** — track accepted runs and delivery attempts so a process restart does not lose the ability to inspect job status or retry a safe notification.
8. **Setup and health** — report each adapter as not configured, configured, connected, degraded, or unsupported only when those states can be derived from real configuration/health checks. Never label a platform connected just because its name appears in a type or UI.

## Suggested source layout

Keep existing files and add modules only when they remove real duplication:

- `src/integrations/chat-adapter.ts` — existing transport-neutral dispatch contract; preserve compatibility.
- `src/integrations/messaging/types.ts` — normalized inbound/outbound messages and adapter interfaces.
- `src/integrations/messaging/gateway.ts` — existing gateway and policy orchestration.
- `src/integrations/messaging/registry.ts` — concrete adapter registry.
- `src/integrations/messaging/sofia-handler.ts` — existing Agent/API bridge.
- `src/integrations/messaging/<platform>.ts` — current adapters; keep provider-specific code in their own modules.
- `api/<provider>/...` — only where the deployment host requires a provider-specific webhook route.

Do not create duplicate policy engines, schedulers, session stores, job runtimes, or tool registries inside the messaging subsystem.

## Normalized identity and session rules

Use platform-issued immutable identifiers. A conversation binding should include at least platform, connected bot/account identity, external user ID, conversation/channel ID, and optional thread ID. Keep those fields separate; a channel ID is not a user ID, and a display name is never an authorization identity.

By default, separate sessions by platform/account/conversation. Any optional cross-channel continuity must be enabled by an authenticated account-linking flow and checked against the existing Sofia access policy. Memory retrieval must respect the same owner and workspace boundaries as direct Sofia API requests.

## Reliability

- Treat provider event IDs as idempotency inputs and use an atomic shared deduplicator in multi-worker deployments.
- Do not acknowledge a webhook as successfully processed before the downstream task has been durably accepted, unless the provider protocol requires a different documented acknowledgement strategy.
- Keep run acceptance separate from run completion. Send a short receipt for accepted work and deliver the final result asynchronously.
- Persist delivery attempts or use an existing durable job/outbox system; do not create a second scheduler just for messaging.
- Use bounded retries, timeouts, graceful shutdown, and provider-aware rate limits.
- A notification delivery failure must not rewrite a successful agent run as failed.
- Isolate adapter failures where the provider transport model allows it; expose errors without tokens or message contents.

## Security requirements

- Keep provider tokens and Sofia API credentials server-side.
- Verify webhook signatures against the exact raw request body and enforce a timestamp/replay window where the provider supports it.
- Deny unapproved users/channels by default. An empty allowlist must not accidentally mean allow everyone.
- Enforce payload, text, attachment-count, download-size, and execution-time limits.
- Treat messages, links, and attachments as untrusted input. Attachment fetching needs SSRF-resistant URL validation, DNS/redirect rechecks, private-network blocking, and bounded streaming.
- Use the existing Sofia policy gateway and runtime safety controls for every tool-capable task.
- Log platform, event IDs, run IDs, and safe error categories; redact credentials and avoid logging full private message content by default.

## Rollout order

1. Verify Telegram and Discord transport paths with unit and integration tests; keep provider smoke-test evidence separate.
2. Finish Slack receiver configuration and real test-workspace smoke tests without touching production.
3. Add per-adapter health/configuration reporting and explicit account/session binding.
4. WhatsApp now has a guarded Cloud API transport/adapter/runtime, GET verification challenge, raw-body HMAC verification, explicit Graph API version, phone-number binding, mounted API webhook, and fail-closed allowlists. It still needs CI confirmation and a real Meta-account smoke test before it should be considered operational. LINE also still needs a real-account smoke test.
5. Add Google Chat, Microsoft Teams, Matrix, Signal, Messenger, WeChat, and other requested channels as separate adapters when supported APIs and deployment models are confirmed.
6. Extend the setup wizard to configure multiple accounts, validate credentials without exposing them, and report real connection state.
7. Expand attachment/media support only with secured download and storage paths.

A platform must not be reported as connected merely because it appears in `ChatPlatform`; capability reporting must be derived from the concrete adapter registry and actual transport health.

## Definition of done for each adapter

- Provider signature/authentication and replay behavior tested.
- Sender and conversation identity mapped from trusted provider metadata.
- Unauthorized users/channels denied by default.
- Duplicate event delivery does not create duplicate work.
- Natural text, provider commands, threading, chunking, and final-run delivery tested as applicable.
- Timeouts, provider errors, reconnect/restart behavior, and rate limits covered.
- Secrets are server-side and redacted from logs/errors.
- Setup and health status reflect actual runtime evidence.
- Unit tests and CI pass; real provider smoke test is recorded separately from unit-test evidence.
