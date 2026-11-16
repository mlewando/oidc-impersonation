import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { jsonLinesAuditSink } from '../src/audit.ts';
import type { BridgeConfig } from '../src/config.ts';
import { startServer, type RunningServer, type ServerDeps } from '../src/server.ts';
import { memoryStore } from '../src/store.ts';
import type { Upstream } from '../src/upstream.ts';

const signingKeyPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

function baseConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    issuer: 'http://localhost:0',
    port: 0,
    trustedProxies: [],
    signingKeyPem,
    cookieSecret: 'c'.repeat(32),
    accessTokenTtl: 600,
    store: { url: 'redis://unused', keyPrefix: 'test:' }, // the tests pass a memory store
    healthz: { username: 'probe', password: 'probe-password-123' },
    upstream: { issuer: 'https://sso.example.org', clientId: 'b', clientSecret: 's', scopes: ['openid'], groupsClaim: 'groups' },
    clients: [
      {
        id: 'app',
        secret: 'app-secret',
        tokenEndpointAuthMethod: 'client_secret_basic',
        redirectUris: ['https://app.example.org/cb'],
        selectableRedirectUris: [],
      },
    ],
    ...overrides,
  };
}

const fakeUpstream: Upstream = {
  startLogin: async () => {
    throw new Error('not used');
  },
  finishLogin: async () => {
    throw new Error('not used');
  },
};

/** Working server deps; each test overrides only what it is about. */
function baseDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    discover: async () => fakeUpstream,
    audit: jsonLinesAuditSink({ write: () => {} }),
    store: memoryStore(),
    log: () => {},
    ...overrides,
  };
}

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

const PROBE_AUTH = basic('probe', 'probe-password-123');

/** `/healthz` with the probe's credentials, other ones, or none (`null`). */
function healthz(server: RunningServer, authorization: string | null = PROBE_AUTH) {
  return fetch(`${server.url}/healthz`, authorization ? { headers: { authorization } } : {});
}

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function until(condition: () => Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('/healthz', () => {
  it('is not ready while upstream discovery fails, and 200 once it succeeds', async () => {
    let attempts = 0;
    let upstreamUp = false;
    const server = (running = await startServer(
      baseConfig(),
      baseDeps({
        discover: async () => {
          attempts++;
          if (!upstreamUp) throw new Error('ECONNREFUSED');
          return fakeUpstream;
        },
        discoveryRetryMs: 10,
      }),
    ));

    await until(async () => attempts >= 2);
    expect((await healthz(server)).status).toBe(503);
    // Nothing else is served before the Bridge is ready.
    expect((await fetch(`${server.url}/.well-known/openid-configuration`)).status).toBe(503);

    upstreamUp = true;
    await until(async () => (await healthz(server)).status === 200);
    expect((await fetch(`${server.url}/.well-known/openid-configuration`)).status).toBe(200);
  });

  it('is 503 while the store is unreachable', async () => {
    let storeUp = true;
    const store = memoryStore();
    const server = (running = await startServer(
      baseConfig(),
      baseDeps({ store: { ...store, ready: async () => (storeUp ? undefined : Promise.reject(new Error('down'))) } }),
    ));
    await until(async () => (await healthz(server)).status === 200);

    storeUp = false;
    expect((await healthz(server)).status).toBe(503);
  });

  it.each([
    ['no credentials', null],
    ['a wrong password', basic('probe', 'wrong')],
    ['a wrong username', basic('someone', 'probe-password-123')],
    ['another scheme', 'Bearer probe-password-123'],
  ])('answers 401 to %s, without revealing readiness', async (_label, authorization) => {
    const server = (running = await startServer(baseConfig(), baseDeps()));
    await until(async () => (await healthz(server)).ok);

    const res = await healthz(server, authorization);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="healthz", charset="UTF-8"');
    expect(await res.text()).not.toMatch(/ok|ready/i);
  });
});

describe('without tls', () => {
  it('serves plain HTTP and warns at startup', async () => {
    const logs: string[] = [];
    running = await startServer(baseConfig(), baseDeps({ log: (line) => logs.push(line) }));

    expect(running.url).toMatch(/^http:\/\//);
    expect(logs.join('\n')).toMatch(/WARNING: .*plain HTTP/);
  });
});

describe('with tls', () => {
  function selfSigned(dir: string, name: string) {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', `/CN=${name}`,
      '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.crt`),
    ], { stdio: 'ignore' });
  }

  function servedCertificateCn(port: number) {
    return new Promise<string>((resolve, reject) => {
      const socket = connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
        const cert = socket.getPeerX509Certificate();
        socket.end();
        resolve(cert?.subject ?? '');
      });
      socket.on('error', reject);
    });
  }

  it('picks up replaced certificate files without a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oidc-impersonation-tls-'));
    selfSigned(dir, 'first');
    selfSigned(dir, 'second');
    const certFile = join(dir, 'tls.crt');
    const keyFile = join(dir, 'tls.key');
    await writeFile(certFile, await readFile(join(dir, 'first.crt')));
    await writeFile(keyFile, await readFile(join(dir, 'first.key')));

    const logs: string[] = [];
    running = await startServer(
      baseConfig({
        issuer: 'https://localhost:0',
        tls: { certFile, keyFile, cert: await readFile(certFile, 'utf8'), key: await readFile(keyFile, 'utf8') },
      }),
      baseDeps({ log: (l) => logs.push(l), tlsPollMs: 20 }),
    );
    expect(running.url).toMatch(/^https:\/\//);
    expect(await servedCertificateCn(running.port)).toBe('CN=first');
    expect(logs.join('\n')).not.toMatch(/plain HTTP/);

    // Renewal tools usually write a new file and rename it into place.
    await writeFile(`${keyFile}.new`, await readFile(join(dir, 'second.key')));
    await writeFile(`${certFile}.new`, await readFile(join(dir, 'second.crt')));
    await rename(`${keyFile}.new`, keyFile);
    await rename(`${certFile}.new`, certFile);

    await until(async () => (await servedCertificateCn(running!.port)) === 'CN=second');
  });

  it('keeps serving the old certificate when the new files are broken', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oidc-impersonation-tls-'));
    selfSigned(dir, 'good');
    const certFile = join(dir, 'good.crt');
    const keyFile = join(dir, 'good.key');
    const logs: string[] = [];
    running = await startServer(
      baseConfig({
        issuer: 'https://localhost:0',
        tls: { certFile, keyFile, cert: await readFile(certFile, 'utf8'), key: await readFile(keyFile, 'utf8') },
      }),
      baseDeps({ log: (l) => logs.push(l), tlsPollMs: 20 }),
    );

    await writeFile(certFile, 'not a certificate');
    await until(async () => logs.some((l) => /TLS reload failed/.test(l)));
    expect(await servedCertificateCn(running.port)).toBe('CN=good');
  });
});
