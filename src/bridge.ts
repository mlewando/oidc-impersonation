import { createHash, createPrivateKey } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Router from '@koa/router';
import Koa from 'koa';
import Provider, { interactionPolicy, type ClientMetadata, type ErrorOut, type KoaContextWithOIDC } from 'oidc-provider';
import { clientIp, type AuditSink } from './audit.ts';
import { personalClaims, type IdentityClaims } from './claims.ts';
import type { BridgeConfig } from './config.ts';
import type { PendingUpstreamLogin, Upstream } from './upstream.ts';

export interface BridgeDeps {
  upstream: Upstream;
  audit: AuditSink;
}

/** A sign-in that went upstream and hasn't come back yet. In memory only (README: 1 instance). */
interface PendingSignIn {
  interactionUid: string;
  upstream: PendingUpstreamLogin;
  expiresAt: number;
  /** Set once the Upstream provider answered. */
  realPerson?: { sub: string; username?: string };
  claims?: IdentityClaims;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

/** Builds the Bridge as a Node request handler: OIDC provider routes plus the Bridge's own routes. */
export function createBridge(config: BridgeConfig, deps: BridgeDeps) {
  const accounts = new Map<string, IdentityClaims>();
  const pendingByState = new Map<string, PendingSignIn>();
  const pendingByUid = new Map<string, PendingSignIn>();

  const provider = new Provider(config.issuer, {
    clients: config.clients.map(
      (c): ClientMetadata => ({
        client_id: c.id,
        client_secret: c.secret,
        // oidc-provider only accepts custom-scheme redirect URIs (phone apps, such as
        // `app.immich:///oauth-callback`) from `native` clients. Native clients still accept
        // non-loopback https URIs, so 1 client can serve the web app and the phone app.
        application_type: c.redirectUris.some((uri) => !/^https?:/.test(uri)) ? 'native' : 'web',
        redirect_uris: c.redirectUris,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: c.tokenEndpointAuthMethod,
        id_token_signed_response_alg: 'RS256',
      }),
    ),
    jwks: { keys: [signingJwk(config.signingKeyPem)] },
    enabledJWA: { idTokenSigningAlgValues: ['RS256'] },
    cookies: { keys: [config.cookieSecret] },
    // No `offline_access`: the Bridge never issues refresh tokens (README).
    scopes: ['openid', 'email', 'profile'],
    claims: {
      openid: ['sub'],
      email: ['email'],
      profile: ['name', 'preferred_username'],
    },
    // The ID token carries the identity claims too, not only userinfo (README).
    conformIdTokenClaims: false,
    pkce: { required: () => true },
    // Authorization Code only; no implicit or hybrid response types.
    responseTypes: ['code'],
    // Everything the README's security model doesn't need is off. Introspection, revocation,
    // registration, device flow, CIBA and client credentials are already off by default.
    features: {
      devInteractions: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      pushedAuthorizationRequests: { enabled: false },
      resourceIndicators: { enabled: false },
      dPoP: { enabled: false },
      userinfo: { enabled: true },
    },
    ttl: {
      AuthorizationCode: 60, // short-lived and single-use
      AccessToken: 600, // only used for userinfo right after sign-in
      IdToken: 3600,
      Interaction: PENDING_TTL_MS / 1000,
      Grant: PENDING_TTL_MS / 1000,
      Session: PENDING_TTL_MS / 1000,
    },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
      policy: noBridgeSessionPolicy(),
    },
    renderError,
    async findAccount(_ctx, id) {
      const claims = accounts.get(id);
      if (!claims) return undefined;
      return { accountId: id, claims: () => ({ ...claims }) };
    },
  });

  const requestIp = (req: IncomingMessage) => {
    const forwarded = req.headers['x-forwarded-for'];
    return clientIp(
      req.socket.remoteAddress ?? '',
      Array.isArray(forwarded) ? forwarded.join(',') : forwarded,
      config.trustedProxies,
    );
  };

  // A reused authorization code: oidc-provider rejects it and revokes what it issued; we audit it.
  provider.on('grant.error', (ctx, error) => {
    if ((error as { error_detail?: string }).error_detail !== 'authorization code already consumed') return;
    deps.audit.write({
      event: 'sign-in',
      client: ctx.oidc.client?.clientId ?? 'unknown',
      result: 'replay',
      ip: requestIp(ctx.req),
    });
  });

  const router = new Router();

  // oidc-provider sends the browser here whenever a sign-in needs the Bridge's login step.
  router.get('/interaction/:uid', async (ctx) => {
    const details = await provider.interactionDetails(ctx.req, ctx.res);
    const { url, pending } = await deps.upstream.startLogin();
    const signIn: PendingSignIn = {
      interactionUid: details.uid,
      upstream: pending,
      expiresAt: Date.now() + PENDING_TTL_MS,
    };
    dropExpired(pendingByState);
    dropExpired(pendingByUid);
    pendingByState.set(pending.state, signIn);
    ctx.redirect(url.href);
  });

