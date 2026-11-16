import { createHash, createPrivateKey } from 'node:crypto';
import Provider, {
  interactionPolicy,
  type ClientMetadata,
  type ErrorOut,
  type KoaContextWithOIDC,
} from 'oidc-provider';
import type { IdentityClaims } from './claims.ts';
import type { BridgeConfig } from './config.ts';
import { storeAdapter } from './oidc-adapter.ts';
import type { Store } from './store.ts';

/** Seconds a sign-in may take: the Bridge's login step, upstream round trip included. */
export const SIGN_IN_TTL = 600;

export interface BridgeProvider {
  provider: Provider;
  /**
   * Ends the Bridge's login step: grants the client the requested scopes for this 1 sign-in and
   * stores exactly which identity it gets. Returns where to send the browser next.
   */
  issueIdentity(
    ctx: Pick<KoaContextWithOIDC, 'req' | 'res'>,
    details: { params: Record<string, unknown> },
    claims: IdentityClaims,
  ): Promise<string>;
}

/**
 * The Bridge's OIDC provider toward Client apps, locked down to the README's security model.
 * Every setting here is part of that model; read it as a checklist.
 *
 * The identity of each sign-in is stored under its grant, for exactly as long as the grant lives
 * (`access_token_ttl`); the code and the access token both carry the grant id, so the ID token and
 * userinfo read back exactly that identity.
 */
export function createProvider(config: BridgeConfig, store: Store): BridgeProvider {
  const identityKey = (grantId: string) => `identity:${grantId}`;

  const provider = new Provider(config.issuer, {
    adapter: storeAdapter(store),
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

    // RS256 ID tokens, signed with the 1 configured key and published through JWKS.
    jwks: { keys: [signingJwk(config.signingKeyPem)] },
    enabledJWA: { idTokenSigningAlgValues: ['RS256'] },
    cookies: { keys: [config.cookieSecret] },

    // Authorization Code + PKCE (S256) only: no implicit or hybrid flows.
    responseTypes: ['code'],
    pkce: { required: () => true },

    // No `offline_access`, so never a refresh token.
    scopes: ['openid', 'email', 'profile'],
    claims: {
      openid: ['sub'],
      email: ['email'],
      profile: ['name', 'preferred_username'],
    },
    // The ID token carries the identity claims too, not only userinfo.
    conformIdTokenClaims: false,

    // Everything the security model doesn't need is off. Introspection, revocation, registration,
    // device flow, CIBA and client credentials are already off by default.
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
      // Access tokens are only good for userinfo right after the sign-in. The grant (and the
      // identity stored under it) lives exactly as long, since userinfo needs both.
      AccessToken: config.accessTokenTtl,
      Grant: config.accessTokenTtl,
      IdToken: 3600,
      Interaction: SIGN_IN_TTL,
      Session: SIGN_IN_TTL,
    },

    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
      policy: noBridgeSessionPolicy(),
    },
    renderError,

    // Without a token (oidc-provider checking its session during an authorization request) only
    // `sub` is needed.
    async findAccount(_ctx, sub, token) {
      if (!token) return { accountId: sub, claims: () => ({ sub }) };
      const claims = await store.get<IdentityClaims>(identityKey(token.grantId ?? ''));
      if (!claims || claims.sub !== sub) return undefined;
      return { accountId: sub, claims: () => ({ ...claims }) };
    },
  });

  return {
    provider,
    async issueIdentity(ctx, details, claims) {
      const grant = new provider.Grant({ accountId: claims.sub, clientId: String(details.params.client_id) });
      grant.addOIDCScope(String(details.params.scope));
      const grantId = await grant.save();

      const [, redirectTo] = await Promise.all([
        store.set(identityKey(grantId), claims, config.accessTokenTtl),
        provider.interactionResult(
          ctx.req,
          ctx.res,
          { login: { accountId: claims.sub }, consent: { grantId } },
          { mergeWithLastSubmission: false },
        ),
      ]);
      return redirectTo;
    },
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
  policy.get('login')!.checks.add(
    new interactionPolicy.Check(
      'bridge_no_session',
      'The Bridge signs in upstream on every request',
      'login_required',
      (ctx) =>
        ctx.oidc.result?.login ? interactionPolicy.Check.NO_NEED_TO_PROMPT : interactionPolicy.Check.REQUEST_PROMPT,
    ),
  );
  return policy;
}

/** Minimal error page: the OAuth error code and description, HTML-escaped, nothing else. */
function renderError(ctx: KoaContextWithOIDC, out: ErrorOut) {
  ctx.type = 'html';
  ctx.body = `<!doctype html><meta charset="utf-8"><title>Sign-in error</title>
<h1>Sign-in error</h1><p><strong>${escapeHtml(out.error)}</strong>: ${escapeHtml(out.error_description)}</p>
<p>Start again from the app.</p>`;
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function signingJwk(pem: string) {
  const jwk = createPrivateKey(pem).export({ format: 'jwk' });
  const thumbprint = createHash('sha256')
    .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
    .digest('base64url');
  return { ...jwk, kid: thumbprint, alg: 'RS256', use: 'sig' };
}
