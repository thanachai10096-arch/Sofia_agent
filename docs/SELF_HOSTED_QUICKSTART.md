# Sofia Agent — Self-Hosted Quickstart

This is the initial **single-host Docker Compose** deployment path. Each installation runs one Sofia API process with its own private environment file and persistent Docker volume. Multiple independent installations can share one Docker host; this is not a horizontally scaled or multi-host shared-queue deployment.

## Requirements

- Linux server or local machine with Docker Engine and the Docker Compose plugin.
- A configured model provider and its own provider API credential.
- A private server-side Sofia API key.

## Install

Clone the repository and enter its directory:

```bash
git clone https://github.com/thanachai10096-arch/Sofia_agent.git
cd Sofia_agent
```

Run the bootstrap installer:

```bash
bash scripts/sofia-install.sh
```

The installer creates a private `.env`, generates a unique `SOFIA_API_KEY`, and checks for Docker Engine and the Compose plugin. It does not overwrite an existing `.env`.

Edit `.env` and set at least:

- `SOFIA_MODEL_PROVIDER`: the provider configured for this installation, where required.
- The matching provider credential, such as `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, or `ANTHROPIC_API_KEY`.
- A model name if the selected provider requires one.

The generated `SOFIA_API_KEY` is the credential clients use to authenticate to this Sofia installation. Keep it private.

### Per-key tool capabilities

API key scopes are the trusted administrator's permission grants. In addition to the API scopes such as `agent:run` and `agent:read`, elevated tools require explicit per-key grants:

- `tool:write` — write or patch files
- `tool:shell` — run shell/terminal commands
- `tool:network` — network-enabled tools
- `tool:browser` — browser interaction
- `tool:destructive` — destructive desktop actions

These grants are always intersected with the installation-wide `SOFIA_ALLOW_FILE_WRITE`, `SOFIA_ALLOW_SHELL`, `SOFIA_ALLOW_NETWORK`, `SOFIA_ALLOW_BROWSER`, and `SOFIA_ALLOW_DESTRUCTIVE` settings. A key cannot enable a capability the host has disabled. Jobs persist their granted scopes so retries and resumes keep the same permissions. Grant elevated scopes only to trusted keys; do not place privileged API keys in browser or mobile clients. A key with `security:admin` can inspect the current scope catalogue and the configured API-key permission assignments through `GET /v1/security/permissions`; the response contains only a one-way hashed key ID, never a bearer token, and reports effective tool permissions after applying the installation-wide policy gates. This endpoint is read-only: adding, rotating, or revoking keys and changing their grants remains an operator-controlled deployment configuration task.

Do not commit `.env`, share it with users, or place provider credentials in a browser/mobile application.

Build and start:

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs -f sofia
```

The API is published on `127.0.0.1:3000` by default. Keep it behind an HTTPS reverse proxy for remote access. Do not expose the raw API port to the public internet. To change the local bind address or host port, set `SOFIA_BIND_ADDRESS` and `SOFIA_HOST_PORT` in the shell environment used for Compose. To run multiple installations from the same checkout, give each one a private env file and unique volume/project/port values. Set `COMPOSE_PROJECT_NAME` to a unique Compose project name, `SOFIA_ENV_FILE` to that env file's absolute path, and `SOFIA_DOCKER_VOLUME` to its unique volume name for every Compose, backup, restore, upgrade, and rollback command. Keep all three values consistent for the lifetime of that installation. Example for one terminal session: `export COMPOSE_PROJECT_NAME=sofia-a SOFIA_ENV_FILE=/srv/sofia-a/.env SOFIA_DOCKER_VOLUME=sofia-a-data SOFIA_HOST_PORT=3001` followed by `docker compose up -d`. Use different project names, env files, volumes, and host ports for other installations.

Check readiness:

```bash
curl --fail http://127.0.0.1:3000/health
```

The health endpoint is a process/API liveness check; it does not prove that a model provider is reachable or that an agent task will succeed.

## Data persistence

Compose mounts a named volume at `/data` and configures. The default volume is `sofia-agent-data`. When hosting multiple Sofia installations on the same Docker host, export a unique `SOFIA_DOCKER_VOLUME` value in the shell before running any Compose, backup, restore, upgrade, or rollback command; use the same value consistently so each installation keeps its own data volume:

- `SOFIA_WORKSPACE=/data/workspace`
- `SOFIA_STATE_DIR=/data/state`

All durable file-backed stores resolve beneath this root, including API run records and usage quotas, background jobs, Brain run snapshots, checkpoints, project and user memory, SQLite sessions, skill/evolution data, security audit data, and chat deduplication.

For authenticated API requests, Sofia creates a separate workspace directory per API-key identity under `/data/state/sofia-agents-user-workspaces/<sha256-principal-id>/`. The directory name is a one-way hash, not the API key. Each agent run's file tools, project discovery, repository indexing, desktop runtime, project memory, and checkpoints are scoped to that user's workspace. Background jobs retain the authenticated API-key identity when Sofia creates or resumes the Brain, so they use the same private workspace instead of falling back to the local-instance workspace. These workspaces start empty: Sofia does not automatically copy `/data/workspace` into each user's private directory. A trusted project-import/provisioning flow is required before users can work on their own project files. `SOFIA_USER_WORKSPACES_DIR` can override the workspace root but must be an absolute persistent path. Local non-API runs use a stable `local-instance` workspace namespace. `SOFIA_RUN_STORE_DIR` and `SOFIA_CHAT_DEDUPE_DIR` remain optional explicit path overrides; leave them unset for the unified default. Do not remove the volume when upgrading. The volume contains user data and should be backed up and protected as sensitive information.

