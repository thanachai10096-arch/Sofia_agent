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


mark_manifest_status() {
  local status="$1"
  local reason="${2:-}"
  if [ -f "$MANIFEST" ]; then
    node --input-type=module - "$MANIFEST" "$status" "$reason" <<'NODE'
import { readFile, writeFile } from "node:fs/promises";
const [file, status, reason] = process.argv.slice(2);
const data = JSON.parse(await readFile(file, "utf8"));
data.status = status;
if (reason) data.rollbackReason = reason;
data.updatedAt = new Date().toISOString();
await writeFile(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
NODE
  fi
}

restore_previous_image() {
  if [ -z "$PREVIOUS_IMAGE_ID" ]; then
    echo "No previous image is available for rollback." >&2
    return 1
  fi
  docker image tag "$ROLLBACK_TAG" "$IMAGE"
  docker compose up -d --no-deps --force-recreate "$SERVICE"
  local rollback_container
  rollback_container="$(docker compose ps -q "$SERVICE")"
  [ -n "$rollback_container" ] || { mark_manifest_status "rollback-failed" "rollback container was not created"; return 1; }
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local running health
    running="$(docker inspect --format '{{.State.Running}}' "$rollback_container" 2>/dev/null || echo false)"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$rollback_container" 2>/dev/null || echo missing)"
    [ "$running" = "true" ] && [ "$health" = "healthy" ] && {
      mark_manifest_status "rolled-back" "new image did not pass health check"
      echo "Previous image is healthy again."
      return 0
    }
    if [ "$running" != "true" ] || [ "$health" = "unhealthy" ] || [ "$health" = "missing" ]; then
      mark_manifest_status "rollback-failed" "rollback container exited or reported unhealthy"
      return 1
    fi
    sleep 3
  done
  mark_manifest_status "rollback-failed" "previous image did not become healthy"
  echo "Previous image was restored but did not become healthy within the timeout." >&2
  return 1
}

if ! docker compose build "$SERVICE"; then
  echo "Build failed. The running container was not intentionally replaced." >&2
  exit 1
fi

if ! docker compose up -d --no-deps --force-recreate "$SERVICE"; then
  echo "Container recreation failed." >&2
  if [ -n "$PREVIOUS_IMAGE_ID" ]; then
    restore_previous_image || echo "Automatic rollback did not become healthy; inspect Docker logs." >&2
  fi
  exit 1
fi

CONTAINER_ID="$(docker compose ps -q "$SERVICE")"
if [ -z "$CONTAINER_ID" ]; then
  echo "Could not identify the upgraded container." >&2
  [ -z "$PREVIOUS_IMAGE_ID" ] || restore_previous_image
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
    restore_previous_image || echo "Automatic rollback did not become healthy; inspect Docker logs." >&2
    echo "Data volume was left untouched."
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
