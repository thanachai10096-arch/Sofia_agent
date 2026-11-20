#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "openssl is required." >&2; exit 1; }
docker compose version >/dev/null
[ -f .env ] || { echo "Missing .env. Copy .env.example to .env first." >&2; exit 1; }

RUN_SUFFIX="${GITHUB_RUN_ID:-local}-$$"
IMAGE="sofia-agent:isolation-${RUN_SUFFIX}"
PROJECT_A="sofia-isolation-a-${RUN_SUFFIX}"
PROJECT_B="sofia-isolation-b-${RUN_SUFFIX}"
VOLUME_A="sofia-isolation-a-${RUN_SUFFIX}"
VOLUME_B="sofia-isolation-b-${RUN_SUFFIX}"
PORT_A="$((21000 + BASHPID % 18000))"
PORT_B="$((PORT_A + 1))"
TMP_DIR="$(mktemp -d)"
ENV_A="$TMP_DIR/installation-a.env"
ENV_B="$TMP_DIR/installation-b.env"
KEY_A="$(openssl rand -hex 32)"
KEY_B="$(openssl rand -hex 32)"
[ "$KEY_A" != "$KEY_B" ] || { echo "Failed to generate distinct API keys." >&2; exit 1; }
cp .env "$ENV_A"
cp .env "$ENV_B"
chmod 600 "$ENV_A" "$ENV_B"
sed -i "s/^SOFIA_API_KEY=.*/SOFIA_API_KEY=$KEY_A/" "$ENV_A"
sed -i "s/^SOFIA_API_KEY=.*/SOFIA_API_KEY=$KEY_B/" "$ENV_B"

compose() {
  local project="$1" env_file="$2" volume="$3" port="$4"
  shift 4
  SOFIA_ENV_FILE="$env_file" SOFIA_DOCKER_VOLUME="$volume" SOFIA_IMAGE="$IMAGE" SOFIA_HOST_PORT="$port" \
    docker compose --project-name "$project" -f compose.yaml "$@"
}
cleanup() {
  compose "$PROJECT_A" "$ENV_A" "$VOLUME_A" "$PORT_A" down --volumes --remove-orphans >/dev/null 2>&1 || true
  compose "$PROJECT_B" "$ENV_B" "$VOLUME_B" "$PORT_B" down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "Building one image for two isolated Sofia installations..."
docker build --tag "$IMAGE" .
compose "$PROJECT_A" "$ENV_A" "$VOLUME_A" "$PORT_A" up -d --wait --wait-timeout 180 sofia
compose "$PROJECT_B" "$ENV_B" "$VOLUME_B" "$PORT_B" up -d --wait --wait-timeout 180 sofia

check_status() {
  local expected="$1"
  shift
  local actual
  actual="$(curl --silent --output /dev/null --write-out '%{http_code}' "$@")"
  [ "$actual" = "$expected" ] || {
    echo "Expected HTTP $expected, received $actual." >&2
    return 1
  }
}
BASE_A="http://127.0.0.1:$PORT_A"
BASE_B="http://127.0.0.1:$PORT_B"

echo "Verifying each installation accepts only its own API key..."
check_status 200 -H "Authorization: Bearer $KEY_A" "$BASE_A/v1/jobs"
check_status 200 -H "Authorization: Bearer $KEY_B" "$BASE_B/v1/jobs"
check_status 401 -H "Authorization: Bearer $KEY_A" "$BASE_B/v1/jobs"
check_status 401 -H "Authorization: Bearer $KEY_B" "$BASE_A/v1/jobs"
check_status 401 "$BASE_A/v1/jobs"
check_status 401 "$BASE_B/v1/jobs"
unset KEY_A KEY_B
echo "PASS: two installations have distinct credentials and reject cross-installation API keys."

echo "Verifying their persistent volumes are distinct..."
docker run --rm -v "$VOLUME_A:/data" alpine:3.20 sh -ec 'printf "installation-a\n" > /data/.isolation-marker'
docker run --rm -v "$VOLUME_B:/data" alpine:3.20 sh -ec 'printf "installation-b\n" > /data/.isolation-marker'
docker run --rm -v "$VOLUME_A:/data:ro" alpine:3.20 sh -ec 'test "$(cat /data/.isolation-marker)" = installation-a'
docker run --rm -v "$VOLUME_B:/data:ro" alpine:3.20 sh -ec 'test "$(cat /data/.isolation-marker)" = installation-b'
echo "PASS: each installation has a distinct persistent volume."
