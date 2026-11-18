# Sofia autonomous sandbox

The Brain exposes `sandbox.exec` only when a digest-pinned container image and a host-only attestation secret are configured. Commands run in a per-principal/per-run disposable project snapshot; they never execute against the host WorkspaceRuntime. Sandbox changes are not copied back to the host project.

## Required host configuration

- `SOFIA_SANDBOX_IMAGE`: immutable OCI image reference ending in `@sha256:<64 hex characters>`. The image must already exist on the Docker host; image pulls are disabled.
- `SOFIA_SANDBOX_ATTESTATION_SECRET`: secret-manager value with at least 32 characters. Never expose it to the agent or place it in the project workspace.
- `SOFIA_ALLOW_SANDBOX=true`: enables the sandbox tool through the execution policy (enabled by default in code, but may be explicitly disabled).

## Network

Sandbox network access is enabled by default when the sandbox is configured. Set `SOFIA_SANDBOX_ALLOW_NETWORK=false` to disable it. Enabled containers use Docker bridge networking so they can access public package registries and internet resources.

**Important:** Docker bridge networking alone does not enforce a public-internet-only egress boundary. Depending on the Docker host and its firewall, a container may also be able to reach private/LAN services. Production hosts should enforce outbound firewall rules or an egress proxy that blocks loopback, RFC1918, link-local, cloud metadata and internal service ranges. Do not treat bridge networking as an egress allowlist.

The separate Browser/network tools remain governed by `SOFIA_ALLOW_NETWORK` and `SOFIA_ALLOWED_HOSTS`.

The supervisor exposes a spend-meter hook, but the current command-tool composition does not yet ingest metered outbound-service charges. Model-provider spend remains separately controlled by the Brain token budget. Do not interpret `SOFIA_AUTONOMY_MAX_SPEND_USD` as a hard cap on arbitrary third-party billing until a trusted billing/egress meter is connected.

## Limits and isolation

- Digest-pinned, preloaded image; no implicit image pull
- Read-only container root, writable isolated project snapshot
- All Linux capabilities dropped; no-new-privileges
- 1 CPU, 512 MiB memory, 128 PIDs, 64 MiB temporary filesystem
- Per-command timeout and output byte limit
- Project staging excludes Git metadata, dependency/build caches, environment files, credential/config directories, key material, databases, symlinks and special files
- Per-run HMAC attestation, budget accounting, revocation and workspace disposal

This is container isolation, not a guarantee against kernel or container-runtime vulnerabilities. A trusted Docker daemon and host-level egress controls are required.
