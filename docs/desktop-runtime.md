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
