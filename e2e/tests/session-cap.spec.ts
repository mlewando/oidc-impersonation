import { expect, test, type Browser, type Page } from '@playwright/test';
import { forgetSessionRegistry, restartBridge, waitForAuditLine } from './bridge-container.ts';
import { chooseAccount, immichMe, immichSignedInUser, loginAtAuthelia, startImmichOAuthLogin } from './stack.ts';

// ADR 0003: the Bridge ends Impersonation sessions in Immich through back-channel logout. Each
// test keeps 2 browsers open: Alice impersonating a Target, and Bob signed in as himself.

async function signedIn(browser: Browser, user: string, account?: string) {
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true, baseURL: 'https://photos.e2e.test' })).newPage();
  await startImmichOAuthLogin(page);
  await loginAtAuthelia(page, user);
  if (account) await chooseAccount(page, account);
  await immichSignedInUser(page);
  return page;
}

/** Waits until Immich no longer accepts this browser's session. */
async function expectSignedOut(page: Page, timeoutMs: number) {
  await expect.poll(() => immichMe(page), { timeout: timeoutMs, intervals: [500] }).toBe(401);
}

test('after its session_ttl, Immich drops the Impersonation session and keeps the Personal one', async ({ browser }) => {
  const since = new Date(Date.now() - 1000);
  const alice = await signedIn(browser, 'alice', 'Brief visit'); // session_ttl: 8s
  const bob = await signedIn(browser, 'bob');
  expect(await immichMe(alice)).toMatchObject({ email: 'brief@e2e.test' });

  await expectSignedOut(alice, 20_000);
  expect(await immichMe(bob)).toMatchObject({ email: 'bob@e2e.test' });
  expect(await waitForAuditLine(since, (l) => l.event === 'impersonation-logout' && l.reason === 'ttl')).toEqual({
    ts: expect.any(String),
    event: 'impersonation-logout',
    client: 'immich',
    target: 'brief',
    realUser: 'alice',
    realSub: expect.any(String),
    reason: 'ttl',
    result: 'ok',
  });
});

test('a Bridge restart keeps Impersonation sessions open: their logouts resume from the store', async ({ browser }) => {
  const since = new Date(Date.now() - 1000);
  const alice = await signedIn(browser, 'alice', 'Family'); // session_ttl: 1h

  await restartBridge();

  expect(await immichMe(alice)).toMatchObject({ email: 'family@e2e.test' });
  const startupLogouts = (l: { event: string; reason?: unknown }) => l.event === 'impersonation-logout' && l.reason === 'startup';
  await expect(waitForAuditLine(since, startupLogouts, 3_000)).rejects.toThrow();
});

test('if the store lost the registry, a restart logs out every Target by sub and keeps Personal sessions', async ({
  browser,
}) => {
  const since = new Date(Date.now() - 1000);
  const alice = await signedIn(browser, 'alice', 'Family');
  const bob = await signedIn(browser, 'bob');

  await forgetSessionRegistry();
  await restartBridge();

  await expectSignedOut(alice, 20_000);
  expect(await immichMe(bob)).toMatchObject({ email: 'bob@e2e.test' });
  expect(await waitForAuditLine(since, (l) => l.reason === 'startup' && l.target === 'family')).toEqual({
    ts: expect.any(String),
    event: 'impersonation-logout',
    client: 'immich',
    target: 'family',
    reason: 'startup',
    result: 'ok',
  });
});
