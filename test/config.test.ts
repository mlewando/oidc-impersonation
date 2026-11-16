import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.ts';

const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

/** Secret files the config below refers to. */
const files: Record<string, string> = {
  '/s/signing-key.pem': signingKey,
  '/s/cookie-secret': 'c'.repeat(32) + '\n',
  '/s/upstream-secret': 'upstream-secret\n',
  '/s/app-secret': 'app-secret\n',
  '/s/tls.crt': 'CERT',
  '/s/tls.key': 'KEY',
  '/s/valkey-password': 'valkey-password\n',
  '/s/healthz-password': 'healthz-password-0123\n',
  '/s/short-password': 'too-short\n',
};

const readFile = async (path: string) => {
  const content = files[path];
  if (content === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
  return content;
};

const validYaml = `
issuer: https://id.example.org
port: 8443
tls:
  cert_file: /s/tls.crt
  key_file: /s/tls.key
trusted_proxies: [10.0.0.1, 192.168.0.0/16, "::1"]
signing_key_file: /s/signing-key.pem
cookie_secret_file: /s/cookie-secret
access_token_ttl: 5m
store:
  url: rediss://valkey.example.org:6379/2
  username: bridge
  password_file: /s/valkey-password
  key_prefix: "bridge:"
healthz:
  username: probe
  password_file: /s/healthz-password
upstream:
  issuer: https://sso.example.org
  client_id: oidc-impersonation
  client_secret_file: /s/upstream-secret
  scopes: [openid, profile, email, groups]
  groups_claim: groups
clients:
  - id: my-app
    secret_file: /s/app-secret
    token_endpoint_auth_method: client_secret_post
    redirect_uris:
      - https://app.example.org/oauth/callback
      - myapp://oauth-callback
    selectable_redirect_uris:
      - https://app.example.org/oauth/callback
    backchannel_logout_uri: https://app.example.org/oauth/backchannel-logout
`;

/** The valid config with `edit` applied to its parsed YAML, re-serialised. */
async function parseWith(edit: (raw: any) => void) {
  const { parse, stringify } = await import('yaml');
  const raw = parse(validYaml);
  edit(raw);
  return parseConfig(stringify(raw), readFile);
}

async function errorsOf(edit: (raw: any) => void) {
  const result = await parseWith(edit);
  if (result.ok) throw new Error('expected the config to be rejected');
  return result.errors;
}

describe('parseConfig', () => {
  it('turns a valid file into a typed config with secrets read from their files', async () => {
    const result = await parseConfig(validYaml, readFile);

    expect(result).toEqual({
      ok: true,
      config: {
        issuer: 'https://id.example.org',
        port: 8443,
        tls: { certFile: '/s/tls.crt', keyFile: '/s/tls.key', cert: 'CERT', key: 'KEY' },
        trustedProxies: ['10.0.0.1', '192.168.0.0/16', '::1'],
        signingKeyPem: signingKey,
        cookieSecret: 'c'.repeat(32),
        accessTokenTtl: 300,
        store: {
          url: 'rediss://valkey.example.org:6379/2',
          username: 'bridge',
          password: 'valkey-password',
          keyPrefix: 'bridge:',
        },
        healthz: { username: 'probe', password: 'healthz-password-0123' },
        upstream: {
          issuer: 'https://sso.example.org',
          clientId: 'oidc-impersonation',
          clientSecret: 'upstream-secret',
          scopes: ['openid', 'profile', 'email', 'groups'],
          groupsClaim: 'groups',
        },
        clients: [
          {
            id: 'my-app',
            secret: 'app-secret',
            tokenEndpointAuthMethod: 'client_secret_post',
            redirectUris: ['https://app.example.org/oauth/callback', 'myapp://oauth-callback'],
            selectableRedirectUris: ['https://app.example.org/oauth/callback'],
            backchannelLogoutUri: 'https://app.example.org/oauth/backchannel-logout',
          },
        ],
      },
    });
  });

  it('fills in defaults for optional keys', async () => {
    const result = await parseWith((raw) => {
      delete raw.port;
      delete raw.tls;
      delete raw.trusted_proxies;
      delete raw.access_token_ttl;
      delete raw.store.username;
      delete raw.store.password_file;
      delete raw.store.key_prefix;
      delete raw.upstream.scopes;
      delete raw.upstream.groups_claim;
      delete raw.clients[0].token_endpoint_auth_method;
      delete raw.clients[0].selectable_redirect_uris;
      delete raw.clients[0].backchannel_logout_uri;
    });

    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.config).toMatchObject({ port: 8080, trustedProxies: [], accessTokenTtl: 600 });
    expect(result.config.store).toEqual({ url: 'rediss://valkey.example.org:6379/2', keyPrefix: 'oidc-impersonation:' });
    expect(result.config.tls).toBeUndefined();
    expect(result.config.upstream).toMatchObject({ scopes: ['openid', 'profile', 'email'], groupsClaim: 'groups' });
    expect(result.config.clients[0]).toMatchObject({
      tokenEndpointAuthMethod: 'client_secret_basic',
      selectableRedirectUris: [],
    });
    expect(result.config.clients[0]).not.toHaveProperty('backchannelLogoutUri');
  });

  it('reports an unknown key with its path', async () => {
    expect(await errorsOf((raw) => (raw.clients[0].redirect_uri = 'typo'))).toEqual([
      expect.stringMatching(/^clients\[0\]: .*redirect_uri/),
    ]);
  });

  it('reports a missing required key with its path', async () => {
    expect(await errorsOf((raw) => delete raw.upstream.client_id)).toEqual([
      expect.stringMatching(/^upstream\.client_id: /),
    ]);
  });

  it('reports every problem in 1 run, structural and semantic', async () => {
    const errors = await errorsOf((raw) => {
      raw.unknown_key = 1;
      raw.clients[0].token_endpoint_auth_method = 'private_key_jwt';
      raw.issuer = 'http://id.example.org';
      raw.cookie_secret_file = '/s/missing';
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\(root\): .*unknown_key/),
        expect.stringMatching(/^clients\[0\]\.token_endpoint_auth_method: /),
        expect.stringMatching(/^issuer: /),
        expect.stringMatching(/^cookie_secret_file: cannot read \/s\/missing/),
      ]),
    );
    expect(errors).toHaveLength(4);
  });

  it('accepts secrets only from files, never inline', async () => {
    const errors = await errorsOf((raw) => {
      delete raw.upstream.client_secret_file;
      raw.upstream.client_secret = 'inline';
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^upstream: .*client_secret/),
        expect.stringMatching(/^upstream\.client_secret_file: /),
      ]),
    );
  });

  it.each([
    ['90s', 90],
    ['10m', 600],
    ['1h', 3600],
  ])('reads access_token_ttl %s as %i seconds', async (value, seconds) => {
    const result = await parseWith((raw) => (raw.access_token_ttl = value));
    expect(result.ok && result.config.accessTokenTtl).toBe(seconds);
  });

  it.each(['30s', '25h', '10', '10 minutes', '-5m'])('rejects access_token_ttl %s', async (value) => {
    expect(await errorsOf((raw) => (raw.access_token_ttl = value))).toEqual([
      expect.stringMatching(/^access_token_ttl: /),
    ]);
  });

  it('requires healthz credentials', async () => {
    expect(await errorsOf((raw) => delete raw.healthz)).toEqual([expect.stringMatching(/^healthz: /)]);
  });

  it('rejects a healthz password shorter than 16 characters', async () => {
    expect(await errorsOf((raw) => (raw.healthz.password_file = '/s/short-password'))).toEqual([
      expect.stringMatching(/^healthz\.password_file: .*16 characters/),
    ]);
  });

  it('rejects a healthz username containing ":"', async () => {
    expect(await errorsOf((raw) => (raw.healthz.username = 'a:b'))).toEqual([
      expect.stringMatching(/^healthz\.username: /),
    ]);
  });

  it('requires a store', async () => {
    expect(await errorsOf((raw) => delete raw.store)).toEqual([expect.stringMatching(/^store: /)]);
  });

  it.each(['https://valkey.example.org', 'valkey.example.org:6379', 'redis://user:secret@valkey.example.org'])(
    'rejects store url %s',
    async (url) => {
      expect(await errorsOf((raw) => (raw.store.url = url))).toEqual([expect.stringMatching(/^store\.url: /)]);
    },
  );

  it('rejects malformed YAML', async () => {
    const result = await parseConfig('issuer: [unclosed', readFile);
    expect(result).toEqual({ ok: false, errors: [expect.stringMatching(/^\(root\): not valid YAML/)] });
  });

  describe('issuer', () => {
    it.each(['https://id.example.org', 'http://localhost:8080'])('accepts %s', async (issuer) => {
      expect((await parseWith((raw) => (raw.issuer = issuer))).ok).toBe(true);
    });

    it.each(['http://id.example.org', 'http://127.0.0.1:8080', 'not a url', 'https://id.example.org/#x'])(
      'rejects %s',
      async (issuer) => {
        expect(await errorsOf((raw) => (raw.issuer = issuer))).toEqual([expect.stringMatching(/^issuer: /)]);
      },
    );
  });

  it.each([0, 70000, 80.5])('rejects port %s', async (port) => {
    expect(await errorsOf((raw) => (raw.port = port))).toEqual([expect.stringMatching(/^port: /)]);
  });

  it('rejects a cookie secret shorter than 32 bytes', async () => {
    files['/s/short-cookie'] = 'x'.repeat(31);
    expect(await errorsOf((raw) => (raw.cookie_secret_file = '/s/short-cookie'))).toEqual([
      expect.stringMatching(/^cookie_secret_file: .*32 bytes/),
    ]);
  });

  it('rejects a signing key that is not an RSA private key', async () => {
    files['/s/not-a-key'] = 'hello';
    expect(await errorsOf((raw) => (raw.signing_key_file = '/s/not-a-key'))).toEqual([
      expect.stringMatching(/^signing_key_file: .*RSA private key/),
    ]);
  });

  it('rejects an empty secret file', async () => {
    files['/s/empty'] = '\n';
    expect(await errorsOf((raw) => (raw.clients[0].secret_file = '/s/empty'))).toEqual([
      expect.stringMatching(/^clients\[0\]\.secret_file: .*empty/),
    ]);
  });

  it.each(['10.0.0.300', '10.0.0.0/33', 'proxy.local', '::1/129'])('rejects trusted proxy %s', async (entry) => {
    expect(await errorsOf((raw) => (raw.trusted_proxies = [entry]))).toEqual([
      expect.stringMatching(/^trusted_proxies\[0\]: /),
    ]);
  });

  it('requires the openid scope upstream', async () => {
    expect(await errorsOf((raw) => (raw.upstream.scopes = ['profile', 'email']))).toEqual([
      expect.stringMatching(/^upstream\.scopes: .*openid/),
    ]);
  });

  it('requires at least 1 client', async () => {
    expect(await errorsOf((raw) => (raw.clients = []))).toEqual([expect.stringMatching(/^clients: /)]);
  });

  it('rejects duplicate client ids', async () => {
    expect(await errorsOf((raw) => raw.clients.push({ ...raw.clients[0] }))).toEqual([
      expect.stringMatching(/^clients\[1\]\.id: duplicate client id "my-app"/),
    ]);
  });

  it('requires at least 1 redirect URI per client', async () => {
    expect(await errorsOf((raw) => (raw.clients[0].redirect_uris = []))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^clients\[0\]\.redirect_uris: /)]),
    );
  });

  it.each(['not a uri', 'https://app.example.org/cb#frag'])('rejects redirect URI %s', async (uri) => {
    expect(await errorsOf((raw) => raw.clients[0].redirect_uris.push(uri))).toEqual([
      expect.stringMatching(/^clients\[0\]\.redirect_uris\[2\]: /),
    ]);
  });

  it('rejects a selectable redirect URI that is not in redirect_uris', async () => {
    expect(
      await errorsOf((raw) => raw.clients[0].selectable_redirect_uris.push('https://app.example.org/other')),
    ).toEqual([expect.stringMatching(/^clients\[0\]\.selectable_redirect_uris\[1\]: .*not in redirect_uris/)]);
  });

  it('rejects mixing a custom-scheme redirect URI with a non-loopback http:// one', async () => {
    expect(await errorsOf((raw) => raw.clients[0].redirect_uris.push('http://app.example.org/cb'))).toEqual([
      expect.stringMatching(/^clients\[0\]\.redirect_uris: .*custom-scheme/),
    ]);
  });

  it('rejects a back-channel logout URI that is not an http(s) URL', async () => {
    expect(await errorsOf((raw) => (raw.clients[0].backchannel_logout_uri = 'myapp://logout'))).toEqual([
      expect.stringMatching(/^clients\[0\]\.backchannel_logout_uri: /),
    ]);
  });
});
