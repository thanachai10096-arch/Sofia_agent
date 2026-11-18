#!/usr/bin/env bash
set -Eeuo pipefail

# Restore a Sofia data-volume archive. This replaces ALL current volume data.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ARCHIVE="${1:-}"
CONFIRM="${2:-}"
VOLUME_NAME="${SOFIA_DOCKER_VOLUME:-sofia-agent-data}"
SERVICE="${SOFIA_COMPOSE_SERVICE:-sofia}"

if [ -z "$ARCHIVE" ] || [ "$CONFIRM" != "--yes" ]; then
  echo "Usage: $0 <backup.tar.gz> --yes" >&2
  echo "WARNING: this replaces all data in volume '$VOLUME_NAME'." >&2
  exit 2
fi
[ -f "$ARCHIVE" ] || { echo "Backup archive not found: $ARCHIVE" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }

# Require an integrity checksum before any destructive action.
[ -s "$ARCHIVE.sha256" ] || { echo "Required checksum file is missing: $ARCHIVE.sha256" >&2; exit 1; }
(cd "$(dirname "$ARCHIVE")" && sha256sum --check "$(basename "$ARCHIVE").sha256")

# Validate archive paths before stopping the service or touching the volume.
if tar -tzf "$ARCHIVE" | awk '
  /^\// { bad=1 }
  {
    n=split($0, parts, "/")
    for (i=1; i<=n; i++) if (parts[i]=="..") bad=1
  }
  END { exit bad ? 0 : 1 }
'; then
  echo "Unsafe archive path detected; refusing to restore." >&2
  exit 1
fi

# The archive is now checksum-verified and path-checked; only now begin the destructive restore.
docker volume create "$VOLUME_NAME" >/dev/null
docker compose stop -t 30 "$SERVICE" >/dev/null

docker run --rm \
  -v "$VOLUME_NAME:/data" \
  -v "$(cd "$(dirname "$ARCHIVE")" && pwd):/backup:ro" \
  alpine:3.20 \
  sh -ec "find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf '/backup/$(basename "$ARCHIVE")' -C /data"

echo "Restore completed. Start Sofia with: docker compose up -d"
