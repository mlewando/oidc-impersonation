#!/bin/sh
# Runs the Store contract tests against a throwaway Valkey container, then removes it.
# Uses the same pinned image as the e2e stack (`x-valkey-image` in e2e/compose.yaml).
set -eu

image="$(sed -n 's/^x-valkey-image: &valkey-image //p' "$(dirname "$0")/../e2e/compose.yaml")"
name=oidc-impersonation-test-valkey

docker run -d --rm --name "$name" -p 127.0.0.1:6390:6379 "$image" >/dev/null
trap 'docker stop "$name" >/dev/null' EXIT

VALKEY_URL=redis://127.0.0.1:6390 pnpm vitest run test/store.test.ts
