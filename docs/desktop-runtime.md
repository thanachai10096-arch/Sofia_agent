# Sofia Desktop Runtime (foundation)

This module is the local-machine capability foundation for Sofia. It is intentionally a library boundary, not a hidden remote-control service.

## Current capabilities

- Discover basic runtime metadata after `system:discover` permission.
- List, read and atomically write text files inside one configured workspace root.
- Execute an explicitly allowlisted executable with an argument array (never through a shell), within the workspace and with output/time limits.
- Apply per-principal capabilities before each operation.
- Provide an opt-in native desktop adapter contract for screen capture, allowlisted app launch, mouse clicks, text entry and restricted key presses; interactive actions require an out-of-band user approval callback.

## Quick start

```ts
import { DesktopRuntime, createDesktopPrincipal } from "../src/desktop/index.js";

const runtime = new DesktopRuntime({
  workspaceRoot: "/path/to/approved/project",
  allowedExecutables: ["git", "node", "npm"],
  commandTimeoutMs: 30_000,
});
const principal = createDesktopPrincipal("local-user", [
  "system:discover",
  "workspace:list",
  "workspace:read",
  "workspace:write",
  "process:execute",
]);
const info = await runtime.discover(principal);
const files = await runtime.listFiles(principal);
```

## Optional Sofia tool integration

The desktop adapter is opt-in and is not added to the default tool registry automatically. A local host can add it explicitly:

```ts
import { createDesktopTools, createToolRegistry, createBuiltinTools } from "../src/index.js";

const tools = createToolRegistry([
  ...createBuiltinTools(),
  ...createDesktopTools({ runtime, principal }),
]);
```

The adapter exposes `desktop.system.discover`, `desktop.workspace.list_files`,
`desktop.workspace.read_file`, `desktop.workspace.write_file`, and
`desktop.process.run`. The registry gateway classifies writes as write effects and
process launch as a shell effect, so the existing execution policy and approval flow
can block them. File and process permissions are also checked again by
`DesktopRuntime` against the host-supplied principal.

The API maps authenticated API-key scopes to desktop capabilities; request JSON cannot grant itself permissions:

- `desktop:discover` → `system:discover`
- `desktop:workspace:list` → `workspace:list`
- `desktop:workspace:read` → `workspace:read`
- `desktop:workspace:write` → `workspace:write`
- `desktop:process:execute` → `process:execute`

Grant these scope strings only to trusted API keys that should have those local capabilities.
File writes still pass through the existing write approval policy. Process execution additionally
requires `SOFIA_ALLOW_SHELL=true`, the `desktop:process:execute` scope, and an explicit
comma-separated `SOFIA_DESKTOP_ALLOWED_EXECUTABLES` allowlist. The allowlist defaults to
empty. The desktop runtime remains bounded to the workspace configured when Sofia starts.

## Native desktop adapter (local host only)

The native adapter is deliberately driver-injected: the repository does not silently install an OS-control dependency or start a remote-control daemon. A trusted local host supplies a platform-specific `DesktopHostDriver` and a real approval prompt:

```ts
import { createDesktopAdapterTools, createDesktopPrincipal } from "../src/desktop/index.js";

const principal = createDesktopPrincipal("local-user", [
  "screen:capture",
  "app:launch",
  "input:control",
]);
const tools = createDesktopAdapterTools({
  principal,
  config: {
    driver: nativeDriver,
    allowedApplications: ["calculator"],
    requestApproval: (action) => showNativeApprovalDialog(action),
  },
});
```

The driver must be implemented and packaged by a trusted platform host for Windows/macOS/Linux; it is not provided by this adapter contract alone. The adapter limits screenshots to 5 MiB, validates coordinates and key names, limits typed text to 2,000 characters, and requires an explicit user approval for every application launch, click, text-entry, and keypress action. Screen capture needs the separate `screen:capture` grant. The existing execution policy also classifies app launch/input as destructive effects, so it remains blocked unless the operator deliberately enables that class of action. App launch additionally requires shell effects to be enabled by policy. For a production host, configure these settings locally and only after reviewing the risk; never allow the model to edit policy settings.

Do not expose this adapter directly from a public API server: it is intended to be constructed by the local host running on the user's own machine. A remote server cannot safely assume that its OS is the user's desktop.

## Paired local desktop action host

The repository now includes `startLocalDesktopActionHost`. It is an explicitly started loopback service, not a background daemon. It binds only to `127.0.0.1`, creates a one-time pairing code through `onPairingCode`, and issues a time-limited scoped bearer token only after the requested capabilities pass the local operator's allowlist.

