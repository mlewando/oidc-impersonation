import { createPrivateKey } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { parse } from 'yaml';
import { z } from 'zod';

export interface ClientConfig {
  id: string;
  secret: string;
  tokenEndpointAuthMethod: 'client_secret_basic' | 'client_secret_post';
  redirectUris: string[];
  selectableRedirectUris: string[];
  backchannelLogoutUri?: string;
}

export interface BridgeConfig {
  issuer: string;
  port: number;
  tls?: { certFile: string; keyFile: string; cert: string; key: string };
  trustedProxies: string[];
  signingKeyPem: string;
  cookieSecret: string;
  upstream: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes: string[];
    groupsClaim: string;
  };
  clients: ClientConfig[];
}

export type ReadFile = (path: string) => Promise<string>;

export type ConfigResult = { ok: true; config: BridgeConfig } | { ok: false; errors: string[] };

function buildSchema(readFile: ReadFile) {
  /** A `*_file` key: validated as a path, replaced by the file's content. */
  const secretFile = (opts: { trim: boolean }) =>
    z.string().transform(async (path, ctx) => {
      try {
        const content = opts.trim ? (await readFile(path)).trim() : await readFile(path);
        if (!content.trim()) {
          ctx.addIssue({ code: 'custom', message: `${path} is empty` });
          return z.NEVER;
        }
        return content;
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: `cannot read ${path} (${errorMessage(error)})` });
        return z.NEVER;
      }
    });

  const tls = z
    .strictObject({ cert_file: z.string(), key_file: z.string() })
    .transform(async (t, ctx) => {
      const read = async (key: 'cert_file' | 'key_file') => {
        try {
          return await readFile(t[key]);
        } catch (error) {
          ctx.addIssue({ code: 'custom', path: [key], message: `cannot read ${t[key]} (${errorMessage(error)})` });
          return '';
        }
      };
      return { certFile: t.cert_file, keyFile: t.key_file, cert: await read('cert_file'), key: await read('key_file') };
    });

  const client = z
    .strictObject({
      id: z.string().min(1),
      secret_file: secretFile({ trim: true }),
      token_endpoint_auth_method: z.enum(['client_secret_basic', 'client_secret_post']).default('client_secret_basic'),
      redirect_uris: z.array(redirectUri).min(1),
      selectable_redirect_uris: z.array(z.string()).default([]),
      backchannel_logout_uri: z.string().refine(isHttpUrl, 'must be an http(s) URL').optional(),
    })
    .superRefine((c, ctx) => {
      c.selectable_redirect_uris.forEach((uri, i) => {
        if (!c.redirect_uris.includes(uri)) {
          ctx.addIssue({ code: 'custom', path: ['selectable_redirect_uris', i], message: `${uri} is not in redirect_uris` });
        }
      });
      // oidc-provider only accepts custom schemes on `native` clients, which refuse non-loopback http.
      const custom = c.redirect_uris.some((uri) => !/^https?:/.test(uri));
      const plainHttp = c.redirect_uris.some((uri) => isNonLoopbackHttp(uri));
      if (custom && plainHttp) {
        ctx.addIssue({
          code: 'custom',
          path: ['redirect_uris'],
          message: 'a custom-scheme redirect URI cannot be combined with a non-loopback http:// one; use https://',
        });
      }
    })
    .transform(
      (c): ClientConfig => ({
        id: c.id,
        secret: c.secret_file,
        tokenEndpointAuthMethod: c.token_endpoint_auth_method,
        redirectUris: c.redirect_uris,
        selectableRedirectUris: c.selectable_redirect_uris,
        ...(c.backchannel_logout_uri !== undefined && { backchannelLogoutUri: c.backchannel_logout_uri }),
      }),
    );

  return z
    .strictObject({
      issuer: z.string().refine(isAllowedIssuer, 'must be an https:// URL (http:// only for localhost)'),
      port: z.number().int().min(1).max(65535).default(8080),
      tls: tls.optional(),
      trusted_proxies: z.array(z.string().refine(isIpOrCidr, 'must be an IP address or CIDR range')).default([]),
      signing_key_file: secretFile({ trim: false }).refine(isRsaPrivateKey, 'must be a PEM RSA private key'),
      cookie_secret_file: secretFile({ trim: true }).refine(
        (s) => Buffer.byteLength(s) >= 32,
        'must contain 32 bytes or more of random data',
      ),
      upstream: z.strictObject({
        issuer: z.string(),
        client_id: z.string(),
        client_secret_file: secretFile({ trim: true }),
        scopes: z
          .array(z.string())
          .default(['openid', 'profile', 'email'])
          .refine((s) => s.includes('openid'), 'must include openid'),
        groups_claim: z.string().default('groups'),
      }),
      clients: z
        .array(client)
        .min(1)
        .superRefine((clients, ctx) => {
          const seen = new Set<string>();
          clients.forEach((c, i) => {
            if (seen.has(c.id)) {
              ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `duplicate client id "${c.id}"` });
            }
            seen.add(c.id);
          });
        }),
    })
    .transform(
      (raw): BridgeConfig => ({
        issuer: raw.issuer,
        port: raw.port,
        ...(raw.tls && { tls: raw.tls }),
        trustedProxies: raw.trusted_proxies,
        signingKeyPem: raw.signing_key_file,
        cookieSecret: raw.cookie_secret_file,
        upstream: {
          issuer: raw.upstream.issuer,
          clientId: raw.upstream.client_id,
          clientSecret: raw.upstream.client_secret_file,
          scopes: raw.upstream.scopes,
          groupsClaim: raw.upstream.groups_claim,
        },
        clients: raw.clients,
      }),
    );
}