## Upgrade and lifecycle management

Pull the intended source revision, then run the managed upgrade:

```bash
git pull --ff-only
bash scripts/sofia-upgrade.sh
```

The upgrade script creates a consistent volume backup, preserves the current local image, rebuilds and recreates the service, then waits for the container health check. It records a private manifest in `backups/`. If the new container fails health checks, it attempts to restore the previous image without changing the data volume.

Inspect the current deployment and recent upgrade history:

```bash
bash scripts/sofia-lifecycle.sh status
bash scripts/sofia-lifecycle.sh history
```

Manually roll back a previously recorded upgrade:

```bash
bash scripts/sofia-rollback.sh backups/upgrade-<timestamp>.json --yes
```

Rollback restores the container image only. It does not reverse database/schema changes or restore older application data. Keep the pre-upgrade volume archive and rollback image until the release has been accepted. This initial release does not support automatic schema downgrade.

## Migrate legacy state

Run the migration from an environment that can still read the old workspace and legacy state directories. First inspect the inventory without changing files:

```bash
SOFIA_WORKSPACE=/absolute/path/to/old-workspace \
SOFIA_STATE_DIR=/absolute/path/to/new-state \
node scripts/sofia-migrate-state.mjs
```

Back up both the old sources and destination, review the source/target inventory, then explicitly apply:

```bash
SOFIA_WORKSPACE=/absolute/path/to/old-workspace \
SOFIA_STATE_DIR=/absolute/path/to/new-state \
node scripts/sofia-migrate-state.mjs --apply
```

The tool copies known legacy stores from the workspace `.sofia` directory, OS temporary directory, platform user-data directory, and (when supplied) a previous configured state root. To migrate from an older custom state root, set `SOFIA_LEGACY_STATE_DIR=/absolute/path/to/old-state` while keeping `SOFIA_STATE_DIR` pointed at the new destination. It verifies copied content with SHA-256, treats identical files as already migrated, refuses symlinks and conflicting destination files, and never deletes source data. It does not automatically discover arbitrary custom paths; migrate those manually and keep the old data until the new installation has been verified. Browser profile data configured through `SOFIA_BROWSER_PROFILE_DIR` remains outside the canonical state root by design and must be backed up/migrated separately if you need to preserve authenticated browser profiles.

For a legacy Docker container, perform and verify migration while the old container and its writable filesystem still exist. Temporary files inside a removed container cannot be recovered by this tool.

## Clean-host acceptance test

After configuring `.env`, run the isolated Docker acceptance test:

```bash
bash scripts/sofia-self-hosted-smoke.sh
```

It builds a fresh image, starts an isolated Compose project with a disposable volume, waits for health, verifies that requests without a key and with an invalid key receive HTTP 401, verifies that the configured API key can read `/v1/jobs`, restarts the service, and checks that data survives. It removes only its own test project and volume. This does not replace a real model-provider task test or a production backup/restore rehearsal. Run `bash scripts/sofia-isolation-smoke.sh` to build one image, start two installations with distinct env files and volumes, verify that each API key is rejected by the other installation, and verify the volumes remain separate. The API test suite also verifies that separate API-key identities cannot read or clear each other's user memories, and that session IDs are namespaced by authenticated key identity. Job reads and mutations are owner-key checked at the API boundary. Saved browser profiles are stored under a hash of the API-key identity, profile IDs are validated and ownership-checked on every access, and authenticated browser sessions are keyed by both owner and profile. Concurrent runs acquiring the same saved profile share one in-flight browser launch; one user's key cannot attach to another user's saved profile. Browser automation remains disabled by default and requires explicit host configuration.

## Backup and restore

Create a consistent offline volume backup:

```bash
bash scripts/sofia-backup.sh
```

Restore only after taking a separate copy of the current volume:

```bash
bash scripts/sofia-restore.sh backups/sofia-YYYYMMDDTHHMMSSZ.tar.gz --yes
docker compose up -d
```

See [Backup and Restore](SELF_HOSTED_BACKUP_RESTORE.md) for checksum handling and operational limits. Treat archives as sensitive data.

## Security and current limitations

- The container runs as the non-root `node` user, drops Linux capabilities, uses a read-only root filesystem, and writes persistent data only under `/data`.
- The default host bind is loopback-only. Use a TLS reverse proxy for remote access.
- Keep `SOFIA_ALLOW_SHELL=false` and browser automation disabled unless you have deliberately reviewed and configured their security boundaries.
- Use one active API process per volume. The file-backed job/state stores are not a supported multi-host shared queue.
- Do not mount the Docker socket into the Sofia container.
- This quickstart has not yet been certified by a clean-host end-to-end test. Run the repository CI, image build, Compose config validation, health check, authenticated API smoke test, restart-persistence test, and backup/restore test before treating a deployment as production-ready.
