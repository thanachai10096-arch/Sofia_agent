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
export SOFIA_HOST_PORT="$((20000 + $ % 20000))"
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
echo "Checking API authentication..."
API_KEY="$("${COMPOSE[@]}" exec -T sofia node -p 'process.env.SOFIA_API_KEY')"
[ -n "$API_KEY" ] || { echo "SOFIA_API_KEY is empty inside the container." >&2; exit 1; }
BASE_URL="http://127.0.0.1:${SOFIA_HOST_PORT}"
UNAUTH_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' "${BASE_URL}/v1/jobs")"
[ "$UNAUTH_STATUS" = "401" ] || { echo "Unauthenticated API request should return 401, got $UNAUTH_STATUS." >&2; exit 1; }
INVALID_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' -H 'Authorization: Bearer invalid-acceptance-key' "${BASE_URL}/v1/jobs")"
[ "$INVALID_STATUS" = "401" ] || { echo "Invalid API key should return 401, got $INVALID_STATUS." >&2; exit 1; }
AUTH_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' -H "Authorization: Bearer ${API_KEY}" "${BASE_URL}/v1/jobs")"
[ "$AUTH_STATUS" = "200" ] || { echo "Valid API key should return 200, got $AUTH_STATUS." >&2; exit 1; }
unset API_KEY
echo "PASS: unauthenticated and invalid keys rejected; configured API key accepted."

echo "Writing a persistence marker to the isolated data volume..."
docker run --rm -v "${SOFIA_DOCKER_VOLUME}:/data" alpine:3.20 sh -ec 'printf "persistent\n" > /data/.self-hosted-acceptance-marker'
"${COMPOSE[@]}" restart sofia
"${COMPOSE[@]}" up -d --wait --wait-timeout 120 sofia
docker run --rm -v "${SOFIA_DOCKER_VOLUME}:/data:ro" alpine:3.20 sh -ec 'test "$(cat /data/.self-hosted-acceptance-marker)" = persistent'
echo "PASS: clean-volume image build, container health, restart and persistent-volume checks."