/**
 * Validates the whole config file and reads every secret file it names. Returns every problem
 * found, not just the 1st, so an operator can fix them all at once.
 */
export async function parseConfig(yamlText: string, readFile: ReadFile): Promise<ConfigResult> {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch (error) {
    return { ok: false, errors: [`(root): not valid YAML (${errorMessage(error)})`] };
  }
  const parsed = await buildSchema(readFile).safeParseAsync(doc);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${formatPath(i.path)}: ${i.message}`) };
  }
  return { ok: true, config: parsed.data };
}

/** Reads and validates the config file; throws a `ConfigError` listing every problem. */
export async function loadConfig(path: string): Promise<BridgeConfig> {
  const text = await fsReadFile(path, 'utf8');
  const result = await parseConfig(text, (p) => fsReadFile(p, 'utf8'));
  if (!result.ok) throw new ConfigError(path, result.errors);
  return result.config;
}

export class ConfigError extends Error {
  readonly errors: string[];
  constructor(path: string, errors: string[]) {
    super(`Invalid config ${path}:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.errors = errors;
  }
}

const redirectUri = z.string().superRefine((value, ctx) => {
  const url = URL.parse(value);
  if (!url) ctx.addIssue({ code: 'custom', message: 'must be a valid URI' });
  else if (value.includes('#')) ctx.addIssue({ code: 'custom', message: 'must not contain a fragment' });
});

function isAllowedIssuer(value: string) {
  const url = URL.parse(value);
  if (!url || value.includes('#')) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost');
}

function isHttpUrl(value: string) {
  const url = URL.parse(value);
  return url !== null && (url.protocol === 'https:' || url.protocol === 'http:');
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function isNonLoopbackHttp(value: string) {
  const url = URL.parse(value);
  return url?.protocol === 'http:' && !LOOPBACK.has(url.hostname);
}

function isIpOrCidr(value: string) {
  const [address, prefix, ...rest] = value.split('/');
  const version = isIP(address ?? '');
  if (!version || rest.length) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  return /^\d+$/.test(prefix) && bits <= (version === 4 ? 32 : 128);
}

function isRsaPrivateKey(pem: string) {
  try {
    return createPrivateKey(pem).asymmetricKeyType === 'rsa';
  } catch {
    return false;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatPath(path: PropertyKey[]) {
  return (
    path.reduce<string>(
      (out, key) => (typeof key === 'number' ? `${out}[${key}]` : out ? `${out}.${String(key)}` : String(key)),
      '',
    ) || '(root)'
  );
}
