import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it('refuses to start on an invalid config and logs every error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oidc-impersonation-'));
  const configFile = join(dir, 'config.yaml');
  await writeFile(
    configFile,
    `
issuer: http://id.example.org
signing_key_file: ${join(dir, 'missing-key.pem')}
cookie_secret_file: ${join(dir, 'missing-cookie')}
upstream:
  issuer: https://sso.example.org
  client_id: bridge
  client_secret_file: ${join(dir, 'missing-upstream')}
clients: []
`,
  );

  const result = await run(process.execPath, ['src/main.ts'], {
    env: { ...process.env, CONFIG_FILE: configFile },
  }).catch((error: { code: number; stderr: string }) => error);

  expect('code' in result && result.code).toBe(1);
  const stderr = result.stderr;
  for (const key of ['issuer', 'signing_key_file', 'cookie_secret_file', 'upstream.client_secret_file', 'clients']) {
    expect(stderr).toContain(`  - ${key}: `);
  }
});

it('refuses to start when listen_address is not on this host and logs 1 line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oidc-impersonation-'));
  const configFile = join(dir, 'config.yaml');
  const secrets = {
    'signing-key.pem': generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    'cookie-secret': 'c'.repeat(32),
    'upstream-secret': 'upstream-secret',
    'app-secret': 'app-secret',
    'healthz-password': 'healthz-password-0123',
  };
  for (const [name, content] of Object.entries(secrets)) await writeFile(join(dir, name), content);
  await writeFile(
    configFile,
    `
issuer: https://id.example.org
port: 8443
listen_address: 192.0.2.1
signing_key_file: ${join(dir, 'signing-key.pem')}
cookie_secret_file: ${join(dir, 'cookie-secret')}
store:
  url: redis://127.0.0.1:1
healthz:
  username: probe
  password_file: ${join(dir, 'healthz-password')}
upstream:
  issuer: https://sso.example.org
  client_id: bridge
  client_secret_file: ${join(dir, 'upstream-secret')}
clients:
  - id: app
    secret_file: ${join(dir, 'app-secret')}
    redirect_uris: [https://app.example.org/cb]
`,
  );

  const result = await run(process.execPath, ['src/main.ts'], {
    env: { ...process.env, CONFIG_FILE: configFile },
  }).catch((error: { code: number; stderr: string }) => error);

  expect('code' in result && result.code).toBe(1);
  const lines = result.stderr.trim().split('\n');
  expect(lines.at(-1)).toMatch(/^cannot listen on 192\.0\.2\.1:8443: .*EADDRNOTAVAIL/);
  expect(result.stderr).not.toMatch(/\n\s+at /); // no stack trace
});
