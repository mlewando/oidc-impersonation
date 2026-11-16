import { createPrivateKey } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { parse } from 'yaml';
import { z } from 'zod';
import { personalClaims as identityClaims, type IdentityClaims } from './claims.ts';
import { errorMessage } from './errors.ts';

export interface ClientConfig {
  id: string;
  secret: string;
  tokenEndpointAuthMethod: 'client_secret_basic' | 'client_secret_post';
  redirectUris: string[];
  selectableRedirectUris: string[];
  backchannelLogoutUri?: string;
  targets: TargetConfig[];
}

/** An account of 1 Client app that real people may impersonate. */
export interface TargetConfig {
  id: string;
  /** Shown on the Account selection page. */
  label: string;
  /** Members of any of these upstream groups may impersonate it. */
  allowedGroups: string[];
  /** Seconds an Impersonation session lasts (enforced only with back-channel logout). */
  sessionTtl: number;
  /** Exactly what the Client app receives. */
  claims: IdentityClaims;
}

export interface BridgeConfig {
  issuer: string;
  port: number;
  tls?: { certFile: string; keyFile: string; cert: string; key: string };
  trustedProxies: string[];
  signingKeyPem: string;
  cookieSecret: string;
  /** Seconds an access token issued to a Client app stays valid (it is only good for userinfo). */
  accessTokenTtl: number;
  store: StoreConfig;
  healthz: HealthzConfig;
  upstream: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes: string[];
    groupsClaim: string;
  };
  clients: ClientConfig[];
}

/** The Valkey (or Redis) the Bridge keeps its state in (ADR 0005). */
export interface StoreConfig {
  /** `redis://` or `rediss://` (TLS) URL, without credentials. */
  url: string;
  username?: string;
  password?: string;
  /** Prepended to every key, so 1 Valkey can be shared safely. */
  keyPrefix: string;
}

/** Basic-auth credentials `/healthz` requires. */
export interface HealthzConfig {
  username: string;
  password: string;
}

/** The part of the config the container healthcheck needs. */
export interface ProbeConfig {
  port: number;
  tls: boolean;
  healthz: HealthzConfig;
}

export type ReadFile = (path: string) => Promise<string>;

export type ConfigResult = { ok: true; config: BridgeConfig } | { ok: false; errors: string[] };

