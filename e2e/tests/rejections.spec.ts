import { expect, test, type Page } from '@playwright/test';
import { waitForAuditLine } from './bridge-container.ts';
import { BRIDGE_URL, loginAtAuthelia, startImmichOAuthLogin } from './stack.ts';

/** Gets Alice to the Account selection page; returns where its form posts and its CSRF token. */
async function selectionForm(page: Page) {
  await startImmichOAuthLogin(page);
  await loginAtAuthelia(page, 'alice');
  await page.waitForURL((url) => url.origin === BRIDGE_URL && url.pathname.endsWith('/finish'));
  const action = new URL((await page.locator('form').getAttribute('action'))!, BRIDGE_URL).href;
  const csrf = (await page.locator('input[name="csrf"]').getAttribute('value'))!;
  return { action, csrf };
}

/** Posts the form from the same browser (its cookies), as a forged submission would. */
function post(page: Page, action: string, form: Record<string, string>) {
  return page.request.post(action, { form, maxRedirects: 0 });
}

test('a posted Target the person may not impersonate is refused and audited as not-allowed', async ({ page }) => {
  const since = new Date(Date.now() - 1000);
  const { action, csrf } = await selectionForm(page);

  const res = await post(page, action, { csrf, account: 'archive' });

  expect(res.status()).toBe(403);
  expect(res.headers().location).toBeUndefined(); // no code goes back to the app
  const body = await res.text();
  expect(body).toContain('This sign-in was refused');
  expect(body).not.toContain(csrf);
  expect(await waitForAuditLine(since, (l) => l.result === 'not-allowed')).toEqual({
    ts: expect.any(String),
    event: 'sign-in',
    client: 'immich',
    realUser: 'alice',
    realSub: expect.any(String),
    target: 'archive',
    result: 'not-allowed',
    ip: expect.stringMatching(/^\d+\.\d+\.\d+\.\d+$/),
  });
});

test('a choice posted without the right CSRF token is refused and audited as bad-csrf', async ({ page }) => {
  const since = new Date(Date.now() - 1000);
  const { action, csrf } = await selectionForm(page);

  const res = await post(page, action, { csrf: 'forged', account: 'family' });

  expect(res.status()).toBe(403);
  expect(res.headers().location).toBeUndefined();
  expect(await waitForAuditLine(since, (l) => l.result === 'bad-csrf')).toMatchObject({
    event: 'sign-in',
    client: 'immich',
    realUser: 'alice',
    result: 'bad-csrf',
  });

  // The page can't be submitted again, not even with the right token.
  expect((await post(page, action, { csrf, account: 'family' })).status()).toBe(400);
});

test('an upstream account whose email is a Target email is refused and audited', async ({ page }) => {
  const since = new Date(Date.now() - 1000);
  const response = page.waitForResponse((res) => res.url().startsWith(BRIDGE_URL) && res.url().endsWith('/finish'));
  await startImmichOAuthLogin(page);
  await loginAtAuthelia(page, 'mallory');

  const res = await response;
  expect(res.status()).toBe(403);
  await expect(page.getByRole('heading', { name: 'Sign-in refused' })).toBeVisible();
  expect(await waitForAuditLine(since, (l) => l.result === 'email-collides-with-target')).toEqual({
    ts: expect.any(String),
    event: 'sign-in',
    client: 'immich',
    realUser: 'mallory',
    realSub: expect.any(String),
    target: 'family',
    result: 'email-collides-with-target',
    ip: expect.stringMatching(/^\d+\.\d+\.\d+\.\d+$/),
  });
});
