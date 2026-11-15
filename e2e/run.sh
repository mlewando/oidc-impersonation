#!/bin/sh
# Brings up the e2e stack from scratch, runs the Playwright suite, and tears everything down.
# KEEP_STACK=1 leaves the stack running afterwards for debugging.
set -eu

compose() {
  docker compose -f "$(dirname "$0")/compose.yaml" --profile test "$@"
}

if [ "${KEEP_STACK:-}" != "1" ]; then
  trap 'compose logs bridge > "$(dirname "$0")/results/bridge.log" 2>&1 || true; compose down -v --remove-orphans' EXIT
fi

mkdir -p "$(dirname "$0")/results"
compose down -v --remove-orphans
compose build
compose up -d --wait authelia bridge photos
compose run --rm e2e "$@"
