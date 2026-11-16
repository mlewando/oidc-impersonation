import { auditLinesSince, pollUntil } from './tests/bridge-container.ts';
import { IMMICH_URL } from './tests/stack.ts';

export default async function globalSetup() {
  // Immich needs an admin before anyone can sign in; create it once per fresh stack.
  const res = await fetch(`${IMMICH_URL}/api/auth/admin-sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@e2e.test', password: 'e2e-admin-password', name: 'Admin' }),
  });
  if (!res.ok && res.status !== 400) {
    throw new Error(`Immich admin sign-up failed: ${res.status} ${await res.text()}`);
  }

  // A fresh stack has no session registry, so the Bridge's 1st start logs out every Target of
  // Immich by `sub` (retrying while Immich starts). Let that settle, or it could end a test's
  // Impersonation session.
  await pollUntil(
    async () => (await auditLinesSince(new Date(0))).filter((l) => l.event === 'impersonation-logout').length >= 3,
    120_000,
    'settled startup logouts',
  );
}
