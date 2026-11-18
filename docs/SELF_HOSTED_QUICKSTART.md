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

Compose mounts the named volume `sofia-agent-data` at `/data` and configures:

- `SOFIA_WORKSPACE=/data/workspace`
- `SOFIA_STATE_DIR=/data/state`
- `SOFIA_RUN_STORE_DIR=/data/state/api-runs`

The API usage file is stored under the workspace's `.sofia` directory by the current entrypoint. Do not remove the volume when upgrading. The volume contains user data and should be backed up and protected as sensitive information.

## Upgrade

Pull the intended source revision, then rebuild and recreate:

```bash
git pull --ff-only
docker compose config --quiet
docker compose up -d --build
```

Review release notes and back up the volume before upgrading. This initial release does not include an automated schema migration or rollback manager.

## Backup and restore

A simple offline backup can be made by stopping the service and archiving the named volume:

```bash
docker compose stop
docker run --rm -v sofia-agent-data:/data:ro -v "$PWD:/backup" node:22-bookworm-slim \
  tar -czf /backup/sofia-agent-data-$(date +%F-%H%M%S).tar.gz -C /data .
docker compose start
```

Treat the archive as sensitive. Restore only into a verified backup of the destination volume and follow the Docker volume restore procedure appropriate to your host. Automated restore tooling and tested disaster-recovery procedures are not included yet.

## Security and current limitations

- The container runs as the non-root `node` user, drops Linux capabilities, uses a read-only root filesystem, and writes persistent data only under `/data`.
- The default host bind is loopback-only. Use a TLS reverse proxy for remote access.
- Keep `SOFIA_ALLOW_SHELL=false` and browser automation disabled unless you have deliberately reviewed and configured their security boundaries.
- Use one active API process per volume. The file-backed job/state stores are not a supported multi-host shared queue.
- Do not mount the Docker socket into the Sofia container.
- This quickstart has not yet been certified by a clean-host end-to-end test. Run the repository CI, image build, Compose config validation, health check, authenticated API smoke test, restart-persistence test, and backup/restore test before treating a deployment as production-ready.
