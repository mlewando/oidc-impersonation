import { execFile } from 'node:child_process';
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
