#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }
docker compose version >/dev/null
[ -f .env ] || { echo "Missing .env. Copy .env.example to .env before running this acceptance test." >&2; exit 1; }
RUN_SUFFIX="${GITHUB_RUN_ID:-local}-$$"
export SOFIA_DOCKER_VOLUME="sofia-acceptance-${RUN_SUFFIX}"
export SOFIA_IMAGE="sofia-agent:acceptance-${RUN_SUFFIX}"
export SOFIA_HOST_PORT=0
PROJECT="sofia-acceptance-${RUN_SUFFIX}"
COMPOSE=(docker compose --project-name "$PROJECT" -f compose.yaml)
cleanup() {
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker image rm "$SOFIA_IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT
echo "Building and starting an isolated Sofia installation..."
"${COMPOSE[@]}" up -d --build --wait --wait-timeout 180 sofia
CONTAINER_ID="$("${COMPOSE[@]}" ps -q sofia)"
[ -n "$CONTAINER_ID" ] || { echo "Sofia container was not created." >&2; exit 1; }
HEALTH="$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER_ID")"
[ "$HEALTH" = "healthy" ] || { echo "Sofia did not become healthy: $HEALTH" >&2; exit 1; }
echo "Writing a persistence marker to the isolated data volume..."
docker run --rm -v "${SOFIA_DOCKER_VOLUME}:/data" alpine:3.20 sh -ec 'printf "persistent\n" > /data/.self-hosted-acceptance-marker'
"${COMPOSE[@]}" restart sofia
"${COMPOSE[@]}" up -d --wait --wait-timeout 120 sofia
docker run --rm -v "${SOFIA_DOCKER_VOLUME}:/data:ro" alpine:3.20 sh -ec 'test "$(cat /data/.self-hosted-acceptance-marker)" = persistent'
echo "PASS: clean-volume image build, container health, restart and persistent-volume checks."
