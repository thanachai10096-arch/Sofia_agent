# Self-Hosted Distribution

Status: implementation plan based on the current `main` branch audit. This document does not claim that a Docker image or installer already exists.

## Goal

Let an independent operator clone or download Sofia Agent, configure their own provider credentials, start the API on their own infrastructure, retain data across restarts, and upgrade without losing state. The hosted Railway deployment remains a separate deployment target and must not be changed by self-hosting work.

## Repository audit (2026-11-18)

Verified on `main`:

- `package.json` exposes `build`, `typecheck`, `test`, and `start`; Node.js >=20 is required.
- `start` runs `node dist/api/entrypoint.js`.
- `src/api/entrypoint.ts` requires `SOFIA_API_KEY`, listens on `PORT` (default 3000) and binds to `0.0.0.0`.
- The entrypoint uses `SOFIA_RUN_STORE_DIR` for API run records, but uses workspace-relative `.sofia/api-usage.json` for API usage data.
- The README documents `SOFIA_STATE_DIR` for local job records, run snapshots and project memory, and explicitly says the file-backed runtime is for a single active process.
- `.env.example` documents provider configuration, sandbox policy, capability/audit secrets, and optional messaging integrations.
- No root `Dockerfile`, `compose.yaml`, `docker-compose.yml`, or `.env.example`-adjacent container deployment manifest was found on the default branch during this audit.

## Important gap: state directory contract

The documented `SOFIA_STATE_DIR` is not visibly wired into the API entrypoint's run-store and usage-store paths. Before publishing a supported container image, consolidate state path resolution behind one tested configuration helper and make all persistent stores use the configured state root. Keep backward compatibility with existing environment variables:

- `SOFIA_STATE_DIR` — canonical persistent root.
- `SOFIA_RUN_STORE_DIR` — explicit legacy/override path for API run records.
- Usage records, job records, snapshots, project memory, chat deduplication and browser profiles must each have explicit, documented persistence behavior.

Do not silently migrate or delete existing state. If a migration is required, provide a backup-first migration command and tests.

## Distribution architecture

### First supported deployment: single-host Docker Compose

Initial services should be limited to what the current runtime actually requires. Do not add PostgreSQL or Redis to Compose until the code has a real, tested adapter for them; an unused database container would create a false production-readiness claim.

Expected deliverables:

- Multi-stage `Dockerfile` using a supported Node 20+ runtime.
- `compose.yaml` with pinned image versions, persistent named volume(s), restart policy, health check, and no source-code bind mount in production.
- `.dockerignore` excluding secrets, local state, Git metadata, dependencies, build output and test artifacts.
- `.env.example` with safe placeholders only; never commit actual API keys.
- `scripts/sofia-install.sh` or an equivalent documented bootstrap that validates Docker/Compose, creates a private environment file, generates strong required secrets, and explains provider-key setup.
- `scripts/sofia-backup.sh` and `scripts/sofia-restore.sh` with explicit stop/consistency behavior and restore validation.
- Deployment guide covering install, first boot, logs, health, upgrades, rollback, backup, restore, firewall/TLS reverse proxy and troubleshooting.

### Configuration and security requirements

- Fail fast with actionable messages for missing required configuration.
- Generate a unique high-entropy `SOFIA_API_KEY`; never use a shared project-wide default.
- Generate separate high-entropy capability and audit secrets where those features require them.
- Keep provider credentials server-side and out of browser/mobile bundles and logs.
- Use Docker secrets or operator-managed secret files where practical; do not bake secrets into images.
- Run as a non-root user, use a minimal runtime image, and avoid mounting the Docker socket.
- Expose only the API port; do not publish database/cache ports unless explicitly required.
- Browser and shell capabilities remain opt-in and follow Sofia's existing policy controls.
- A public internet deployment must use TLS at a reverse proxy/load balancer and a restrictive `SOFIA_ALLOWED_ORIGINS` policy.

### Persistence and scaling boundary

The current README explicitly describes file-backed runtime state as single-active-process. The first self-hosted release must therefore document and enforce a single API process/replica per state directory. Do not claim horizontal scaling or multi-host worker support until transactional shared persistence, distributed leases/locking, idempotency and recovery have been implemented and tested.

## Release gates

A self-hosted release is not ready until all of the following pass:

1. Clean install on a fresh supported Linux host with Docker Engine and Compose.
2. `docker compose config --quiet` succeeds with the documented example configuration.
3. Image builds reproducibly from the repository.
4. Container starts with only documented required configuration.
5. Health endpoint reports healthy only when the API is ready.
6. A test run completes through the API using a test provider/mock.
7. API key authentication rejects missing and incorrect credentials.
8. Restart preserves run records, job state, memory and usage data that are promised as persistent.
9. Backup and restore reproduce the expected state on a clean volume.
10. Upgrade and rollback procedures are tested against a prior release.
11. Container runs non-root and does not expose secrets in logs or image layers.
12. Existing CI, typecheck, tests and build pass; Railway Staging/Production are not modified as part of this branch.

## Implementation sequence

- P0: unify and test persistent state-root configuration.
- P1: add Dockerfile, production Compose, ignore rules and container health endpoint.
- P2: add secure installer and environment validation.
- P3: add backup/restore and upgrade/rollback tooling.
- P4: run clean-host acceptance tests and publish versioned installation documentation.
- P5: only then evaluate shared PostgreSQL/Redis adapters and multi-replica support.

## References

- Docker Compose production guidance: https://docs.docker.com/compose/how-tos/production/
- Docker Compose secrets: https://docs.docker.com/compose/how-tos/use-secrets/
- Docker Compose volumes: https://docs.docker.com/reference/compose-file/volumes/
