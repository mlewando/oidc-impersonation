import { expect, test } from '@playwright/test';
import {
  AUTHELIA_URL,
  IMMICH_URL,
  immichSignedInUser,
  loginAtAuthelia,
  startImmichOAuthLogin,
} from './stack.ts';
import { waitForAuditLine } from './bridge-output.ts';

test('a real person signs in to Immich through the Bridge and lands in their own account', async ({ page }) => {
  const since = new Date(Date.now() - 1000);
  await startImmichOAuthLogin(page);
  await loginAtAuthelia(page, 'alice');

  const user = await immichSignedInUser(page);
  expect(user.email).toBe('alice@e2e.test');
  expect(user.name).toBe('Alice');

  const audit = await waitForAuditLine(since, (l) => l.event === 'sign-in' && l.client === 'immich');
  expect(audit).toEqual({
    ts: expect.any(String),
    event: 'sign-in',
    client: 'immich',
    realUser: 'alice',
    realSub: user.oauthId, // Immich stores the `sub` it received as oauthId
    identity: 'personal',
    result: 'ok',
    ip: expect.stringMatching(/^\d+\.\d+\.\d+\.\d+$/), // the browser container; no trusted proxy
  });
});

test('a 2nd sign-in reuses the Upstream session without a login prompt', async ({ page }) => {
  await startImmichOAuthLogin(page);
  await loginAtAuthelia(page, 'alice');
  await immichSignedInUser(page);

  await page.request.post(`${IMMICH_URL}/api/auth/logout`);

  // Upstream redirects that skip the login form never commit a page, so any Authelia page that
  // does commit means the person was prompted.
  const autheliaPages: string[] = [];
  page.on('framenavigated', (frame) => {
    const url = new URL(frame.url());
    if (frame === page.mainFrame() && url.origin === AUTHELIA_URL) autheliaPages.push(url.pathname);
  });

  await startImmichOAuthLogin(page);
  const user = await immichSignedInUser(page);

  expect(user.email).toBe('alice@e2e.test');
  expect(autheliaPages, 'Authelia must not show its login page again').toEqual([]);
});
