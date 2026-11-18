#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SERVICE="${SOFIA_COMPOSE_SERVICE:-sofia}"
IMAGE="${SOFIA_IMAGE:-sofia-agent:local}"
BACKUP_DIR="${SOFIA_BACKUP_DIR:-$ROOT_DIR/backups}"
HEALTH_TIMEOUT="${SOFIA_HEALTH_TIMEOUT_SECONDS:-120}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MANIFEST="$BACKUP_DIR/upgrade-$STAMP.json"
ROLLBACK_TAG="sofia-agent:rollback-$STAMP"
PREVIOUS_IMAGE_ID=""
UPGRADE_STARTED=0

if ! [[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] || [ "$HEALTH_TIMEOUT" -lt 10 ]; then
  echo "SOFIA_HEALTH_TIMEOUT_SECONDS must be an integer >= 10." >&2
  exit 2
fi

command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }
docker compose config --quiet
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  PREVIOUS_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE")"
  docker image tag "$PREVIOUS_IMAGE_ID" "$ROLLBACK_TAG"
fi

# A verified volume archive is required before changing the running image.
bash scripts/sofia-backup.sh

if [ -n "$PREVIOUS_IMAGE_ID" ]; then
  node --input-type=module - "$MANIFEST" "$STAMP" "$SERVICE" "$IMAGE" "$PREVIOUS_IMAGE_ID" "$ROLLBACK_TAG" <<'NODE'
import { writeFile } from "node:fs/promises";
const [file, createdAt, service, image, previousImageId, rollbackTag] = process.argv.slice(2);
await writeFile(file, JSON.stringify({
  schemaVersion: 1,
  createdAt,
  service,
  image,
  previousImageId,
  rollbackTag,
  status: "prepared",
  note: "Rollback restores the previous image only; it does not restore or mutate the data volume."
}, null, 2) + "\n", { mode: 0o600, flag: "wx" });
NODE
else
  echo "No existing image '$IMAGE' found. This is a first install; no automatic image rollback is possible." >&2
fi

UPGRADE_STARTED=1
if ! docker compose build "$SERVICE"; then
  echo "Build failed. The running container was not intentionally replaced." >&2
  exit 1
fi

if ! docker compose up -d --no-deps --force-recreate "$SERVICE"; then
  echo "Container recreation failed." >&2
  if [ -n "$PREVIOUS_IMAGE_ID" ]; then
    docker image tag "$ROLLBACK_TAG" "$IMAGE"
    docker compose up -d --no-deps --force-recreate "$SERVICE" || true
  fi
  exit 1
fi

CONTAINER_ID="$(docker compose ps -q "$SERVICE")"
if [ -z "$CONTAINER_ID" ]; then
  echo "Could not identify the upgraded container." >&2
  exit 1
fi

DEADLINE=$((SECONDS + HEALTH_TIMEOUT))
HEALTH=""
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  RUNNING="$(docker inspect --format '{{.State.Running}}' "$CONTAINER_ID" 2>/dev/null || echo false)"
  HEALTH="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$CONTAINER_ID" 2>/dev/null || echo missing)"
  if [ "$RUNNING" != "true" ] || [ "$HEALTH" = "unhealthy" ] || [ "$HEALTH" = "missing" ]; then
    break
  fi
  if [ "$HEALTH" = "healthy" ]; then
    break
  fi
  sleep 3
done

if [ "$HEALTH" != "healthy" ]; then
  echo "Upgrade did not become healthy (status: $HEALTH). Initiating image rollback." >&2
  if [ -n "$PREVIOUS_IMAGE_ID" ]; then
    docker image tag "$ROLLBACK_TAG" "$IMAGE"
    docker compose up -d --no-deps --force-recreate "$SERVICE"
    echo "Previous image restored. Data volume was left untouched."
  else
    echo "No previous image was available; inspect logs and restore manually if needed." >&2
  fi
  exit 1
fi

if [ -f "$MANIFEST" ]; then
  node --input-type=module - "$MANIFEST" <<'NODE'
import { readFile, writeFile } from "node:fs/promises";
const file = process.argv[2];
const data = JSON.parse(await readFile(file, "utf8"));
data.status = "healthy";
data.verifiedAt = new Date().toISOString();
await writeFile(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
NODE
  echo "Upgrade manifest: $MANIFEST"
fi

echo "Sofia upgrade completed and container is healthy."
echo "Rollback command: bash scripts/sofia-rollback.sh '$MANIFEST' --yes"
