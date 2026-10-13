# Unified Access Architecture

Status: architecture and shared chat-dispatch foundation. This document is not a claim that every client or provider adapter is already implemented.

## Goal

Web Chat, Desktop, Mobile, Telegram, Discord, Slack, and third-party SDKs must use the same Sofia API and Sofia Core. Channel adapters translate transport-specific events into the existing API contract; they must not contain a second planner, tool registry, or execution engine.

## Existing foundation to reuse

The current repository already has:
- `src/api/server.ts`: authenticated API, run submission, run lookup/cancellation, streaming, quotas, and optional run persistence.
- `src/sdk/client.ts`: HTTPS-enforcing client with async start, reconnectable run polling, cancellation, and job helpers.
- `src/desktop/` and `src/platform/local-runtime.ts`: local capability-gated execution foundations.
- `src/brain/job-runtime.ts`: durable job lifecycle foundation.

These capabilities must be checked against current tests and deployment configuration before treating a deployment as production-ready.

## Request path

1. Web/Desktop/Mobile or a server-side chat adapter receives a user command.
2. The channel authenticates its own user and validates the provider's webhook/signature where applicable.
3. The adapter maps the provider's immutable sender ID and conversation/channel ID to an allowlisted Sofia principal.
4. The adapter uses the Sofia SDK over HTTPS. Privileged Sofia API keys stay on trusted servers, never in browser or mobile bundles.
5. Sofia API validates API key, scope, quota, and run ownership, then forwards work to the existing Sofia Agent/Core.
6. The client tracks the returned run ID through polling or streaming and formats status for its channel.
7. Tool permissions and approval policy are enforced by Sofia regardless of the origin channel.

## Channel implementation boundaries

| Channel | Adapter responsibility | Must not do |
| --- | --- | --- |
| Web Chat | Authenticated application session, stream/poll UI, reconnect | Expose a master API key in frontend code |
| Desktop | Pair local runtime, display approvals, reconnect to runs | Treat remote API access as permission to all local files |
| Mobile | Use authenticated backend, async runs, polling/reconnect | Embed privileged API keys in the app |
| Telegram | Verify webhook configuration/secret, map chat + sender IDs, reply to run status | Trust display names or accept arbitrary chats by default |
| Discord | Verify interactions/signatures, map guild/channel/user, acknowledge within provider limits | Trust message text as identity or skip replay handling |
| Slack | Verify signing secret and timestamp, map workspace/channel/user, acknowledge promptly | Process unverified/replayed events |
| API/SDK | Stable versioned contract, scopes, quotas, errors, reconnectable jobs | Bypass API policy or accept cross-owner run IDs |

## Shared chat dispatcher

`src/integrations/chat-adapter.ts` is a transport-neutral dispatcher intended for provider adapters. It expects a *verified* command envelope, checks an explicit access policy, limits task size, claims a provider message ID for deduplication, and submits through the same Sofia client API. The caller must implement platform signature verification and use a durable, atomic dedupe store with TTL in production. An in-memory dedupe map is suitable only for tests/single-process development.

## Delivery order

### P0 — API and security contract
- Verify authentication/scopes, owner checks, quota/rate limits, cancellation, run-store behavior, and workspace isolation.
- Define channel-to-Sofia identity linking and revocation.
- Enforce the same Tool Policy and approval requirements for every channel.
- Never expose secrets, internal stack traces, or privileged tool output to a channel by default.

### P1 — Web Chat and SDK
- Reuse `SofiaClient.start()`, `getRun()`, `cancel()`, and the existing stream endpoint.
- Add a browser-facing backend/BFF so the master API key stays server-side.
- Add reconnectable conversation/session storage and SSE reconnect semantics.
- Test owner isolation, expired credentials, duplicate requests, network loss, and cancellation.

### P2 — Desktop and Mobile
- Desktop connects to a paired Local Runtime with explicit capability grants and approval UX.
- Mobile is a control/monitoring client first; local-device execution is a separate capability and must not be implied.
- Add secure pairing/revocation, session expiry, and reconnect flows.
- Test Windows, macOS, Linux, iOS, and Android only where an actual supported client/runtime exists.

### P3 — Telegram, Discord, Slack
- Implement one provider adapter per platform, each with its own signature verification and webhook/event rules.
- Use a server-side Sofia SDK client and a least-privilege API key scoped to `agent:run` and only necessary read permissions.
- Require explicit sender/chat/workspace allowlists initially.
- Use durable idempotency, bounded message lengths, safe status formatting, rate limits, and clear approval handling.
- Add provider-specific integration tests using signed fixtures; do not claim live integration without real provider credentials and webhook tests.

### P4 — Production readiness
- Add end-to-end tests from each channel to a disposable workspace and independent result verification.
- Test provider retries, duplicate delivery, timeout, cancellation, server restart, job recovery, and authorization failures.
- Add metrics for accepted/rejected commands, run latency, failures, and approval waits without logging secrets or raw sensitive prompts.
- Document deployment, secrets, webhook setup, data retention, and incident response.

## Acceptance criteria

- All channels use the same API and Sofia Core.
- An unauthorized user cannot submit, read, cancel, or approve another user's run.
- Duplicate provider events do not create duplicate runs.
- Losing a client connection does not silently lose a run ID or expose another user's run.
- Every tool action remains subject to Sofia's policy and approval enforcement.
- Provider adapters pass signature/replay tests and a real provider smoke test before being described as operational.
- Typecheck, unit tests, build, CI, and end-to-end evidence are reported separately; no one check substitutes for the others.
