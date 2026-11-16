import { expect, type Page } from '@playwright/test';

export const IMMICH_URL = 'https://photos.e2e.test';
export const AUTHELIA_URL = 'https://auth.e2e.test:9091';
export const BRIDGE_URL = 'https://id.e2e.test:8443';
export const PASSWORD = 'e2e-password';

/** Starts Immich's OAuth sign-in from its login page. */
export async function startImmichOAuthLogin(page: Page) {
  await page.goto('/auth/login');
  await page.getByRole('button', { name: 'Login with OAuth' }).click();
}

/** Fills Authelia's 1st-factor form. */
export async function loginAtAuthelia(page: Page, username: string) {
  await page.waitForURL((url) => url.origin === AUTHELIA_URL);
  await page.locator('#username-textfield').fill(username);
  await page.locator('#password-textfield').fill(PASSWORD);
  await page.locator('#sign-in-button').click();
}

/** Waits for the Bridge's Account selection page and continues as the account labelled `label`. */
export async function chooseAccount(page: Page, label: string | RegExp) {
  await page.waitForURL((url) => url.origin === BRIDGE_URL && url.pathname.endsWith('/finish'));
  await page.getByLabel(label).check();
  await page.getByRole('button', { name: 'Continue' }).click();
}

/** Who Immich says is signed in with this browser context's cookies, or the HTTP status. */
export async function immichMe(page: Page) {
  const res = await page.request.get(`${IMMICH_URL}/api/users/me`);
  return res.ok() ? ((await res.json()) as { id: string; email: string }) : res.status();
}

/** Waits until Immich has finished the OAuth callback and returns who Immich thinks is signed in. */
export async function immichSignedInUser(page: Page) {
  // A 1st sign-in lands on /auth/onboarding, a later one on the timeline; both mean "signed in".
  await page.waitForURL((url) => url.origin === IMMICH_URL && url.pathname !== '/auth/login');
  const res = await page.request.get(`${IMMICH_URL}/api/users/me`);
  expect(res.ok(), `GET /api/users/me: ${res.status()}`).toBe(true);
  return (await res.json()) as { id: string; email: string; name: string; oauthId: string };
}
