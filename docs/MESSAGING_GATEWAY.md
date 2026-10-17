# Messaging Gateway (initial adapter foundation)

Status: opt-in gateway primitives and provider request verification helpers. This document does not claim that production webhook servers, polling loops, bot provisioning, or live delivery are configured.

## Safety defaults

- Messaging is disabled unless `enabled: true` is explicitly supplied.
- Unknown users/channels are denied unless an explicit `allowUser` policy permits them.
- The gateway calls an injected message handler. Production wiring must route that handler through the existing Sofia API/SDK and existing authorization/policy checks; adapters must never invoke tools or a separate agent runtime directly.
- Keep bot tokens and Sofia API keys in server-side environment variables or an approved secret provider. Never expose them in client bundles, tests, errors, or logs.
- Verify the exact raw Discord request body and Discord timestamp/signature headers before parsing or trusting an interaction. For Telegram webhooks, compare the received secret-token header to the configured webhook secret.
- Treat attachment URLs as untrusted; a production downloader must block private/loopback/link-local destinations, re-check redirects and DNS, cap response size/time, and avoid forwarding credentials.
- Rate limits in this initial gateway are in-memory and per process. Multi-instance production deployments need a shared limiter and durable deduplication store.

## Integration contract

Implementations of `MessagingAdapter` own transport lifecycle and outbound delivery. Incoming events should be normalized into `InboundMessage` only after provider authentication and identity mapping. Keep attachments metadata-only until a separately secured downloader is invoked.

The existing `createChatCommandHandler` remains the shared command dispatcher for verified `run` commands. The gateway primitives are intentionally additive and do not change the Sofia API, SDK, session store, or public exports.

## Configuration

Supply an explicit `enabled` flag from application configuration and read credentials from environment variables at the composition root. Do not read secrets at module import time. No real provider tokens are needed for unit tests.

## Current limitations

- This commit supplies contracts, security helpers, session-key isolation, rate limiting, lifecycle management, and message chunking.
- Provider-specific Telegram/Discord HTTP/webhook servers, Discord interaction response semantics, real outbound API calls, attachment download, persistent multi-process rate limiting, and end-to-end live tests remain follow-up work.
