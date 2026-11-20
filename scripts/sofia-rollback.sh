#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MANIFEST="${1:-}"
CONFIRM="${2:-}"
SERVICE="${SOFIA_COMPOSE_SERVICE:-sofia}"

if [ -z "$MANIFEST" ] || [ "$CONFIRM" != "--yes" ]; then
  echo "Usage: $0 <upgrade-manifest.json> --yes" >&2
  echo "This restores the previous container image only; it does not roll back application data." >&2
  exit 2
fi
[ -f "$MANIFEST" ] || { echo "Upgrade manifest not found: $MANIFEST" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }

node --input-type=module - "$MANIFEST" "$SERVICE" <<'NODE'
import { readFile } from "node:fs/promises";
const [file, expectedService] = process.argv.slice(2);
const data = JSON.parse(await readFile(file, "utf8"));
if (data.schemaVersion !== 1) throw new Error("Unsupported upgrade manifest schema.");
if (data.service !== expectedService) throw new Error("Manifest service does not match SOFIA_COMPOSE_SERVICE.");
if (typeof data.image !== "string" || typeof data.rollbackTag !== "string" || typeof data.previousImageId !== "string") {
  throw new Error("Manifest is missing required image rollback fields.");
}
if (!/^sha256:[a-f0-9]{64}$/.test(data.previousImageId)) throw new Error("Invalid previous image ID.");
if (!/^sofia-agent:rollback-[A-Za-z0-9TZ-]+$/.test(data.rollbackTag)) throw new Error("Invalid rollback image tag.");
console.log(JSON.stringify({ image: data.image, rollbackTag: data.rollbackTag, previousImageId: data.previousImageId }));
NODE

ROLLBACK_TAG="$(node --input-type=module - "$MANIFEST" <<'NODE'
import { readFile } from "node:fs/promises";
const data = JSON.parse(await readFile(process.argv[2], "utf8"));
process.stdout.write(data.rollbackTag);
NODE
)"
IMAGE="$(node --input-type=module - "$MANIFEST" <<'NODE'
import { readFile } from "node:fs/promises";
const data = JSON.parse(await readFile(process.argv[2], "utf8"));
process.stdout.write(data.image);
NODE
)"
EXPECTED_ID="$(node --input-type=module - "$MANIFEST" <<'NODE'
import { readFile } from "node:fs/promises";
const data = JSON.parse(await readFile(process.argv[2], "utf8"));
process.stdout.write(data.previousImageId);
NODE
)"

docker image inspect "$ROLLBACK_TAG" >/dev/null 2>&1 || {
  echo "Rollback image '$ROLLBACK_TAG' is missing. Refusing to proceed." >&2
  exit 1
}
ACTUAL_ID="$(docker image inspect --format '{{.Id}}' "$ROLLBACK_TAG")"
[ "$ACTUAL_ID" = "$EXPECTED_ID" ] || {
  echo "Rollback image ID does not match the manifest. Refusing to proceed." >&2
  exit 1
}

docker compose config --quiet
docker image tag "$ROLLBACK_TAG" "$IMAGE"
docker compose up -d --no-deps --force-recreate "$SERVICE"
CONTAINER_ID="$(docker compose ps -q "$SERVICE")"
[ -n "$CONTAINER_ID" ] || { echo "Rollback container was not created." >&2; exit 1; }
TIMEOUT="${SOFIA_HEALTH_TIMEOUT_SECONDS:-120}"
if ! [[ "$TIMEOUT" =~ ^[0-9]+$ ]] || [ "$TIMEOUT" -lt 10 ]; then
  echo "SOFIA_HEALTH_TIMEOUT_SECONDS must be an integer >= 10." >&2
  exit 2
fi
DEADLINE=$((SECONDS + TIMEOUT))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  RUNNING="$(docker inspect --format '{{.State.Running}}' "$CONTAINER_ID" 2>/dev/null || echo false)"
  HEALTH="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$CONTAINER_ID" 2>/dev/null || echo missing)"
  [ "$RUNNING" = "true" ] && [ "$HEALTH" = "healthy" ] && {
    node --input-type=module - "$MANIFEST" <<'NODE'
import { readFile, writeFile } from "node:fs/promises";
const file = process.argv[2];
const data = JSON.parse(await readFile(file, "utf8"));
data.status = "rolled-back";
data.rolledBackAt = new Date().toISOString();
await writeFile(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
NODE
    echo "Previous image restored and healthy. Data volume was not modified."
    exit 0
  }
  if [ "$RUNNING" != "true" ] || [ "$HEALTH" = "unhealthy" ] || [ "$HEALTH" = "missing" ]; then
    echo "Previous image was started but did not become healthy (status: $HEALTH)." >&2
    exit 1
  fi
  sleep 3
done
echo "Rollback health check timed out. Inspect Docker logs." >&2
exit 1
