import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeConfig } from '../src/config.ts';
import { createProvider } from '../src/provider.ts';
import { memoryStore } from '../src/store.ts';

const signingKeyPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

let app: Server | undefined;
afterEach(() => app?.close());

/** A Client app's back-channel logout endpoint: records each form body, answers `status`. */
async function logoutEndpoint(status: number) {
  const bodies: URLSearchParams[] = [];
  app = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      bodies.push(new URLSearchParams(body));
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => app!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(app.address() as AddressInfo).port}/logout`, bodies };
}

function config(backchannelLogoutUri: string): BridgeConfig {
  return {
    issuer: 'https://id.example.org',
    port: 0,
    trustedProxies: [],
    signingKeyPem,
    cookieSecret: 'c'.repeat(32),
    accessTokenTtl: 600,
    store: { url: 'redis://unused', keyPrefix: 'test:' },
    healthz: { username: 'probe', password: 'probe-password-123' },
    upstream: { issuer: 'https://sso.example.org', clientId: 'b', clientSecret: 's', scopes: ['openid'], groupsClaim: 'groups' },
    clients: [
      {
        id: 'immich',
        secret: 'immich-secret',
        tokenEndpointAuthMethod: 'client_secret_post',
        redirectUris: ['https://photos.example.org/auth/login'],
        selectableRedirectUris: [],
        backchannelLogoutUri,
        targets: [],
      },
    ],
  };
}

function verifiedPayload(jwt: string) {
  const [header, payload, signature] = jwt.split('.') as [string, string, string];
  const verifier = createVerify('RSA-SHA256').update(`${header}.${payload}`);
  expect(verifier.verify(createPublicKey(signingKeyPem), Buffer.from(signature, 'base64url'))).toBe(true);
  expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toMatchObject({ alg: 'RS256', typ: 'logout+jwt' });
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

describe('backchannelLogout', () => {
  it('POSTs a signed logout token for 1 sid, as the back-channel logout spec asks', async () => {
    const endpoint = await logoutEndpoint(200);
    const { backchannelLogout } = createProvider(config(endpoint.url), memoryStore());

    await backchannelLogout('immich', 'family-sub', 'sid-1');

    expect(endpoint.bodies).toHaveLength(1);
    const payload = verifiedPayload(endpoint.bodies[0]!.get('logout_token')!);
    expect(payload).toEqual({
      iss: 'https://id.example.org',
      aud: 'immich',
      iat: expect.any(Number),
      exp: expect.any(Number),
      jti: expect.any(String),
      sub: 'family-sub',
      sid: 'sid-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    });
    expect(payload).not.toHaveProperty('nonce');
  });

  it('logs out by sub alone when no sid is given', async () => {
    const endpoint = await logoutEndpoint(204);
    const { backchannelLogout } = createProvider(config(endpoint.url), memoryStore());

    await backchannelLogout('immich', 'family-sub');

    const payload = verifiedPayload(endpoint.bodies[0]!.get('logout_token')!);
    expect(payload.sub).toBe('family-sub');
    expect(payload).not.toHaveProperty('sid');
  });

  it('rejects when the Client app does not accept it', async () => {
    const endpoint = await logoutEndpoint(400);
    const { backchannelLogout } = createProvider(config(endpoint.url), memoryStore());

    await expect(backchannelLogout('immich', 'family-sub', 'sid-1')).rejects.toThrow(/400/);
  });
});
