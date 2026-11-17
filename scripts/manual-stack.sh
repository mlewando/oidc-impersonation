#!/bin/sh
# Starts the e2e stack (Authelia ⇄ Bridge ⇄ Immich) for clicking through it by hand, without the
# Playwright runner. `pnpm stack` starts it, `pnpm stack down` removes it and its data.
# Needs: 127.0.0.1 auth.oidc-bridge.test id.oidc-bridge.test photos.oidc-bridge.test in /etc/hosts.
set -eu

e2e="$(cd "$(dirname "$0")/../e2e" && pwd)"
compose() {
  docker compose -f "$e2e/compose.yaml" -f "$e2e/compose.manual.yaml" "$@"
}

if [ "${1:-up}" = "down" ]; then
  compose down -v --remove-orphans
  exit 0
fi

if ! grep -q 'photos\.oidc-bridge\.test' /etc/hosts; then
  echo "Add this line to /etc/hosts first (for example with: sudo nano /etc/hosts):" >&2
  echo "  127.0.0.1 auth.oidc-bridge.test id.oidc-bridge.test photos.oidc-bridge.test" >&2
  exit 1
fi

compose up -d --build --wait authelia bridge photos

# Immich needs an admin before anyone can sign in through OAuth.
curl -sk --resolve photos.oidc-bridge.test:443:127.0.0.1 -o /dev/null \
  -H 'content-type: application/json' \
  -d '{"email":"admin@oidc-bridge.test","password":"e2e-admin-password","name":"Admin"}' \
  https://photos.oidc-bridge.test/api/auth/admin-sign-up

# The Bridge's 1st start logs out every Target by sub (no session registry yet), retrying while
# Immich starts. Wait for that, so it can't end an Impersonation you start right away.
printf 'Waiting for the startup logouts to settle'
until [ "$(compose logs --no-log-prefix bridge 2>/dev/null | grep -c '"impersonation-logout"')" -ge 3 ]; do
  printf '.'
  sleep 2
done
echo

mkdir -p "$e2e/results"
compose cp certs:/out/ca.crt "$e2e/results/ca.crt" >/dev/null 2>&1

cat <<EOF

The stack is up. Open https://photos.oidc-bridge.test and click "Login with OAuth".

  alice    may impersonate Family, and Brief visit (signed out after 8 s)
  bob      no Targets: signs in as himself, never sees the selection page
  family   the Family account itself: signs in as Family without impersonating (and may
           impersonate Brief visit)
  mallory  refused: her email is the Family Target's, but she isn't that account
  Every password is e2e-password. Immich admin: admin@oidc-bridge.test / e2e-admin-password.

Certificates come from a throwaway test CA: accept the browser warning, or trust
  $e2e/results/ca.crt
for this stack's lifetime (a new CA is made each time the stack is created).

Audit log:  docker logs -f oidc-impersonation-e2e-bridge-1
Remove:     pnpm stack down
EOF
