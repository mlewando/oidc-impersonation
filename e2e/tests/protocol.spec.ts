import { expect, test, type Page } from '@playwright/test';
import * as oidc from 'openid-client';
import { auditLinesSince, bridgeStdout, waitForAuditLine } from './bridge-output.ts';
import { BRIDGE_URL, loginAtAuthelia } from './stack.ts';

// Drives the Bridge as a plain OIDC client (`e2e-rp`, client_secret_basic) to check the protocol
// directly, without Immich in between.

const RP_CALLBACK = 'http://rp.e2e.test/callback';

async function discoverRp() {
  return oidc.discovery(new URL(BRIDGE_URL), 'e2e-rp', undefined, oidc.ClientSecretBasic('e2e-rp-client-secret'));
}

/**
 * Opens `authUrl` in the browser and returns the URL the Bridge finally redirects back to.
 * Nothing listens at rp.e2e.test: the request is only observed (Playwright can't route a request
 * that is the target of a redirect), and its failure doesn't matter.
 */
async function followToRp(page: Page, authUrl: URL, opts: { login: boolean }) {
  const callback = page.waitForRequest((req) => req.url().startsWith(RP_CALLBACK));
  // Without a login step the Bridge redirects straight to the RP, so this navigation itself ends at
  // the unresolvable host and fails; the observed request is what counts.
  await page.goto(authUrl.href).catch(() => undefined);
  if (opts.login) await loginAtAuthelia(page, 'alice');
  return new URL((await callback).url());
}

for (const [label, pkce] of [
  ['without PKCE', {}],
  ['with plain PKCE', { code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' }],
] as const) {
  test(`rejects an authorization request ${label}`, async ({ page }) => {
    const rp = await discoverRp();
    const authUrl = oidc.buildAuthorizationUrl(rp, {
      redirect_uri: RP_CALLBACK,
      scope: 'openid',
      state: oidc.randomState(),
      ...pkce,
    });

    const callbackUrl = await followToRp(page, authUrl, { login: false });

    expect(callbackUrl.searchParams.get('error')).toBe('invalid_request');
    expect(callbackUrl.searchParams.has('code')).toBe(false);
  });
}

test('rejects a redirect URI the client did not register, without redirecting to it', async ({ page }) => {
  const rp = await discoverRp();
  const authUrl = oidc.buildAuthorizationUrl(rp, {
    redirect_uri: 'http://evil.e2e.test/callback',
    scope: 'openid',
    code_challenge: await oidc.calculatePKCECodeChallenge(oidc.randomPKCECodeVerifier()),
    code_challenge_method: 'S256',
  });
  const leaked: string[] = [];
  page.on('request', (req) => {
    if (req.url().startsWith('http://evil.e2e.test')) leaked.push(req.url());
  });

  const res = await page.goto(authUrl.href);

  expect(res?.status()).toBe(400);
  await expect(page.getByText('invalid_redirect_uri')).toBeVisible();
  expect(leaked).toEqual([]);
});

test('issues an RS256 ID token for the requesting client, bound to its nonce, with the Personal identity', async ({
  page,
}) => {
  const rp = await discoverRp();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const nonce = oidc.randomNonce();
  const state = oidc.randomState();
  const authUrl = oidc.buildAuthorizationUrl(rp, {
    redirect_uri: RP_CALLBACK,
    scope: 'openid email profile',
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    nonce,
    state,
  });

  const callbackUrl = await followToRp(page, authUrl, { login: true });
  const tokens = await oidc.authorizationCodeGrant(rp, callbackUrl, {
    pkceCodeVerifier: codeVerifier,
    expectedNonce: nonce,
    expectedState: state,
    idTokenExpected: true,
  });

  const header = JSON.parse(Buffer.from(tokens.id_token!.split('.')[0]!, 'base64url').toString());
  expect(header.alg).toBe('RS256');

  const claims = tokens.claims()!;
  expect(claims.aud).toBe('e2e-rp');
  expect(claims.nonce).toBe(nonce);
  expect(claims).toMatchObject({ email: 'alice@e2e.test', name: 'Alice', preferred_username: 'alice' });

  const userinfo = await oidc.fetchUserInfo(rp, tokens.access_token, claims.sub);
  expect(userinfo).toEqual({
    sub: claims.sub,
    email: 'alice@e2e.test',
    name: 'Alice',
    preferred_username: 'alice',
  });

  // The ID token describes exactly the same identity as userinfo: apart from protocol claims,
  // nothing more and nothing less.
  const protocolClaims = new Set(['iss', 'aud', 'exp', 'iat', 'nonce', 'at_hash', 'c_hash', 'auth_time', 'sid', 'azp', 'acr', 'amr']);
  const identityInIdToken = Object.fromEntries(Object.entries(claims).filter(([k]) => !protocolClaims.has(k)));
  expect(identityInIdToken).toEqual(userinfo);
});

test('a reused authorization code is rejected and audited as replay; no secret reaches stdout', async ({ page }) => {
  const since = new Date(Date.now() - 1000);
  const rp = await discoverRp();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const authUrl = oidc.buildAuthorizationUrl(rp, {
    redirect_uri: RP_CALLBACK,
    scope: 'openid email profile',
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
  });
  const callbackUrl = await followToRp(page, authUrl, { login: true });
  const checks = { pkceCodeVerifier: codeVerifier, expectedState: state };

  const tokens = await oidc.authorizationCodeGrant(rp, callbackUrl, checks);
  await expect(oidc.authorizationCodeGrant(rp, callbackUrl, checks)).rejects.toMatchObject({
    error: 'invalid_grant',
  });

  const replay = await waitForAuditLine(since, (l) => l.result === 'replay');
  expect(replay).toEqual({
    ts: expect.any(String),
    event: 'sign-in',
    client: 'e2e-rp',
    result: 'replay',
    ip: expect.stringMatching(/^\d+\.\d+\.\d+\.\d+$/),
  });

  // Every stdout line is an audit JSON line, and none carries a code, token, cookie or secret.
  const lines = await auditLinesSince(new Date(0));
  expect(lines.length).toBeGreaterThan(0);
  const stdout = await bridgeStdout();
  const secrets = [
    callbackUrl.searchParams.get('code')!,
    tokens.access_token,
    tokens.id_token!,
    codeVerifier,
    state,
    'e2e-rp-client-secret',
    'e2e-immich-client-secret',
    'e2e-upstream-client-secret',
    'e2e-cookie-secret',
    ...(await page.context().cookies()).map((c) => c.value).filter((v) => v.length >= 8),
  ];
  for (const secret of secrets) {
    expect(stdout, 'stdout must not contain a secret').not.toContain(secret);
  }
});
