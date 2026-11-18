#!/usr/bin/env bash
set -Eeuo pipefail

# Restore a Sofia data-volume archive. This replaces ALL current volume data.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ARCHIVE="${1:-}"
CONFIRM="${2:-}"
VOLUME_NAME="${SOFIA_DOCKER_VOLUME:-sofia-agent-data}"

if [ -z "$ARCHIVE" ] || [ "$CONFIRM" != "--yes" ]; then
  echo "Usage: $0 <backup.tar.gz> --yes" >&2
  echo "WARNING: this replaces all data in volume '$VOLUME_NAME'." >&2
  exit 2
fi
[ -f "$ARCHIVE" ] || { echo "Backup archive not found: $ARCHIVE" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }

if [ -f "$ARCHIVE.sha256" ]; then
  (cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256")
else
  echo "Warning: no checksum file found; continuing with explicit --yes." >&2
fi

docker volume create "$VOLUME_NAME" >/dev/null
docker compose stop -t 30 sofia >/dev/null

# Validate archive paths before extracting to prevent absolute/path-traversal entries.
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

docker run --rm \
  -v "$VOLUME_NAME:/data" \
  -v "$(cd "$(dirname "$ARCHIVE")" && pwd):/backup:ro" \
  alpine:3.20 \
  sh -ec "find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf '/backup/$(basename "$ARCHIVE")' -C /data"

echo "Restore completed. Start Sofia with: docker compose up -d"
