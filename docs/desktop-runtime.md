# Sofia Desktop Runtime (foundation)

This module is the local-machine capability foundation for Sofia. It is intentionally a library boundary, not a hidden remote-control service.

## Current capabilities

- Discover basic runtime metadata after `system:discover` permission.
- List, read and atomically write text files inside one configured workspace root.
- Execute an explicitly allowlisted executable with an argument array (never through a shell), within the workspace and with output/time limits.
- Apply per-principal capabilities before each operation.

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

## Security boundary

- The workspace root is configured by the local operator; it is not inferred from a request.
- Paths must be relative and are checked against the resolved workspace root.
- Executable launch is off by default. Operators must explicitly allow executable names.
- Arguments are passed without a shell; shell metacharacters are not interpreted as commands.
- Output, file size and command duration are bounded.
- Callers should issue narrow capabilities and keep user approval outside the model-generated task text.
- Do not pass secrets, browser profiles, credential stores, private keys or unrelated home-directory paths as the workspace.
- The current process runner is a policy boundary, **not an OS-level sandbox**. For untrusted workloads, use a real OS/container sandbox and run the local service as a non-admin user.
- Desktop UI control, browser profile access, system-wide discovery and installer packaging are not enabled by this foundation. Add them as separately permissioned adapters with their own tests.
