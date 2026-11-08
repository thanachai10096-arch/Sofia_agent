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
- The CLI Companion stores a local execution journal under `~/.sofia/desktop-command-journal` with restrictive directory/file permissions. Completed action outcomes can be resent after a lost response without repeating the native action.
- If the process stops after recording an action as started but before recording its outcome, the action is treated as indeterminate and is not automatically repeated. The operator must inspect the desktop before manually retrying. Screen capture is read-only and is not journaled.

## API

All endpoints are disabled unless the API is constructed with a `DesktopCommandBroker`.

Owner endpoints require `Authorization: Bearer <SOFIA_API_KEY>` and `desktop:connect`:

- `POST /v1/desktop/companion/connect` — issue a new companion token; this replaces the previous connection for that owner.
- `GET /v1/desktop/companion/status` — return connection status and pending command count, never the token.
- `POST /v1/desktop/companion/disconnect` — revoke the owner's companion and reject pending work.

Companion endpoints require `Authorization: Bearer <COMPANION_TOKEN>`:

- `GET /v1/desktop/companion/commands` — long-polling client may poll; currently this endpoint returns immediately with the next command or `null`.
- `POST /v1/desktop/companion/commands/:commandId/complete` — submit a JSON result or a bounded error string for a command claimed by this token.

The companion polls at a conservative interval, applies bounded exponential backoff during Cloud API outages, and treats `401` as revoked pairing. The CLI stores the restricted companion token in the OS credential store, never the Sofia API key.

## Enablement

The API key's configured scope list must explicitly include `desktop:connect`. Brain-side tools additionally require one or both granular scopes:

- `desktop:remote:app:launch` — permit Sofia to request an allowlisted app launch.
- `desktop:remote:input:control` — permit Sofia to request click, type, and key actions.

The server also requires the separate policy gate `SOFIA_ALLOW_REMOTE_DESKTOP=true`; it defaults to disabled. The local Companion must independently grant matching capabilities and show a real approval prompt for every mutating action. The default `SOFIA_API_SCOPES` does not grant any of these scopes. Do not broaden the default scope list globally.

## Not yet implemented

This slice provides authenticated pairing, status, command polling and completion transport plus the in-memory broker primitive. It does not yet include:

- a signed installer and polished background-client UX for Windows/macOS/Linux;
- durable, multi-replica Cloud command broker state and device registry wiring;
- a public WSS transport (the current relay uses HTTPS polling);
- end-to-end validation against a real Railway deployment and physical desktop, including restart/reconnect and OS-specific approval flows.

The reusable client is created with `createDesktopCompanionClient()` and requires an injected credential store, native driver, explicit capability list, application allowlist, and real approval callback. It accepts only HTTPS remote API URLs (loopback HTTP is permitted for local development), does not persist the Sofia API key, and clears its companion token when the API reports revocation.\n\nThe CLI Companion and Brain dispatch adapter are present in this development branch, but this is not evidence of production readiness. The broker is still in-memory, the relay uses HTTPS polling rather than WSS, and physical-device end-to-end tests remain outstanding. Do not enable this feature in Production until durable server-side delivery, device lifecycle wiring, and real desktop verification are complete. Railway deployment and environment changes are intentionally out of scope.