  // The Upstream provider's redirect URI (README: `<issuer>/callback`).
  router.get('/callback', async (ctx) => {
    const state = typeof ctx.query.state === 'string' ? ctx.query.state : undefined;
    const signIn = state ? pendingByState.get(state) : undefined;
    if (state) pendingByState.delete(state);
    if (!signIn || signIn.expiresAt < Date.now()) {
      ctx.status = 400;
      ctx.body = 'Sign-in expired or unknown. Start again from the app.';
      return;
    }

    // Built from the configured issuer, never from request headers.
    const callbackUrl = new URL(`/callback?${ctx.querystring}`, config.issuer);
    try {
      const upstreamClaims = await deps.upstream.finishLogin(callbackUrl, signIn.upstream);
      const username = upstreamClaims.preferred_username;
      signIn.realPerson = { sub: upstreamClaims.sub, ...(typeof username === 'string' && { username }) };
      signIn.claims = personalClaims(upstreamClaims);
    } catch (error) {
      console.error('upstream sign-in failed:', error instanceof Error ? error.message : error);
      ctx.status = 400;
      ctx.body = 'Sign-in with the upstream provider failed. Start again from the app.';
      return;
    }
    pendingByUid.set(signIn.interactionUid, signIn);

    // The interaction cookie is scoped to /interaction/<uid>, so finish there: that proves the
    // browser that came back is the one that started the sign-in.
    ctx.redirect(`/interaction/${signIn.interactionUid}/finish`);
  });

  router.get('/interaction/:uid/finish', async (ctx) => {
    const details = await provider.interactionDetails(ctx.req, ctx.res);
    const signIn = pendingByUid.get(details.uid);
    pendingByUid.delete(details.uid);
    if (!signIn?.claims || !signIn.realPerson || signIn.expiresAt < Date.now()) {
      ctx.status = 400;
      ctx.body = 'Sign-in expired or unknown. Start again from the app.';
      return;
    }

    const clientId = String(details.params.client_id);
    const accountId = signIn.claims.sub;
    accounts.set(accountId, signIn.claims);

    deps.audit.write({
      event: 'sign-in',
      client: clientId,
      ...(signIn.realPerson.username !== undefined && { realUser: signIn.realPerson.username }),
      realSub: signIn.realPerson.sub,
      identity: 'personal',
      result: 'ok',
      ip: requestIp(ctx.req),
    });

    const grant = new provider.Grant({ accountId, clientId });
    grant.addOIDCScope(String(details.params.scope));
    const grantId = await grant.save();

    const redirectTo = await provider.interactionResult(
      ctx.req,
      ctx.res,
      { login: { accountId }, consent: { grantId } },
      { mergeWithLastSubmission: false },
    );
    ctx.redirect(redirectTo);
  });

  const bridgeApp = new Koa();
  bridgeApp.use(router.routes());
  const bridgeHandler = bridgeApp.callback();
  const providerHandler = provider.callback();

  return (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://bridge').pathname;
    if (path === '/callback' || path.startsWith('/interaction/')) {
      return bridgeHandler(req, res);
    }
    return providerHandler(req, res);
  };
}

/**
 * ADR 0002: the Bridge keeps no login session. oidc-provider's default policy skips the login step
 * when its own session cookie says someone is signed in; this extra check asks for the login step
 * on every authorization request, except when resuming from the login step that just ran. So
 * every sign-in goes upstream, and `prompt=none` fails with `login_required`.
 */
function noBridgeSessionPolicy() {
  const policy = interactionPolicy.base();
  policy
    .get('login')!
    .checks.add(
      new interactionPolicy.Check('bridge_no_session', 'The Bridge signs in upstream on every request', 'login_required', (ctx) =>
        ctx.oidc.result?.login ? interactionPolicy.Check.NO_NEED_TO_PROMPT : interactionPolicy.Check.REQUEST_PROMPT,
      ),
    );
  return policy;
}

/** Minimal error page: the OAuth error code and description, HTML-escaped, nothing else. */
function renderError(ctx: KoaContextWithOIDC, out: ErrorOut) {
  const escape = (s: unknown) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  ctx.type = 'html';
  ctx.body = `<!doctype html><meta charset="utf-8"><title>Sign-in error</title>
<h1>Sign-in error</h1><p><strong>${escape(out.error)}</strong>: ${escape(out.error_description)}</p>
<p>Start again from the app.</p>`;
}

function dropExpired(pending: Map<string, PendingSignIn>) {
  const now = Date.now();
  for (const [key, signIn] of pending) {
    if (signIn.expiresAt < now) pending.delete(key);
  }
}

function signingJwk(pem: string) {
  const jwk = createPrivateKey(pem).export({ format: 'jwk' });
  const thumbprint = createHash('sha256')
    .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
    .digest('base64url');
  return { ...jwk, kid: thumbprint, alg: 'RS256', use: 'sig' };
}
