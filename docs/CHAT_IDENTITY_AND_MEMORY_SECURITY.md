# Chat Identity, Session, and Memory Security Boundary

Status: design/implementation gate (not yet implemented)

## Why this boundary exists

The messaging adapters authenticate a platform event and derive immutable platform user and conversation IDs. The shared Sofia API, however, authenticates a bearer API key and currently derives `principalId`, run ownership, session ownership, and API Memory ownership from that API key's `keyId`.

A Telegram deployment normally uses one server-side Sofia API key for every Telegram user. Consequently, adding a direct call to the existing Memory API from the Telegram handler would store every Telegram user's memories under the same API-key owner. A per-user `sessionId` does not change the API's authenticated `principalId` and is not an authorization boundary.

Do not wire chat memory writes by passing a platform user ID as an ordinary request field or by trusting a client-supplied principal header.

## Current verified behavior

- The Telegram adapter derives `userId` from Telegram's authenticated `from.id` and `conversationId` from `chat.id`.
- The chat dispatcher builds a stable session key from platform, user, and conversation identifiers.
- The Sofia API scopes runs and Memory endpoints to the authenticated API key identity (`auth.keyId`).
- The API Memory write endpoint requires `memory:write`; the Telegram runtime's current client path does not provide a separately authenticated per-user principal.
- The explicit-memory parser exists, but its existence alone does not authorize a write or provide an authenticated owner identity.
- Discord currently has a signed HTTP Interactions route and a separate bot transport path. Ordinary guild message chat requires a Gateway adapter and the relevant Discord privileged intent/configuration; do not remove the existing slash-command route.

## Required design before chat Memory writes

Use an explicit server-to-server delegated identity protocol. The platform adapter must derive the identity only from a successfully authenticated provider event. The API must independently authenticate the delegation envelope using a server-only secret and a narrowly scoped API credential.

The protocol must include:

1. A versioned canonical payload containing platform, immutable provider user ID, conversation/channel ID, issued-at time, and a unique event/request nonce.
2. An HMAC signature over the exact canonical payload, verified with a constant-time comparison. Never log the payload signature or secret.
3. A strict timestamp window, nonce replay protection, payload size limits, and allowlisted platform values.
4. A dedicated delegation scope. Ordinary `agent:run` or `memory:write` scopes must not silently imply identity delegation.
5. An owner namespace that includes the authenticated tenant/integration owner and platform identity, for example `tenant:<tenant-key-id>:telegram:<provider-user-id>`. Never allow one tenant's integration to claim another tenant's identity.
6. API-side derivation of the principal from the verified envelope. Ignore/reject caller-supplied `principalId`, owner IDs, or unsigned identity headers.
7. Consistent owner scoping for run records, job records, sessions, memory reads/writes/deletes, quotas, and cancellation/status operations. Conversation/session keys must not be used as a substitute for owner authorization.
8. Explicit opt-in memory capture only. The existing explicit-request parser may propose a memory candidate; the authenticated owner, policy, secret redaction, injection guard, size limits, and user-visible confirmation/feedback remain enforced.
9. Tests proving two users in the same group/channel cannot read, overwrite, delete, poll, cancel, or resume each other's data; replayed, expired, malformed, unsigned, and cross-tenant delegation attempts fail closed.

## Discord ordinary-message adapter gate

Keep the existing signed HTTP Interactions endpoint and slash commands intact. Add ordinary message support only through a separate Discord Gateway adapter with:

- verified bot connection and strict allowlists for both immutable user IDs and channel IDs;
- an explicit deployment setting documenting the privileged Message Content Intent requirement;
- self/bot/webhook filtering, message replay deduplication, rate limits, bounded payloads, and safe mention/attachment handling;
- per-user/per-channel session identity, but API ownership still comes from the verified delegation protocol above;
- no broad permission expansion and no fallback that treats every message in an allowed channel as trusted;
- tests for unauthorized users/channels, bot loops, duplicate events, missing intent/configuration, long messages, and cross-user isolation.

## Rollout sequence

1. Preserve current API-key owner behavior for existing clients.
2. Implement and test the delegated-identity verifier as an additive, opt-in API capability.
3. Add SDK support for signed server-to-server chat delegation without exposing the delegation secret to browsers or mobile clients.
4. Wire explicit Memory capture only after API-side identity verification and ownership tests pass.
5. Add the Discord Gateway adapter independently; keep HTTP Interactions working.
6. Run targeted tests, full typecheck/tests/build, cross-platform CI, sandbox/browser integration, and CodeQL on the resulting commit.
7. Deploy only to Preview after the Vercel rate limit clears; do not alter Production or add provider secrets as part of this work.

## Non-goals / safety constraints

- Do not trust user IDs, tenant IDs, or principal IDs supplied in task text, JSON bodies, query strings, or unsigned headers.
- Do not merge Telegram users into the shared bot API-key Memory owner.
- Do not weaken existing API scopes, allowlists, policy gates, approval checks, or run ownership checks.
- Do not replace the current Discord HTTP Interactions implementation.
- Do not claim ordinary Discord chat, chat Memory writes, or end-to-end identity isolation are implemented until the acceptance tests prove them.
