#!/usr/bin/env bash
set -Eeuo pipefail

# Create a consistent archive of the named Sofia data volume.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VOLUME_NAME="${SOFIA_DOCKER_VOLUME:-sofia-agent-data}"
BACKUP_DIR="${SOFIA_BACKUP_DIR:-$ROOT_DIR/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$BACKUP_DIR/sofia-${STAMP}.tar.gz"
WAS_RUNNING=0

command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }
docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1 || {
  echo "Docker volume '$VOLUME_NAME' does not exist. Start Sofia once before backing up." >&2
  exit 1
}

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
if docker compose ps --status running --services 2>/dev/null | grep -qx sofia; then
  WAS_RUNNING=1
fi

restart_service() {
  if [ "$WAS_RUNNING" -eq 1 ]; then
    docker compose start sofia >/dev/null
  fi
}
trap restart_service EXIT

# Stop writes before archiving to avoid a partially-written state snapshot.
docker compose stop -t 30 sofia >/dev/null 2>&1 || true
docker run --rm \
  -v "$VOLUME_NAME:/data:ro" \
  -v "$BACKUP_DIR:/backup" \
  alpine:3.20 \
  sh -ec "tar -czf '/backup/$(basename "$ARCHIVE")' -C /data ."

test -s "$ARCHIVE"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
echo "Backup created: $ARCHIVE"
echo "Checksum: $ARCHIVE.sha256"