/** A `*_file` key: validated as a path, replaced by the file's content. */
function secretFile(readFile: ReadFile, opts: { trim: boolean }) {
  return z.string().transform(async (path, ctx) => {
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
}

const port = z.number().int().min(1).max(65535).default(8080);

function healthzSchema(readFile: ReadFile) {
  return z
    .strictObject({
      username: z.string().min(1).refine((u) => !u.includes(':'), 'must not contain ":"'),
      password_file: secretFile(readFile, { trim: true }).refine(
        (p) => p.length >= 16,
        'must contain a password of 16 characters or more',
      ),
    })
    .transform((h): HealthzConfig => ({ username: h.username, password: h.password_file }));
}

function buildSchema(readFile: ReadFile) {
  const secret = (opts: { trim: boolean }) => secretFile(readFile, opts);

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
      secret_file: secret({ trim: true }),
      token_endpoint_auth_method: z.enum(['client_secret_basic', 'client_secret_post']).default('client_secret_basic'),
      redirect_uris: z.array(redirectUri).min(1),
      selectable_redirect_uris: z.array(z.string()).default([]),
      backchannel_logout_uri: z.string().refine(isHttpUrl, 'must be an http(s) URL').optional(),
      targets: z.array(target).default([]),
    })
    .superRefine((c, ctx) => {
      c.selectable_redirect_uris.forEach((uri, i) => {
        if (!c.redirect_uris.includes(uri)) {
          ctx.addIssue({ code: 'custom', path: ['selectable_redirect_uris', i], message: `${uri} is not in redirect_uris` });
        }
      });
      duplicates(c.targets, (t) => t.id, ctx, (i) => ['targets', i, 'id'], 'target id');
      duplicates(c.targets, (t) => t.claims.sub, ctx, (i) => ['targets', i, 'claims', 'sub'], 'target sub');
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
        targets: c.targets,
      }),
    );

  return z
    .strictObject({
      issuer: z.string().refine(isAllowedIssuer, 'must be an https:// URL (http:// only for localhost)'),
      port,
      tls: tls.optional(),
      trusted_proxies: z.array(z.string().refine(isIpOrCidr, 'must be an IP address or CIDR range')).default([]),
      signing_key_file: secret({ trim: false }).refine(isRsaPrivateKey, 'must be a PEM RSA private key'),
      cookie_secret_file: secret({ trim: true }).refine(
        (s) => Buffer.byteLength(s) >= 32,
        'must contain 32 bytes or more of random data',
      ),
      access_token_ttl: duration({ min: 60, max: 24 * 3600 }).default(600),
      store: z.strictObject({
        url: z.string().superRefine((value, ctx) => {
          const url = URL.parse(value);
          if (!url || !['redis:', 'rediss:'].includes(url.protocol)) {
            ctx.addIssue({ code: 'custom', message: 'must be a redis:// or rediss:// (TLS) URL' });
          } else if (url.username || url.password) {
            ctx.addIssue({ code: 'custom', message: 'must not contain credentials; use username and password_file' });
          }
        }),
        username: z.string().min(1).optional(),
        password_file: secret({ trim: true }).optional(),
        key_prefix: z.string().default('oidc-impersonation:'),
      }),
      healthz: healthzSchema(readFile),
      upstream: z.strictObject({
        issuer: z.string(),
        client_id: z.string(),
        client_secret_file: secret({ trim: true }),
        scopes: z
          .array(z.string())
          .default(['openid', 'profile', 'email'])
          .refine((s) => s.includes('openid'), 'must include openid'),
        groups_claim: z.string().default('groups'),
      }),
      clients: z
        .array(client)
        .min(1)
        .superRefine((clients, ctx) => duplicates(clients, (c) => c.id, ctx, (i) => [i, 'id'], 'client id')),
    })
    .transform(
      (raw): BridgeConfig => ({
        issuer: raw.issuer,
        port: raw.port,
        ...(raw.tls && { tls: raw.tls }),
        trustedProxies: raw.trusted_proxies,
        signingKeyPem: raw.signing_key_file,
        cookieSecret: raw.cookie_secret_file,
        accessTokenTtl: raw.access_token_ttl,
        store: {
          url: raw.store.url,
          ...(raw.store.username !== undefined && { username: raw.store.username }),
          ...(raw.store.password_file !== undefined && { password: raw.store.password_file }),
          keyPrefix: raw.store.key_prefix,
        },
        healthz: raw.healthz,
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

/**
 * Reads only what the container healthcheck needs (port, whether TLS is on, `/healthz`
 * credentials), with the same rules as the full config. It reads no other secret file, so a
 * rotating signing key or client secret can't make a running Bridge look unhealthy.
 */
export async function loadProbeConfig(path: string): Promise<ProbeConfig> {
  const readFile: ReadFile = (p) => fsReadFile(p, 'utf8');
  const schema = z.object({ port, tls: z.unknown().optional(), healthz: healthzSchema(readFile) });
  const parsed = await schema.safeParseAsync(parse(await readFile(path)));
  if (!parsed.success) {
    throw new ConfigError(path, parsed.error.issues.map((i) => `${formatPath(i.path)}: ${i.message}`));
  }
  return { port: parsed.data.port, tls: parsed.data.tls !== undefined, healthz: parsed.data.healthz };
}

export class ConfigError extends Error {
  readonly errors: string[];
  constructor(path: string, errors: string[]) {
    super(`Invalid config ${path}:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.errors = errors;
  }
}

/** `90s`, `10m`, `8h` → seconds, within [min, max] seconds. */
function duration(bounds: { min: number; max: number }) {
  return z.string().transform((value, ctx) => {
    const match = /^(\d+)(s|m|h)$/.exec(value);
    const seconds = match ? Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2] as 's' | 'm' | 'h'] : NaN;
    if (!(seconds >= bounds.min && seconds <= bounds.max)) {
      ctx.addIssue({
        code: 'custom',
        message: `must be a duration like 90s, 10m or 8h, between ${bounds.min}s and ${bounds.max}s`,
      });
      return z.NEVER;
    }
    return seconds;
  });
}

/** Reports every item whose `key` an earlier item already has. */
function duplicates<T>(
  items: T[],
  key: (item: T) => string,
  ctx: z.RefinementCtx,
  path: (index: number) => PropertyKey[],
  what: string,
) {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const value = key(item);
    if (seen.has(value)) ctx.addIssue({ code: 'custom', path: path(i), message: `duplicate ${what} "${value}"` });
    seen.add(value);
  });
}

const target = z
  .strictObject({
    id: z.string().min(1),
    label: z.string().min(1),
    allowed_groups: z.array(z.string().min(1)).min(1),
    session_ttl: duration({ min: 5, max: 30 * 24 * 3600 }).default(8 * 3600),
    claims: z.strictObject({
      sub: z.string().min(1),
      email: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      preferred_username: z.string().min(1).optional(),
    }),
  })
  .transform(
    (t): TargetConfig => ({
      id: t.id,
      label: t.label,
      allowedGroups: t.allowed_groups,
      sessionTtl: t.session_ttl,
      claims: identityClaims(t.claims),
    }),
  );

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

function formatPath(path: PropertyKey[]) {
  return (
    path.reduce<string>(
      (out, key) => (typeof key === 'number' ? `${out}[${key}]` : out ? `${out}.${String(key)}` : String(key)),
      '',
    ) || '(root)'
  );
}
