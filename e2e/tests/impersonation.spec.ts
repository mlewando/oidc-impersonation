import { expect, test } from '@playwright/test';
import * as oidc from 'openid-client';
import { waitForAuditLine } from './bridge-container.ts';
import {
  BRIDGE_URL,
  chooseAccount,
  IMMICH_URL,
  immichSignedInUser,
  loginAtAuthelia,
  startImmichOAuthLogin,
} from './stack.ts';

// Alice is in `photos-family`, which may impersonate the Family Target of Immich (e2e/bridge).

test('an allowed person picks Family, lands in its account, and is back in her own after picking herself', async ({
  page,
}) => {
  const since = new Date(Date.now() - 1000);
  await startImmichOAuthLogin(page);
  await loginAtAuthelia(page, 'alice');

  // The Account selection page: who she is, herself preselected, only her allowed Targets.
  await page.waitForURL((url) => url.origin === BRIDGE_URL);
  await expect(page.getByText('Signed in as Alice (alice@e2e.test)')).toBeVisible();
  await expect(page.getByLabel('Alice (yourself)')).toBeChecked();
  await expect(page.getByRole('radio')).toHaveCount(2); // herself and Family
  await chooseAccount(page, 'Family');

  // Immich auto-registers the Family account on its 1st sign-in, from exactly the Target's claims.
  const family = await immichSignedInUser(page);
  expect(family).toMatchObject({ email: 'family@e2e.test', name: 'Family', oauthId: 'e2e-family' });

  const audit = await waitForAuditLine(since, (l) => l.event === 'sign-in' && l.identity === 'impersonation');
  expect(audit).toEqual({
    ts: expect.any(String),
    event: 'sign-in',
    client: 'immich',
    realUser: 'alice',
    realSub: expect.any(String),
    identity: 'impersonation',
    target: 'family',
    result: 'ok',
    ip: expect.stringMatching(/^\d+\.\d+\.\d+\.\d+$/),
  });

  // Sign in again as Family: the same Immich account, not a new one.
  await page.request.post(`${IMMICH_URL}/api/auth/logout`);
  await startImmichOAuthLogin(page);
  await chooseAccount(page, 'Family');
  expect((await immichSignedInUser(page)).id).toBe(family.id);

  // To stop impersonating: log out and pick herself.
  await page.request.post(`${IMMICH_URL}/api/auth/logout`);
  await startImmichOAuthLogin(page);
  await chooseAccount(page, 'Alice (yourself)');
  const alice = await immichSignedInUser(page);
  expect(alice.email).toBe('alice@e2e.test');
  expect(alice.oauthId).toBe(audit.realSub);
});

test('the Account selection page cannot be framed or cached', async ({ page }) => {
  const response = page.waitForResponse((res) => res.url().startsWith(BRIDGE_URL) && res.url().endsWith('/finish'));
  await startImmichOAuthLogin(page);
  await loginAtAuthelia(page, 'alice');

  const headers = (await response).headers();
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['cache-control']).toBe('no-store');
});

test('a phone-app sign-in never shows the page, even for an allowed person', async ({ page }) => {
  const immich = await oidc.discovery(
    new URL(BRIDGE_URL),
    'immich',
    undefined,
    oidc.ClientSecretPost('e2e-immich-client-secret'),
  );
  const authUrl = oidc.buildAuthorizationUrl(immich, {
    redirect_uri: 'app.immich:///oauth-callback',
    scope: 'openid email profile',
    code_challenge: await oidc.calculatePKCECodeChallenge(oidc.randomPKCECodeVerifier()),
    code_challenge_method: 'S256',
    state: oidc.randomState(),
  });

  // The browser can't follow the final redirect to the app's custom scheme; the Bridge's redirect
  // response itself is what counts.
  const toApp = page.waitForResponse((res) => (res.headers().location ?? '').startsWith('app.immich:'));
  await page.goto(authUrl.href);
  await loginAtAuthelia(page, 'alice');

  const location = new URL((await toApp).headers().location!);
  expect(location.searchParams.has('code')).toBe(true);
});
