# Sofia Desktop Companion

The local Companion currently launches only explicitly allowlisted applications. It does not provide remote shell access, arbitrary process execution, screen capture, mouse control, or keyboard control.

## Requirements

- Node.js 20+
- A reachable Sofia API with the Desktop Companion routes enabled
- An interactive local terminal for first-time pairing and explicit revocation
- A supported OS credential store (macOS Keychain, Windows Credential Manager, or Linux Secret Service)
- One or more existing executable paths that the local operator wants to allow

## Configure applications

Set `SOFIA_API_URL` to the Sofia API base URL. Remote URLs must use HTTPS; loopback HTTP is accepted only for local development.

Set `SOFIA_DESKTOP_ALLOWED_APPS` to a JSON object mapping short application IDs to absolute executable paths. Example for Linux:

```sh
export SOFIA_API_URL="https://sofia.example.com"
export SOFIA_DESKTOP_ALLOWED_APPS='{"editor":"/usr/bin/code","browser":"/usr/bin/firefox"}'
```

The executable paths are resolved and checked when the companion starts. Do not point an entry at a shell, command interpreter, script runner, or other general-purpose command processor.

## Start and approve actions

From a source checkout:

```sh
npm install
npm run desktop:companion
```

Or, after installing/linking the package's `sofia` CLI:

```sh
sofia desktop companion
```

On first pairing, enter the Sofia API key into the hidden terminal prompt. It is used once and is never saved. The returned restricted Companion token is stored using `@napi-rs/keyring` in the operating system credential store:

- macOS: Keychain
- Windows: Windows Credential Manager
- Linux: Secret Service (GNOME Keyring, KWallet, or another Secret Service provider). Linux is configured to require Secret Service and does not silently fall back to the non-persistent kernel keyring.

On later starts, the Companion attempts to reuse the stored token. If Sofia no longer recognizes it (for example, after the API process restarts), the local token is cleared and the operator is prompted to pair again with a Sofia API key. The server stores only the SHA-256 digest of the random Companion token, its owner ID, and activity timestamps in the protected `.sofia/desktop-companions` directory. Pairings can be restored after a Sofia API restart for up to seven days of inactivity. This requires `SOFIA_WORKSPACE` (or the process working directory) to be on persistent storage; on Railway, attach a persistent volume and place the workspace on that volume before relying on restart recovery. Pending desktop commands are never persisted or replayed after a restart; any in-flight action fails closed and must be submitted again.

For each application launch, the Companion opens a local browser approval page. The page is served only on `127.0.0.1`, uses a one-time random approval token in the URL fragment, rejects cross-origin decisions, expires automatically, and is bound to the exact requested application ID and arguments. Approve or deny on the computer itself. If the local browser cannot be opened, the action fails closed.

Stop the local process with Ctrl+C; this retains the OS credential. To revoke the server-side pairing and remove the local credential, run:

```sh
sofia desktop companion disconnect
```

That explicit revoke operation asks for the Sofia API key in a hidden prompt. The key is used only for the revoke request and is not saved.

## Current limits

- This is still a Node.js local host, not a signed native installer or background service.
- GUI approval uses the system browser; a dedicated native approval window is not included.
- App launch is the only enabled local capability.
- Screen capture, mouse, and keyboard operations fail closed.
- The durable pairing store is local-filesystem based and intended for a single API instance with a persistent volume. Do not run multiple API replicas against independent ephemeral disks; shared multi-replica coordination and transactional locking are not implemented.
- Linux requires an unlocked Secret Service session. Headless Linux servers without Secret Service cannot use this persistent credential adapter.
- This does not make a computer unnecessary: users without a PC continue to use the separately hosted Mobile Workspace / Cloud Browser path.

These limits are deliberate. Do not enable `input:control`, `screen:capture`, or arbitrary `process:execute` for this host.
