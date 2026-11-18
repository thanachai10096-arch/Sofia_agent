# Sofia autonomous sandbox

The Brain exposes `sandbox.exec` only when a digest-pinned container image and a host-only attestation secret are configured. Commands run in a per-principal/per-run disposable project snapshot; they never execute against the host WorkspaceRuntime. Sandbox changes are not copied back to the host project. Use `sandbox.propose_changes` to generate hash-guarded edits; then pass those operations to `workspace.apply_patch`, which retains the existing host approval and conflict-checking flow. New files and deletions are not auto-promoted by this initial proposal path.

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

## Railway deployment note

The current Sofia Railway staging service is configured with the Railpack builder. That configuration does not provide a Docker daemon or Docker socket to the application container. Therefore, setting `SOFIA_SANDBOX_IMAGE` and `SOFIA_SANDBOX_ATTESTATION_SECRET` on that service is not sufficient to make `ContainerSandbox` operational: the `docker` CLI would have no trusted daemon to control.

Keep the sandbox disabled on this Railway service until a separately provisioned, trusted sandbox host/runner is available and connected through an authenticated host-owned adapter. Do not mount the Docker socket from an untrusted/shared host or silently switch the main service to privileged Docker-in-Docker. The runner must enforce per-run isolation, resource limits, public-internet-only egress, tenant separation, cleanup, and auditable job identity. The current Railway staging service has not been changed or deployed as part of this work.
