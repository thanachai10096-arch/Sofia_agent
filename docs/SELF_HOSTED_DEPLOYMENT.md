# Self-Hosted Distribution

Status: active implementation on `feat/self-hosted-distribution`. The Docker/Compose, installer, backup/restore, and unified state-root work exists on this feature branch but remains unmerged and unverified on a clean host. Do not treat it as a production release.

## Goal

Let an independent operator clone or download Sofia Agent, configure their own provider credentials, start the API on their own infrastructure, retain data across restarts, and upgrade without losing state. The hosted Railway deployment remains a separate deployment target and must not be changed by self-hosting work.

## Repository audit (2026-11-18)

Verified on `main`:

- `package.json` exposes `build`, `typecheck`, `test`, and `start`; Node.js >=20 is required.
- `start` runs `node dist/api/entrypoint.js`.
- `src/api/entrypoint.ts` requires `SOFIA_API_KEY`, listens on `PORT` (default 3000) and binds to `0.0.0.0`.
- At the time of the `main`-branch audit, the API entrypoint used `SOFIA_RUN_STORE_DIR` for API run records and workspace-relative `.sofia/api-usage.json` for API usage data. The feature branch changes both defaults to the canonical state root.
- The README documents `SOFIA_STATE_DIR` for local job records, run snapshots and project memory, and explicitly says the file-backed runtime is for a single active process.
- `.env.example` documents provider configuration, sandbox policy, capability/audit secrets, and optional messaging integrations.
- The default branch had no root container deployment manifest at audit time. This feature branch adds the initial `Dockerfile`, `compose.yaml`, `.dockerignore`, installer, backup/restore scripts, and deployment guides; these additions have not yet passed clean-host acceptance testing.

## State directory contract

The feature branch now routes the durable file-backed runtime stores through the shared `sofiaStateDirectory()` resolver. With `SOFIA_STATE_DIR=/data/state`, the default layout is:

| Store | Directory / file |
| --- | --- |
| API run records | `sofia-agents-api-runs/` |
| API usage quotas | `sofia-agents-api/usage.json` |
| Background jobs | `sofia-agents-jobs/` |
| Brain run snapshots | `sofia-agents-runs/` |
| Checkpoints | `sofia-agents-checkpoints/` |
| Project memory | `sofia-agents-memory/` |
| User memory | `sofia-agents-user-memory/` |
| SQLite transcripts | `sofia-agents-sessions/sessions.sqlite` |
| Skill lifecycle | `sofia-agents-skills/skill-lifecycle.json` |
| Evolution diagnostics | `sofia-agents-evolution/evolution.json` |
| Security audit | `sofia-agents-security/security-audit.log` |
| Chat deduplication | `sofia-agents-chat-dedupe/` |

`SOFIA_RUN_STORE_DIR` and `SOFIA_CHAT_DEDUPE_DIR` remain explicit optional overrides for compatibility. Browser profile storage remains separately configured by `SOFIA_BROWSER_PROFILE_DIR`, because it may intentionally point to an operator-managed browser profile volume. Workspace files and workspace-local artifacts remain under `SOFIA_WORKSPACE`; in Compose that directory is also on the persistent `/data` volume.

This change does not automatically migrate files from previous workspace-relative or OS-temp locations. Existing operators must back up their current data and perform a deliberate migration before switching roots. Never delete the old paths automatically. Add migration tooling only with a verified source/destination inventory and backup-first tests.

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
12. Upgrade creates a verified pre-upgrade backup, preserves the previous image, and passes a health-check rollback drill without mutating user state.
13. Existing CI, typecheck, tests and build pass; Railway Staging/Production are not modified as part of this branch.

## Implementation sequence

- P0: unify persistent state-root configuration (implemented on this branch; automated and clean-host verification still pending).
- P1: add Dockerfile, production Compose, ignore rules and container health endpoint.
- P2: add secure installer and environment validation.
- P3: add backup/restore and upgrade/rollback tooling (scripts implemented on this branch; end-to-end validation pending).
- P4: run clean-host acceptance tests and publish versioned installation documentation.
- P5: only then evaluate shared PostgreSQL/Redis adapters and multi-replica support.

## Upgrade and rollback\n\nUse `bash scripts/sofia-upgrade.sh` to create a volume backup, preserve the current image under a timestamped rollback tag, build/recreate the service, and wait for the container health check. A successful run writes a private JSON manifest under `backups/`. If the upgraded service does not become healthy, the script attempts to restore the previous image automatically.\n\nFor a deliberate manual image rollback, run `bash scripts/sofia-rollback.sh backups/upgrade-<timestamp>.json --yes`. The rollback command verifies the manifest and local rollback image ID before recreating the service. Both automatic and manual rollback restore the container image only; they do not restore, rewrite, or delete the data volume. Database/schema migrations that are not backward-compatible require a separately designed recovery procedure and are not supported by this initial release. Keep upgrade manifests and their matching Docker image tags until the rollback window has passed.\n\n## References

- Docker Compose production guidance: https://docs.docker.com/compose/how-tos/production/
- Docker Compose secrets: https://docs.docker.com/compose/how-tos/use-secrets/
- Docker Compose volumes: https://docs.docker.com/reference/compose-file/volumes/
