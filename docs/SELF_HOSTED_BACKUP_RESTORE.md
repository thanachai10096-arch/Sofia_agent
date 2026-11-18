# Backup and Restore

These scripts operate on the Docker named volume `sofia-agent-data` (override with
`SOFIA_DOCKER_VOLUME`). Backups contain all files in the volume, including workspace
and runtime state. Treat archives as sensitive data.

## Create a backup

```bash
bash scripts/sofia-backup.sh
```

The script stops the `sofia` Compose service before archiving for a consistent
file-level snapshot, then restarts it if it was running. It writes a UTC-stamped
`.tar.gz` archive and a SHA-256 checksum under `backups/` (override the directory
with `SOFIA_BACKUP_DIR`). Keep backups outside the host and encrypt them when they
contain sensitive project data.

## Restore a backup

```bash
bash scripts/sofia-restore.sh backups/sofia-YYYYMMDDTHHMMSSZ.tar.gz --yes
docker compose up -d
```

Restore replaces the complete named volume. The explicit `--yes` is required.
If a matching checksum file exists it is verified before restore. Stop other
processes using the volume first. Keep a separate copy of the current volume
before restoring if rollback may be needed.

## Operational limits

- This is a single-host, single-active-process backup procedure; it is not a
  live distributed snapshot.
- The archive includes secrets/state stored in the volume; restrict filesystem
  access and off-host storage permissions.
- Test restore on a disposable host before relying on a backup for production.
- These scripts have not yet passed clean-host acceptance testing; the self-hosted
  pull request remains a draft until CI and restore drills pass.


## Upgrade and image rollback

Run an upgrade from the repository root:

```bash
bash scripts/sofia-upgrade.sh
```

The command validates Compose configuration, preserves the current image under a timestamped local rollback tag, creates a consistent pre-upgrade volume backup, rebuilds and recreates the service, and waits for Docker health status. It writes a private manifest in `backups/` when a previous image exists. If the new container fails its health check, it attempts to restore the previous image automatically.

To manually restore the image recorded in a manifest:

```bash
bash scripts/sofia-rollback.sh backups/upgrade-<timestamp>.json --yes
```

Rollback verifies that the local rollback image ID matches the manifest before changing the service. It restores the image only; it never restores or modifies the data volume. Keep the pre-upgrade volume archive separately. This is not a database schema downgrade mechanism, and incompatible irreversible migrations remain unsupported. Retain the rollback image tag and manifest for the entire rollback window. A first install has no prior image to roll back to.
