# Sofia Desktop Companion (initial local host)

The initial companion is intentionally narrow: it can launch only applications explicitly allowlisted on the computer running the CLI. It does not provide remote shell access, arbitrary process execution, screen capture, mouse control, or keyboard control.

## Requirements

- Node.js 20+
- A reachable Sofia API with the Desktop Companion routes enabled
- An interactive terminal on the local computer
- One or more existing executable paths that the local operator wants to allow

## Configure applications

Set `SOFIA_API_URL` to the Sofia API base URL. Remote URLs must use HTTPS; loopback HTTP is accepted only for local development.

Set `SOFIA_DESKTOP_ALLOWED_APPS` to a JSON object mapping short application IDs to absolute executable paths. Example for Linux:

```sh
export SOFIA_API_URL="https://sofia.example.com"
export SOFIA_DESKTOP_ALLOWED_APPS='{"editor":"/usr/bin/code","browser":"/usr/bin/firefox"}'
```

The executable paths are resolved and checked when the companion starts. Do not point an entry at a shell, command interpreter, script runner, or other general-purpose command processor. Each launch request shows the application ID and exact argument list for local approval.

## Start

From a source checkout:

```sh
npm install
npm run cli -- desktop companion
```

Or, after installing/linking the package's `sofia` CLI:

```sh
sofia desktop companion
```

Enter the Sofia API key into the hidden terminal prompt. The API key is used once to pair and is not written to disk or stored in the companion. The returned companion token is held in memory only and cleared when the process exits; pairing must be repeated after a restart. The companion never stores the master Sofia API key.

Every application launch requires the operator to type `YES` in the local terminal. Cloud-side model output cannot approve an action. Denying or closing the prompt prevents the application from launching.

## Current limits

- This is a CLI host, not a signed native installer or background service.
- Pairing is memory-only; OS Keychain / Credential Manager / Secret Service persistence is not wired yet.
- App launch is the only enabled local capability.
- Screen capture, mouse, and keyboard operations fail closed.
- A packaged desktop UI, native secure credential adapters, and platform-specific automation drivers require separate implementation and security review.

These limits are deliberate. Do not enable `input:control`, `screen:capture`, or arbitrary `process:execute` for this host.
