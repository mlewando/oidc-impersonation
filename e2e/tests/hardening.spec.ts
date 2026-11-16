import { expect, test } from '@playwright/test';
import * as oidc from 'openid-client';
import { HEALTHZ_AUTH } from './bridge-container.ts';
import { AUTHELIA_URL, BRIDGE_URL, loginAtAuthelia } from './stack.ts';

// The Bridge's provider side, locked down to the README's security model.

const RP_CALLBACK = 'http://rp.e2e.test/callback';

async function discoverRp() {
  return oidc.discovery(new URL(BRIDGE_URL), 'e2e-rp', undefined, oidc.ClientSecretBasic('e2e-rp-client-secret'));
}

async function rpAuthUrl(rp: oidc.Configuration, extra: Record<string, string> = {}) {
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const url = oidc.buildAuthorizationUrl(rp, {
    redirect_uri: RP_CALLBACK,
    scope: 'openid',
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    ...extra,
  });
  return { url, codeVerifier, state };
}

// ADR 0002. Uses `e2e-rp` with scope `openid`: with nothing to consent to, a remembered Bridge
// session would answer the 2nd request without any interaction.
test('the Bridge keeps no login session: after the Upstream session ends, the next sign-in prompts upstream', async ({
  page,
}) => {
  const rp = await discoverRp();
  const first = await rpAuthUrl(rp);
  const callback = page.waitForRequest((req) => req.url().startsWith(RP_CALLBACK));
  await page.goto(first.url.href);
  await loginAtAuthelia(page, 'alice');
  await callback;

  // End the Upstream session, but keep every Bridge cookie.
  expect((await page.request.post(`${AUTHELIA_URL}/api/logout`, { data: {} })).ok()).toBe(true);

  const second = await rpAuthUrl(rp);
  await page.goto(second.url.href).catch(() => undefined);
  await page.waitForURL((url) => url.origin === AUTHELIA_URL);
  await expect(page.locator('#username-textfield')).toBeVisible();
});

test('prompt=none fails with login_required instead of reusing an earlier sign-in', async ({ page }) => {
  const rp = await discoverRp();
  const first = await rpAuthUrl(rp);
  let callback = page.waitForRequest((req) => req.url().startsWith(RP_CALLBACK));
  await page.goto(first.url.href);
  await loginAtAuthelia(page, 'alice');
  await callback;

  const silent = await rpAuthUrl(rp, { prompt: 'none' });
  callback = page.waitForRequest((req) => req.url().startsWith(RP_CALLBACK));
  await page.goto(silent.url.href).catch(() => undefined);
  const callbackUrl = new URL((await callback).url());

  expect(callbackUrl.searchParams.get('error')).toBe('login_required');
});

test('discovery advertises only what the Bridge supports', async ({ request }) => {
  const res = await request.get(`${BRIDGE_URL}/.well-known/openid-configuration`);
  const meta = await res.json();

  expect(meta.grant_types_supported).toEqual(['authorization_code']);
  expect(meta.response_types_supported).toEqual(['code']);
  expect(meta.code_challenge_methods_supported).toEqual(['S256']);
  expect(meta.id_token_signing_alg_values_supported).toEqual(['RS256']);
  expect(meta.scopes_supported).not.toContain('offline_access');
  for (const endpoint of [
    'registration_endpoint',
    'introspection_endpoint',
    'revocation_endpoint',
    'end_session_endpoint',
    'pushed_authorization_request_endpoint',
    'device_authorization_endpoint',
    'backchannel_authentication_endpoint',
  ]) {
    expect(meta, endpoint).not.toHaveProperty(endpoint);
  }
  expect(meta).not.toHaveProperty('dpop_signing_alg_values_supported');
});

test('/healthz needs its basic-auth credentials', async ({ request }) => {
  expect((await request.get(`${BRIDGE_URL}/healthz`)).status()).toBe(401);
  expect((await request.get(`${BRIDGE_URL}/healthz`, { headers: { authorization: HEALTHZ_AUTH } })).status()).toBe(200);
});

test('disabled endpoints are not reachable', async ({ request }) => {
  for (const path of ['/reg', '/token/introspection', '/token/revocation', '/session/end', '/request', '/device/auth']) {
    const res = await request.post(`${BRIDGE_URL}${path}`, { form: { client_id: 'e2e-rp' } });
    expect(res.status(), path).toBe(404);
  }
});

test('no refresh token is issued, even when offline_access is requested', async ({ page }) => {
  const rp = await discoverRp();
  const { url: authUrl, codeVerifier, state } = await rpAuthUrl(rp, {
    scope: 'openid email offline_access',
    prompt: 'consent',
  });

  const callback = page.waitForRequest((req) => req.url().startsWith(RP_CALLBACK));
  await page.goto(authUrl.href);
  await loginAtAuthelia(page, 'alice');
  const callbackUrl = new URL((await callback).url());

  const tokens = await oidc.authorizationCodeGrant(rp, callbackUrl, {
    pkceCodeVerifier: codeVerifier,
    expectedState: state,
  });
  expect(tokens.refresh_token).toBeUndefined();
  expect(tokens.scope?.split(' ') ?? []).not.toContain('offline_access');
});
