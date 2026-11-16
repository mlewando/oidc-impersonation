import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { parseConfig } from '../src/config.ts';

const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

/** Stand-ins for every secret file: valid in shape, nothing real. */
const dummySecret = async (path: string) => (path.endsWith('signing-key.pem') ? signingKey : `dummy-secret-for-${path}`);

it('the Immich + Authelia example config passes the config loader', async () => {
  const yaml = await readFile('examples/immich-authelia/config.yaml', 'utf8');

  const result = await parseConfig(yaml, dummySecret);

  if (!result.ok) throw new Error(result.errors.join('\n'));
  expect(result.config.clients.map((c) => c.targets.map((t) => t.id))).toEqual([['family']]);
});
