#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
PID_FILE="$ROOT_DIR/.host.pid"
LOG_FILE="$ROOT_DIR/.host.log"

if [ ! -f "$ENV_FILE" ]; then
  echo "[dev-with-env] .env not found: $ENV_FILE" >&2
  exit 1
fi

cd "$ROOT_DIR"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [ "${1:-}" = "--bg" ]; then
  nohup corepack pnpm dev >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "[dev-with-env] started in background: pid=$(cat "$PID_FILE"), log=$LOG_FILE"
  exit 0
fi

exec corepack pnpm dev
