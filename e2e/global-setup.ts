import { IMMICH_URL } from './tests/stack.ts';

/** Immich needs an admin before anyone can sign in; create it once per fresh stack. */
export default async function globalSetup() {
  const res = await fetch(`${IMMICH_URL}/api/auth/admin-sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@e2e.test', password: 'e2e-admin-password', name: 'Admin' }),
  });
  if (!res.ok && res.status !== 400) {
    throw new Error(`Immich admin sign-up failed: ${res.status} ${await res.text()}`);
  }
}
