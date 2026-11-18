# Sofia Agent — Self-Hosted Quickstart

This is the initial **single-host Docker Compose** deployment path. It is intended for one Sofia API process using one persistent Docker volume. It is not a horizontally scaled or multi-host deployment.

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

Do not commit `.env`, share it with users, or place provider credentials in a browser/mobile application.

Build and start:

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs -f sofia
```

The API is published on `127.0.0.1:3000` by default. Keep it behind an HTTPS reverse proxy for remote access. Do not expose the raw API port to the public internet. To change the local bind address or host port, set `SOFIA_BIND_ADDRESS` and `SOFIA_HOST_PORT` in the shell environment used for Compose.

Check readiness:

```bash
curl --fail http://127.0.0.1:3000/health
```

The health endpoint is a process/API liveness check; it does not prove that a model provider is reachable or that an agent task will succeed.

## Data persistence

Compose mounts a named volume at `/data` and configures. The default volume is `sofia-agent-data`. When hosting multiple Sofia installations on the same Docker host, export a unique `SOFIA_DOCKER_VOLUME` value in the shell before running any Compose, backup, restore, upgrade, or rollback command; use the same value consistently so each installation keeps its own data volume:

- `SOFIA_WORKSPACE=/data/workspace`
- `SOFIA_STATE_DIR=/data/state`

All durable file-backed stores resolve beneath this root, including API run records and usage quotas, background jobs, Brain run snapshots, checkpoints, project and user memory, SQLite sessions, skill/evolution data, security audit data, and chat deduplication. The workspace itself remains at `/data/workspace`; project files and workspace-local artifacts are persisted on the same named volume. `SOFIA_RUN_STORE_DIR` and `SOFIA_CHAT_DEDUPE_DIR` remain optional explicit path overrides; leave them unset for the unified default. Do not remove the volume when upgrading. The volume contains user data and should be backed up and protected as sensitive information.

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

It builds a fresh image, starts an isolated Compose project with a disposable volume, waits for health, verifies that requests without a key and with an invalid key receive HTTP 401, verifies that the configured API key can read `/v1/jobs`, restarts the service, and checks that data survives. It removes only its own test project and volume. This does not replace a real model-provider task test or a production backup/restore rehearsal.

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
