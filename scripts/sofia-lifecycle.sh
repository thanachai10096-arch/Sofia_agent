#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMMAND="${1:-status}"
BACKUP_DIR="${SOFIA_BACKUP_DIR:-$ROOT_DIR/backups}"
SERVICE="${SOFIA_COMPOSE_SERVICE:-sofia}"

case "$COMMAND" in
  status)
    command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }
    docker compose config --quiet
    printf 'Compose service: %s\n' "$SERVICE"
    docker compose ps "$SERVICE"
    CONTAINER_ID="$(docker compose ps -q "$SERVICE")"
    if [ -n "$CONTAINER_ID" ]; then
      docker inspect --format 'Container image: {{.Config.Image}}{{printf "\n"}}Image ID: {{.Image}}{{printf "\n"}}Running: {{.State.Running}}{{printf "\n"}}Health: {{if .State.Health}}{{.State.Health.Status}}{{else}}not-configured{{end}}' "$CONTAINER_ID"
    else
      echo "No container currently exists for service '$SERVICE'."
    fi
    if [ -d "$BACKUP_DIR" ]; then
      node --input-type=module - "$BACKUP_DIR" <<'NODE'
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
const dir = process.argv[2];
const names = (await readdir(dir)).filter(name => /^upgrade-.*\.json$/.test(name)).sort().reverse();
console.log("Recent upgrade history:");
for (const name of names.slice(0, 10)) {
  try {
    const item = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    console.log(JSON.stringify({ manifest: name, createdAt: item.createdAt, status: item.status, image: item.image, verifiedAt: item.verifiedAt, rollbackReason: item.rollbackReason }));
  } catch {
    console.log(JSON.stringify({ manifest: name, status: "unreadable" }));
  }
}
NODE
    fi
    ;;
  history)
    node --input-type=module - "$BACKUP_DIR" <<'NODE'
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
const dir = process.argv[2];
let names = [];
try { names = (await readdir(dir)).filter(name => /^upgrade-.*\.json$/.test(name)).sort().reverse(); }
catch (error) { if (error.code !== "ENOENT") throw error; }
for (const name of names) {
  try {
    const data = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    console.log(JSON.stringify({ manifest: name, createdAt: data.createdAt, status: data.status, image: data.image, previousImageId: data.previousImageId, rollbackTag: data.rollbackTag, verifiedAt: data.verifiedAt, rollbackReason: data.rollbackReason }));
  } catch {
    console.log(JSON.stringify({ manifest: name, status: "unreadable" }));
  }
}
NODE
    ;;
  *)
    echo "Usage: $0 [status|history]" >&2
    exit 2
    ;;
esac
