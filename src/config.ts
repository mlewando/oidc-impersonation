import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

// Minimal loader for the walking skeleton. Full validation (unknown keys, duplicates, error
// aggregation, …) is issue 02.

export interface ClientConfig {
  id: string;
  secret: string;
  tokenEndpointAuthMethod: 'client_secret_basic' | 'client_secret_post';
  redirectUris: string[];
}

export interface BridgeConfig {
  issuer: string;
  port: number;
  tls?: { cert: string; key: string };
  signingKeyPem: string;
  cookieSecret: string;
  upstream: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes: string[];
  };
  clients: ClientConfig[];
}

export async function loadConfig(path: string): Promise<BridgeConfig> {
  const raw = parse(await readFile(path, 'utf8'));
  const secret = async (file: string) => (await readFile(file, 'utf8')).trim();

  return {
    issuer: raw.issuer,
    port: raw.port ?? 8080,
    ...(raw.tls && {
      tls: {
        cert: await readFile(raw.tls.cert_file, 'utf8'),
        key: await readFile(raw.tls.key_file, 'utf8'),
      },
    }),
    signingKeyPem: await readFile(raw.signing_key_file, 'utf8'),
    cookieSecret: await secret(raw.cookie_secret_file),
    upstream: {
      issuer: raw.upstream.issuer,
      clientId: raw.upstream.client_id,
      clientSecret: await secret(raw.upstream.client_secret_file),
      scopes: raw.upstream.scopes ?? ['openid', 'profile', 'email'],
    },
    clients: await Promise.all(
      (raw.clients as any[]).map(async (c) => ({
        id: c.id,
        secret: await secret(c.secret_file),
        tokenEndpointAuthMethod: c.token_endpoint_auth_method ?? 'client_secret_basic',
        redirectUris: c.redirect_uris,
      })),
    ),
  };
}
