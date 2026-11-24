import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProbeConfig, probeHost, urlHost } from '../src/config.ts';

describe('urlHost', () => {
  it.each([
    ['10.0.0.5', '10.0.0.5'],
    ['::1', '[::1]'],
    ['2001:DB8:0:0:0:0:0:1', '[2001:db8::1]'],
  ])('writes %s as %s', (address, expected) => {
    expect(urlHost(address)).toBe(expected);
  });
});

describe('probeHost (where the container healthcheck connects)', () => {
  it.each([undefined, '0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0'])('uses the IPv4 loopback for %s (every interface)', (address) => {
    expect(probeHost(address)).toBe('127.0.0.1');
  });

  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['10.0.0.5', '10.0.0.5'],
    ['::1', '[::1]'],
    ['2001:db8::1', '[2001:db8::1]'],
  ])('uses the listen address %s as %s', (address, expected) => {
    expect(probeHost(address)).toBe(expected);
  });

  it('makes a URL that parses back to the address', () => {
    expect(new URL(`http://${probeHost('::1')}:8080/healthz`).port).toBe('8080');
  });
});

describe('loadProbeConfig', () => {
  async function probeConfigFile(extra: string) {
    const dir = await mkdtemp(join(tmpdir(), 'oidc-impersonation-probe-'));
    await writeFile(join(dir, 'healthz-password'), 'healthz-password-0123\n');
    const path = join(dir, 'config.yaml');
    await writeFile(path, `healthz:\n  username: probe\n  password_file: ${join(dir, 'healthz-password')}\n${extra}`);
    return path;
  }

  it('carries listen_address', async () => {
    const config = await loadProbeConfig(await probeConfigFile('port: 9000\nlisten_address: "::1"\n'));
    expect(config).toEqual({
      port: 9000,
      listenAddress: '::1',
      tls: false,
      healthz: { username: 'probe', password: 'healthz-password-0123' },
    });
  });

  it('leaves it out when the config does', async () => {
    const config = await loadProbeConfig(await probeConfigFile(''));
    expect(config).not.toHaveProperty('listenAddress');
    expect(config.port).toBe(8080);
  });

  it('rejects what the server rejects', async () => {
    await expect(loadProbeConfig(await probeConfigFile('listen_address: localhost\n'))).rejects.toThrow(
      /listen_address: must be an IP address/,
    );
  });
});
