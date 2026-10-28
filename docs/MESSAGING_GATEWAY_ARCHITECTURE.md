# Sofia Messaging Gateway Architecture

Status: architecture contract for incremental implementation. This document describes the target design; it is not a claim that every listed platform is implemented or live-tested.

## Goals

- Let people talk to Sofia in their preferred messaging app using ordinary messages; `/run` remains a compatibility command, not a universal prerequisite.
- Route every platform into the existing Sofia API/Agent Runtime, policy gateway, session and job systems. Do not create a second runtime inside a platform adapter.
- Add a platform by implementing one adapter and its tests, without changing the core dispatch contract.
- Keep platform-specific authentication, rate limits, payloads, threading, and delivery semantics inside each adapter.
- Report implemented, configured, connected, and live-tested as distinct states.

## Architecture and message flow

```text
Telegram / Discord / Slack / LINE / WhatsApp / other supported platforms
                             |
                    Platform adapter
          verify provider -> normalize -> send/receive
                             |
                    Messaging Gateway
       validate envelope -> access policy -> dedupe/rate limit
                             |
                     Sofia handler
                             |
                  Existing Sofia API/Runtime
                   /                    \
          session + memory          durable jobs
                   \                    /
                   delivery routing / result notification
                             |
                   originating platform/thread
```

Adapters must never invoke tools or instantiate an agent runtime directly. The gateway hands normalized messages to the configured handler. Long-running work must be tracked through the existing run/job APIs; completion delivery is a notification and must not be the source of truth for run status.

## Existing implementation to preserve

The repository already has relevant building blocks. Extend these instead of creating parallel versions:

- `src/integrations/chat-adapter.ts`: shared dispatch/access-policy/deduplication contracts.
- `src/integrations/messaging/types.ts`: `InboundMessage`, `MessagingIdentity`, attachment metadata, outbound messages, delivery receipts, and adapter interface.
- `src/integrations/messaging/gateway.ts`: gateway lifecycle, adapter registration, dispatch checks, access policy, deduplication and rate limiting.
- `src/integrations/messaging/sofia-handler.ts`: natural-chat and command-compatible bridge into the existing run starter.
- Existing provider adapters and their tests under `src/integrations/messaging/`.
- `api/slack/events.ts`: separate Slack Events API receiver where its serverless raw-body requirements apply.

Do not duplicate the adapter registry, handler, deduplicator, rate limiter, session store, job runtime, or policy gateway. Before modifying a contract, inspect all consumers and preserve backward compatibility.

## Adapter contract

The current `MessagingAdapter` contract in `types.ts` is the source of truth. Each adapter implements:

- `start(signal, onMessage)`: connect or begin polling/webhook consumption; verify provider authentication before forwarding events.
- `send(message)`: send a reply using provider-specific APIs and return a structured delivery receipt.
- `stop()`: stop polling/listeners and release resources safely.

Each adapter owns provider-specific configuration and transport. A platform name in `ChatPlatform` is only a type-level identifier; it is not evidence that a working adapter exists.

## Normalized message and identity rules

The existing `InboundMessage`/ `MessagingIdentity` types are the common envelope. Preserve these rules:

- `platform`, `messageId`, `userId`, `channelId` and `conversationId` must come from verified provider metadata, never from user-controlled message text.
- Keep `accountId`/workspace/bot identity when the platform supports multiple accounts; add fields compatibly only after checking consumers.
- Keep thread/reply identifiers distinct from conversation identifiers when required by a provider.
- Treat text, display names, attachment URLs, filenames, and all external content as untrusted input.
- Do not automatically download, open, execute, or forward attachments. Any downloader must defend against SSRF, unsafe redirects, private/link-local destinations, oversized responses and timeouts.
- A shared Sofia session across apps requires an explicit, authenticated account-linking mechanism. Default to separate external conversation bindings; never merge users merely because their display names match.

## Routing, state and delivery

1. Validate the envelope and provider signature/interaction proof at the adapter or HTTP boundary.
2. Apply user, conversation, workspace and platform access policy. Deny by default when policy is missing or unconfigured.
3. Deduplicate with a stable provider event/message ID using an atomic store for multi-worker deployments. Retries must not create duplicate runs.
4. Apply shared rate limits where needed. Store failures fail closed for protected actions.
5. Dispatch through the existing Sofia handler and API; do not bypass policy or call tools from an adapter.
6. Persist run/job state in Sofia's existing durable system. Use a stable idempotency key for task creation.
7. Deliver acknowledgements and results back to the originating account/conversation/thread. Delivery failures must be observable and must not rewrite a completed run as failed.