The host exposes only the native desktop adapter actions—screen capture, allowlisted application launch, click, text entry and restricted keypress. It does **not** expose arbitrary shell commands or filesystem endpoints. Input and app-launch actions go through the configured `requestApproval` callback. Text-entry approval receives the exact text that will be typed, so a real UI can display it before asking the user.

Example configuration (the executable path and approval UI must be supplied for the target OS; `workspaceRuntime` is the host's initialized `WorkspaceRuntime`):

```ts
import {
  createNativeDesktopDriver,
  startLocalDesktopActionHost,
} from "../src/desktop/index.js";

const host = await startLocalDesktopActionHost({
  allowedCapabilities: ["screen:capture", "input:control", "app:launch"],
  // Exact origins only; never use "*" or allow an origin just because it is convenient.
  allowedOrigins: ["https://your-app.example"],
  driver: createNativeDesktopDriver({
    applications: {
      calculator: { executable: "/path/to/operator-approved/calculator" },
    },
  }),
  runtime: workspaceRuntime,
  allowedApplications: ["calculator"],
  requestApproval: (action) => showNativeApprovalDialog(action),
  onPairingCode: (code, expiresAt) => showPairingCodeToUser(code, expiresAt),
});

// Keep host.url and the pairing token local. Call host.close() to revoke sessions and stop listening.
```

Pair a client with `POST /pair` and JSON `{ "code": "...", "capabilities": ["input:control"] }`. Then call `POST /action` with `Authorization: Bearer <token>` and JSON `{ "tool": "desktop.input.click", "input": { "x": 10, "y": 20 } }`. Capabilities in the pairing request can only be a subset of `allowedCapabilities`. Configure `allowedOrigins` as exact HTTP(S) origins if a browser frontend must call the host; origin checks and the loopback Host check both apply. The default policy permits only same-port loopback origins.

This host is a local bridge for a trusted frontend/companion; it does not itself connect a cloud-hosted Sofia run to the user's machine. The app must deliberately invoke the local bridge, keep the token out of model context and logs, and present a genuine user approval prompt. The CI suite verifies mocked drivers and protocol security, not real OS input/display behavior. A signed installer, OS-specific packaging, and real-machine end-to-end verification remain required before production use.

## Security boundary

- The workspace root is configured by the local operator; it is not inferred from a request.
- Paths must be relative and are checked against the resolved workspace root.
- Executable launch is off by default. Operators must explicitly allow executable names.
- Arguments are passed without a shell; shell metacharacters are not interpreted as commands.
- Output, file size and command duration are bounded.
- Callers should issue narrow capabilities and keep user approval outside the model-generated task text.
- Do not pass secrets, browser profiles, credential stores, private keys or unrelated home-directory paths as the workspace.
- The current process runner is a policy boundary, **not an OS-level sandbox**. For untrusted workloads, use a real OS/container sandbox and run the local service as a non-admin user.
- A production native driver, authenticated loopback pairing service and signed installer are still separate deliverables; this PR adds the capability/approval contract, not those packaged components.
- Do not grant screen/input capabilities to an API key that only needs ordinary server-side agent execution.


## Signed Cloud Relay protocol foundation (not a connected relay yet)

The desktop package also exports a request-authentication primitive for a future outbound Desktop Companion connection:

- `signDesktopRelayRequest` signs the device ID, HTTP method, exact request path (including query), timestamp, nonce, and SHA-256 hash of the exact body using HMAC-SHA256.
- `verifyDesktopRelayRequest` checks the signature with a constant-time comparison, enforces a bounded clock-skew window, and consumes the nonce to reject replay.
- Device credentials must be random, device-specific secrets of at least 32 bytes. They are not Sofia API keys and must never be exposed to the model or browser UI.
- `DesktopRelayReplayGuard` is a bounded in-memory implementation intended for a single process and tests. It fails closed when full. A horizontally scaled Cloud Relay must replace it with a shared atomic nonce store (for example Redis with expiry and SET-NX semantics) before accepting production traffic.

Example:

```ts
import {
  createDesktopRelayNonce,
  signDesktopRelayRequest,
  verifyDesktopRelayRequest,
  DesktopRelayReplayGuard,
} from "../src/desktop/index.js";

const request = {
  deviceId: "desktop-device-0001",
  method: "POST",
  path: "/v1/desktop-relay/commands/claim",
  timestamp: Date.now(),
  nonce: createDesktopRelayNonce(),
  body: JSON.stringify({ waitSeconds: 20 }),
};
const headers = signDesktopRelayRequest(request, deviceSecret);
const accepted = verifyDesktopRelayRequest(
  request, headers, deviceSecret, new DesktopRelayReplayGuard(),
);
```

This is only the cryptographic request boundary. It does **not** implement device enrollment, cloud-side device ownership/storage, command queues, WebSocket/long-poll delivery, result streaming, offline/reconnect handling, or API-to-companion routing. The existing loopback host remains loopback-only. Do not describe phone-to-PC control as available until those pieces are implemented and tested end to end.

## Cloud device registry and credential vault (foundation only)

The desktop package exports a `DesktopDeviceRegistryStore` contract and `DesktopDeviceCredentialVault` primitive for a future authenticated Cloud Relay enrollment flow.

- The registry contract requires owner-scoped lookup/list/revoke operations and atomic device-ID creation. A production implementation must use durable shared storage and enforce ownership in its queries; process-local maps are not suitable for multi-instance deployments.
- The vault encrypts each device's random HMAC secret with AES-256-GCM. The 32-byte master key must be supplied by a KMS or secret manager and kept separate from the registry database. The authenticated encryption data binds the ciphertext to both the owner ID and device ID, preventing a credential row from being moved between accounts/devices.
- The raw per-device secret should be shown to the Companion only once at enrollment, then stored in the OS credential manager. Never return it from ordinary device-list APIs, place it in model context, or write it to logs.
- This is not yet an enrollment API or a durable registry implementation. Command delivery, outbound Companion transport, result streaming, and mobile control UI remain separate work. Do not advertise phone-to-PC remote control as available until the end-to-end path is implemented and tested.


### Redis-backed device registry

The optional `RedisDesktopDeviceRegistryStore` implements the device-registry persistence
boundary for deployments that inject a shared Redis client. Create and revoke operations
use atomic Lua scripts; owner indexes are separate from record keys, and owner/device
identifiers are SHA-256 hashed before being used as Redis keys. Reads and list results
are checked against the stored owner ID again.

The registry stores only the encrypted credential envelope produced by
`DesktopDeviceCredentialVault`, never the plaintext device HMAC secret. Configure
Redis availability, persistence, backups, access controls, TLS, and an environment-
specific key prefix operationally before using this store. Redis errors fail closed.

This adapter is a persistence primitive only. It does not create enrollment or pairing
HTTP endpoints, authenticate mobile users, deliver relay commands, or connect a
Desktop Companion to the Cloud. The in-memory replay guard and multi-instance nonce
storage remain separate concerns.


## Single-use device enrollment foundation

The desktop package also exports `DesktopDeviceEnrollmentService` and
`RedisDesktopEnrollmentChallengeStore`.

- An authenticated owner starts enrollment and receives a 256-bit random pairing code. Only its SHA-256 hash is stored in the challenge store.
- The Redis challenge adapter uses an expiring key and an atomic GET+DEL Lua script, so a code is consumed at most once across API workers.
- The companion submits the code, a freshly generated 32–128 byte device secret, a display name, and an explicit capability set over TLS. The service resolves the owner from the stored challenge and encrypts the device secret with the owner/device-bound credential vault before creating the registry record.
- The code expires after five minutes. A failed completion after code consumption requires the owner to start a new enrollment; this is intentionally fail-closed.
- The companion must persist its plaintext device secret only in the operating system credential manager. The secret must never be logged, returned by list endpoints, or placed in model context.

The API exposes optional, injectable routes when `SofiaApiConfig.desktopEnrollment` is supplied:

- `POST /v1/desktop/enrollments` — requires the `desktop:manage` scope; creates a five-minute code owned by the authenticated API key.
- `POST /v1/desktop/enrollments/complete` — Companion submits the code, display name, explicit capabilities, and a 32-byte base64url device secret. The one-time code is the credential; this route does not accept a caller-supplied owner ID or require a Sofia API key. It requires the configured atomic shared rate limiter and fails closed when the limiter is unavailable.
- `GET /v1/desktop/devices` — requires `desktop:manage`; lists only the authenticated owner's devices and never returns credential envelopes.
- `DELETE /v1/desktop/devices/:deviceId` — requires `desktop:manage`; owner-scoped durable revocation.

The API host must inject a shared Redis device registry, Redis challenge store, KMS-managed vault master key, and atomic completion rate limiter. Do not enable the public completion route without these shared dependencies. The current completion limiter keys by the direct socket peer address; deployments behind a reverse proxy must also enforce per-client/IP limits at the trusted public edge rather than trusting arbitrary forwarded headers. Enforce HTTPS at the public edge and do not expose the local Desktop Action Host to the Internet.

These routes are not wired into the default `src/api/entrypoint.ts` runtime yet, and end-to-end Companion onboarding is still pending. The service/API route tests do not constitute a live Redis or cloud deployment test.
