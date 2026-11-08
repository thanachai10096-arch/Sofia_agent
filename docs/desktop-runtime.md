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


## Redis-backed Cloud device registry (foundation only)

`RedisDesktopDeviceRegistryStore` implements the `DesktopDeviceRegistryStore` contract using the existing minimal Redis `eval` client interface. It provides:

- Atomic device creation and owner-index insertion in one Lua script, with a configurable per-owner device cap.
- Owner-scoped get/list/revoke operations; each operation checks the owner ID in the serialized record inside Redis, not only in application memory.
- Durable revocation timestamps and refusal of repeated revocation.
- Redis Cluster-compatible key grouping: each owner's device record and index use the same hash tag. Raw owner IDs are SHA-256 hashed before being used in key names.
- Encrypted credentials remain encrypted envelopes from `DesktopDeviceCredentialVault`; the Redis store does not receive or return plaintext device secrets.

Example:

`ts
import {
  RedisDesktopDeviceRegistryStore,
  DesktopDeviceCredentialVault,
} from "../src/desktop/index.js";

const registry = new RedisDesktopDeviceRegistryStore({
  client: redisClient, // node-redis v4-compatible eval client
  keyPrefix: "sofia:prod:desktop:devices",
  maxDevicesPerOwner: 25,
});
const vault = new DesktopDeviceCredentialVault({ masterKey: masterKeyFromKms });
`

Redis must be configured with persistence, replication, network access controls, TLS, and backups appropriate to the deployment. The `eval` client must be a trusted application dependency; never accept Redis credentials or key prefixes from user/model input. This registry is a storage primitive only: no public enrollment/list/revoke API routes, relay command queue, outbound Companion connection, or mobile UI are wired yet. Keep the feature disabled until those routes and the end-to-end authorization flow are implemented and tested.


## Redis desktop command queue (delivery foundation only)

`RedisDesktopCommandQueue` is an opt-in Redis-backed queue partitioned by owner and paired device. It provides atomic enqueue, claim-with-lease, completion, retryable failure, and status lookup operations.

- Enqueue supports a client idempotency key. Redis stores only a SHA-256-derived key name; the raw idempotency key is not persisted in the command record.
- Claim uses a random lease token and expiry. Multiple workers cannot claim the same pending command at the same time.
- Expired leases are recovered atomically; commands are retried up to `maxAttempts` and then marked failed.
- Completion/failure requires the current lease token, so stale workers cannot overwrite a newer lease result.
- Payload size, queue active capacity, retry count, lease duration, and idempotency TTL are bounded.
- All queue keys for one owner/device share a Redis Cluster hash slot.

Example:

`ts
import { RedisDesktopCommandQueue } from "../src/desktop/index.js";

const queue = new RedisDesktopCommandQueue({
  client: redisClient,
  keyPrefix: "sofia:prod:desktop:commands",
  maxCommandsPerDevice: 500,
});
const { command, duplicate } = await queue.enqueue({
  ownerId,
  deviceId,
  type: "desktop.input.click",
  input: { x: 100, y: 80 },
  idempotencyKey: clientRequestId,
});
const lease = await queue.claim(ownerId, deviceId, { leaseMs: 30_000 });
`

**Delivery semantics:** this is at-least-once command delivery, not exactly-once side-effect execution. A Companion must persist/deduplicate command IDs before executing actions, and must send completion only after it has recorded the outcome. If a lease expires after an action ran but before completion was acknowledged, the command may be delivered again; the Companion must return the recorded outcome rather than repeat the side effect.

The queue is not yet connected to API routes, device authentication, outbound Companion WSS, Brain tool routing, result streaming, or the mobile UI. Do not expose these operations publicly or claim remote desktop control is available until the full authorization and end-to-end path is implemented and tested. Redis must be private, TLS-protected, access-controlled, and configured with suitable persistence/replication/backups.