## Platform capability and readiness states

Track each platform independently using these states:

- `not_implemented`: no working transport/adapter exists.
- `implemented`: code and automated tests exist, but live credentials or deployment may be absent.
- `configured`: required credentials and allowlists pass validation.
- `connected`: a health check or live connection confirms operation.
- `live_tested`: inbound message, accepted run, and outbound result were verified end-to-end in a controlled environment.
- `degraded` / `disconnected`: previously configured integration is not healthy.

Do not infer readiness from a type union, folder name, setup form, or successful unit tests alone. The exact state must be based on observable evidence.

Based on the current documented/code inventory for this workstream:
- Telegram: adapter/transport code exists; verify its actual configuration and end-to-end health before claiming live readiness.
- Discord: adapter/interaction code exists; command registration, credentials, allowlists and live end-to-end behavior require environment-specific verification.
- Slack: adapter and signed Events API receiver code exist; app credentials, receiver deployment, allowlists and live smoke test remain deployment work.
- LINE, WhatsApp, Google Chat, Microsoft Teams, Signal, Matrix, Messenger, Instagram, WeChat, iMessage, Viber, KakaoTalk, Feishu/Lark, Mattermost, Nextcloud Talk, Zulip, IRC, Nostr, Zalo, QQ, email, SMS and voice: treat as `not_implemented` until a concrete adapter, tests, setup docs and capability evidence exist. This list is a backlog, not a claim of support.

## Security requirements

- Keep bot tokens and Sofia API keys on the server or in an approved secret manager. Never place them in web/mobile bundles.
- Verify provider signatures against the exact raw request bytes where required, and enforce timestamp/replay windows and body-size limits.
- Require explicit sender and conversation/workspace allowlists for initial setup; an empty allowlist must deny.
- Keep authorization checks in the shared gateway/handler even if an adapter has already filtered events.
- Redact credentials and sensitive user content from logs; return generic external errors.
- Use bounded retries/timeouts, graceful shutdown, and per-adapter health reporting.
- Do not loosen existing execution permissions to make messaging integrations easier.

## Implementation sequence

### P0 — contract and reliability
- Preserve current interfaces; map existing adapters and entrypoints.
- Test duplicate adapter registration, authorization denial, duplicate/retried events, malformed envelopes, oversized messages, startup failure, shutdown and delivery failure.
- Verify that one adapter's failure does not silently disable healthy adapters. Keep long-running pollers from blocking gateway startup; use a lifecycle design that reflects the actual transport semantics.
- Make delivery/run state observable without leaking message content or secrets.

### P1 — natural chat end-to-end
- Ensure plain text starts a task on enabled/configured channels, while platform-native slash commands remain compatible.
- Verify acknowledgement, long-running job tracking, and result delivery to the correct conversation/thread.
- Test reconnect, retries, idempotency and process restart against durable stores.

### P2 — new platform adapters
- Prioritize LINE and WhatsApp for broad consumer reach, then Google Chat and Microsoft Teams for workplace use; choose subsequent adapters based on user demand and official API availability.
- For each adapter, require: official API review, transport, normalized inbound/outbound mapping, signature/authentication checks, allowlist support, idempotency, tests, setup guide, and a live smoke test.
- Do not build all platforms into one giant adapter or force every provider into the same webhook/polling mechanism.

### P3 — setup and operations
- Provide per-account setup, secret validation, connection health, enable/disable, test-message action, logs with redaction, and explicit readiness state.
- Support multiple accounts per platform without mixing their credentials, sessions, or allowlists.
- Document hosted and self-hosted setup without changing Production automatically.

## Acceptance criteria

A platform is ready to advertise as supported only when all applicable checks pass:

- [ ] Official API and required permissions reviewed.
- [ ] Adapter normalizes inbound events and sends replies.
- [ ] Authentication/signature validation and replay protection are tested.
- [ ] User/workspace/conversation access policy denies by default.
- [ ] Atomic deduplication and task idempotency cover retries.
- [ ] Natural chat and existing command compatibility are tested.
- [ ] Attachments remain inert unless a secured handling path is explicitly enabled.
- [ ] Long-running result delivery and thread routing are verified.
- [ ] Startup, shutdown, reconnect, failure, and health states are tested.
- [ ] Setup documentation and a controlled live end-to-end test are complete.
- [ ] CI results and exact commit are recorded; no Production changes without explicit approval.
