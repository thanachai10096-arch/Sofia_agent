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

## Remote runner client

Sofia can use an independently hosted runner instead of requiring a Docker daemon in the Railway application service:

- `SOFIA_REMOTE_SANDBOX_URL`: HTTPS base URL of the trusted runner API.
- `SOFIA_REMOTE_SANDBOX_TOKEN`: host-only bearer token (minimum 32 characters).
- `SOFIA_SANDBOX_ATTESTATION_SECRET`: still required for Sofia's local per-principal/per-run attestation.
- `SOFIA_SANDBOX_ALLOW_NETWORK=false`: host-controlled network disable switch; the model cannot override it.

When both remote URL and token are configured, the factory selects `RemoteSandbox` ahead of the local Docker adapter. The client sends a bounded base64 project snapshot to `POST /v1/sandbox/execute` with protocol version 1, request ID, a SHA-256 digest over the sorted snapshot paths and contents, command, arguments, working directory, timeout, output limit and the host-approved network flag. The runner independently recomputes and verifies the snapshot digest before staging or executing it, then echoes the protocol version and request ID and returns stdout, stderr, exit code, and updated files. Returned paths must match files in the submitted snapshot; new files and deletions are not promoted through this first workflow. The client rejects path traversal, duplicate/unknown paths, oversized responses and malformed protocol replies.

**The remote runner service is a separate deployment and is not included or provisioned by this client change.** It must authenticate the bearer token, enforce per-request container isolation and resource limits, validate every request independently, never mount the Railway app filesystem, and apply a host-level egress firewall that blocks loopback, private, link-local, metadata and internal service ranges. If network egress cannot be restricted to approved public destinations, it must run with networking disabled. Never expose the token to the model or store it in the project workspace.

Required runtime configuration to enable the client is `SOFIA_ALLOW_SANDBOX=true`, `SOFIA_SANDBOX_ATTESTATION_SECRET`, `SOFIA_REMOTE_SANDBOX_URL`, and `SOFIA_REMOTE_SANDBOX_TOKEN`, plus an authenticated `principalId`. Do not set these on Railway until the runner service is deployed and independently security-tested.

### Running the standalone runner service

The repository now includes `createRemoteSandboxRunnerServer()` and a standalone entrypoint (`npm run build && npm run runner:start`). Run this process on a dedicated Linux VM or host with a trusted Docker daemon; do not deploy it as another ordinary Railpack service unless that service genuinely has a separately secured container runtime.

Runner host variables:

- `SOFIA_RUNNER_SANDBOX_IMAGE`: preloaded immutable OCI image ending in `@sha256:<64 hex>`.
- `SOFIA_REMOTE_SANDBOX_TOKEN`: same high-entropy secret configured on Sofia's host as `SOFIA_REMOTE_SANDBOX_TOKEN`.
- `PORT`: listener port (default 8080).
- `SOFIA_RUNNER_MAX_CONCURRENCY`, `SOFIA_RUNNER_MAX_REQUEST_BYTES`, `SOFIA_RUNNER_MAX_SNAPSHOT_BYTES`, `SOFIA_RUNNER_MAX_TIMEOUT_MS`: host-enforced limits.
- `SOFIA_RUNNER_QUOTA_HELPER`: absolute path to a root-owned executable host helper, not writable by group/others and not a symlink. The application invokes it without a shell using a bounded JSON-stdio protocol.
- `SOFIA_RUNNER_TEMP_ROOT`: absolute path to a dedicated XFS/ext4 project-quota filesystem mount; it is both the runner temp root and the parent for per-run workspaces.
- `SOFIA_RUNNER_MAX_WORKSPACE_BYTES`: hard per-run byte quota requested from the helper (default 536870912); the adapter also requests a hard inode limit of 20,000.
- `SOFIA_RUNNER_ALLOW_NETWORK=true` only when the VM firewall has been configured and verified to block loopback, private, link-local, metadata and internal destinations; then also set `SOFIA_RUNNER_PUBLIC_EGRESS_ENFORCED=true` as the operator attestation.

The standalone entrypoint wires `LinuxQuotaWorkspaceProvisioner` to the host helper. The helper protocol accepts one JSON object on stdin and returns one JSON object on stdout. For `create`, it receives `operation`, `runId`, `workspaceRoot`, `hardQuotaBytes`, and `hardQuotaInodes`; it must allocate a unique XFS/ext4 project-quota ID, assign it to a fresh direct-child directory, set hard block and inode limits, read the limits back from the filesystem quota interface, and only then return `{ "ok": true, "workspacePath": "...", "quotaBytes": <requested bytes> }`. For `dispose`, it receives `operation`, `runId`, and `workspacePath`; it must verify the run is stopped, remove the workspace, release the project ID, and return `{ "ok": true }`. Non-zero exit, malformed output, mismatched quota, wrong ownership/permissions, symlinked helper, timeout, or invalid workspace path fails closed. The helper must be a small audited host component with a fixed protocol; it must not accept arbitrary shell commands or model-supplied quota paths. The Node adapter never runs quota commands itself and does not claim quotas are active until the helper confirms them. The service defaults to networking disabled and refuses to start with network mode enabled unless the egress-firewall attestation is present. That flag is an operator assertion, not an automatic firewall detector. The service itself does not install host firewall rules. Place it behind HTTPS, restrict inbound access, keep the Docker daemon private to the dedicated host, monitor disk use, and patch the host/container runtime. Do not mount a general-purpose Docker socket into the Sofia Railway application.

The HTTP handler authenticates bearer tokens, bounds request and snapshot sizes, validates request IDs and paths, limits concurrent runs, obtains a fresh quota-backed workspace from the trusted host provisioner, and disposes it after each run. The adapter requires a root-owned, non-group/world-writable helper and validates that each returned workspace is a fresh direct child of the dedicated quota root. The helper itself is a required host artifact and is not bundled or installed by this repository. `GET /healthz` reports process liveness; configure the deployment health check to use `GET /readyz`, which verifies that the Docker daemon responds and the pinned runner image is already present. The container runner remains responsible for enforcing CPU, memory, process, timeout and output limits. **A host-enforced disk quota is also required**: the project workspace is a writable bind mount, so container memory/CPU/PID limits do not prevent a process from filling the runner host filesystem. Put the temporary workspace on a dedicated quota-limited filesystem or a size-limited tmpfs, and size it for the configured concurrency and snapshot limits. A post-run size check alone is not a sufficient disk-exhaustion defense. Run the service's test suite and a real host-level isolation/egress/disk-quota audit before configuring the Sofia Railway client. No runner service has been deployed by this change.
