import { expect, test } from '@playwright/test';
import { restartBridge } from './bridge-container.ts';
import { AUTHELIA_URL, immichSignedInUser, loginAtAuthelia, startImmichOAuthLogin } from './stack.ts';

// The Bridge keeps its state in Valkey (ADR 0005), so a restart is invisible to a sign-in.

test('a sign-in started before a Bridge restart finishes after it', async ({ page }) => {
  await startImmichOAuthLogin(page);
  await page.waitForURL((url) => url.origin === AUTHELIA_URL);

  await restartBridge();

  await loginAtAuthelia(page, 'alice');
  const user = await immichSignedInUser(page);
  expect(user.email).toBe('alice@e2e.test');
});
