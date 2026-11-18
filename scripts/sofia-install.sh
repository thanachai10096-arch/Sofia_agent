#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
  export SOFIA_INSTALL_API_KEY="$API_KEY"
  node --input-type=module <<'NODE'
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
const file = ".env";
const key = process.env.SOFIA_INSTALL_API_KEY;
if (!key || !/^[a-f0-9]{64}$/.test(key)) throw new Error("Generated API key did not pass validation.");
let env = readFileSync(file, "utf8");
if (!/^SOFIA_API_KEY=.*$/m.test(env)) throw new Error("SOFIA_API_KEY entry is missing from .env.example.");
env = env.replace(/^SOFIA_API_KEY=.*$/m, "SOFIA_API_KEY=" + key);
writeFileSync(file, env, { mode: 0o600 });
chmodSync(file, 0o600);
NODE
  unset SOFIA_INSTALL_API_KEY
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
