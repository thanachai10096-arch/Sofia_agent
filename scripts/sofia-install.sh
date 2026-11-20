#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
ENV_FILE="$ROOT_DIR/.env"
EXAMPLE_FILE="$ROOT_DIR/.env.example"

if [[ ! -f "$EXAMPLE_FILE" ]]; then
  echo "Missing .env.example. Run this script from a complete Sofia Agent checkout." >&2
  exit 1
fi

if [[ -e "$ENV_FILE" ]]; then
  echo "Refusing to overwrite existing .env. Your current configuration was left unchanged." >&2
else
  cp "$EXAMPLE_FILE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  if ! command -v openssl >/dev/null 2>&1; then
    rm -f "$ENV_FILE"
    echo "OpenSSL is required to generate a secure SOFIA_API_KEY." >&2
    exit 1
  fi
  API_KEY="$(openssl rand -hex 32)"
  TMP_ENV="$(mktemp "$ROOT_DIR/.env.XXXXXX")"
  trap 'rm -f "$TMP_ENV"' EXIT
  awk -v key="$API_KEY" 'BEGIN { found = 0 } /^SOFIA_API_KEY=/ { print "SOFIA_API_KEY=" key; found = 1; next } { print } END { if (!found) exit 2 }' "$ENV_FILE" > "$TMP_ENV"
  chmod 600 "$TMP_ENV"
  mv "$TMP_ENV" "$ENV_FILE"
  trap - EXIT
  echo "Created private .env and generated a unique SOFIA_API_KEY."
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Install Docker Engine and the Compose plugin, then rerun this script." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is unavailable. Install the Docker Compose plugin, then rerun this script." >&2
  exit 1
fi

cat <<'EOF'

Next steps:
  1. Edit .env and configure exactly one supported model provider and its API credential.
  2. Review SOFIA_ALLOW_SHELL and SOFIA_ALLOW_BROWSER; keep both disabled unless explicitly needed.
  3. Start Sofia:
       docker compose config --quiet
       docker compose up -d --build
  4. Check readiness:
       curl --fail http://127.0.0.1:3000/health

Keep .env private. Back up the sofia-agent-data Docker volume before upgrades.
EOF
