# Sofia Desktop Companion Relay

This document describes the first relay transport and reusable local Companion client library for connecting a desktop process to a Sofia API instance. A packaged desktop app, OS credential-store adapter, and Brain tool adapter are still separate required components.

## Security model

- The owner authenticates with their existing Sofia API key and the explicit `desktop:connect` scope.
- The API issues a random 256-bit companion bearer token once. The API key is never sent to the companion.
- The server stores only a SHA-256 digest of the companion token.
- A companion token is bound to the API key's derived owner ID. It cannot inspect or complete another owner's command.
- Commands are claimed once, completed once, bounded per owner, and expire. Replacing or disconnecting a companion rejects its pending commands.
- Broker state is in-memory. A server restart drops pairings and pending commands; it does not replay native actions.
- Mutating native actions must still pass the existing local operator approval flow before dispatch. This relay does not grant OS permissions or bypass approvals.

## API

All endpoints are disabled unless the API is constructed with a `DesktopCommandBroker`.

Owner endpoints require `Authorization: Bearer <SOFIA_API_KEY>` and `desktop:connect`:

- `POST /v1/desktop/companion/connect` — issue a new companion token; this replaces the previous connection for that owner.
- `GET /v1/desktop/companion/status` — return connection status and pending command count, never the token.
- `POST /v1/desktop/companion/disconnect` — revoke the owner's companion and reject pending work.

Companion endpoints require `Authorization: Bearer <COMPANION_TOKEN>`:

- `GET /v1/desktop/companion/commands` — long-polling client may poll; currently this endpoint returns immediately with the next command or `null`.
- `POST /v1/desktop/companion/commands/:commandId/complete` — submit a JSON result or a bounded error string for a command claimed by this token.

The companion should poll at a conservative interval and treat `401` as revoked pairing. Tokens must be stored in the OS credential store by the eventual packaged client, not in browser local storage or logs.

## Enablement

The API key's configured scope list must explicitly include `desktop:connect`. The default `SOFIA_API_SCOPES` does not grant this scope. Do not broaden the default scope list globally.

## Not yet implemented

This slice provides authenticated pairing, status, command polling and completion transport plus the in-memory broker primitive. It does not yet include:

- a packaged Windows/macOS/Linux Desktop Companion installer or background client;
- secure OS credential-store integration and device-specific pairing UI;
- the Brain-side remote Desktop tool adapter that calls `broker.dispatch()`;
- delivery of existing desktop approvals to the user's local UI;
- reconnect/backoff UX, multi-device selection, or durable multi-replica broker state.

The reusable client is created with `createDesktopCompanionClient()` and requires an injected credential store, native driver, explicit capability list, application allowlist, and real approval callback. It accepts only HTTPS remote API URLs (loopback HTTP is permitted for local development), does not persist the Sofia API key, and clears its companion token when the API reports revocation.\n\nUntil the packaged host, OS credential-store adapter, and Brain dispatch/approval wiring are complete, the relay is not a usable remote desktop-control feature and should not be enabled in Production. Railway deployment and environment changes are intentionally out of scope.
