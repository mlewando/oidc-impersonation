import * as oidc from 'openid-client';
import type { BridgeConfig } from './config.ts';

/** What the Bridge needs to remember between sending the browser upstream and its return. */
export interface PendingUpstreamLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface UpstreamClaims {
  sub: string;
  [claim: string]: unknown;
}

/** The Bridge as an OIDC client of the Upstream provider. */
export interface Upstream {
  /** Builds the upstream authorization URL. Never sends `prompt` or `max_age` (README). */
  startLogin(): Promise<{ url: URL; pending: PendingUpstreamLogin }>;
  /** Exchanges the code from the callback URL and returns the ID token claims merged with userinfo. */
  finishLogin(callbackUrl: URL, pending: PendingUpstreamLogin): Promise<UpstreamClaims>;
}

export async function discoverUpstream(config: BridgeConfig): Promise<Upstream> {
  const { upstream } = config;
  const client = await oidc.discovery(
    new URL(upstream.issuer),
    upstream.clientId,
    undefined,
    oidc.ClientSecretBasic(upstream.clientSecret),
  );
  const redirectUri = new URL('/callback', config.issuer).href;

  return {
    async startLogin() {
      const pending = {
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        codeVerifier: oidc.randomPKCECodeVerifier(),
      };
      const url = oidc.buildAuthorizationUrl(client, {
        redirect_uri: redirectUri,
        scope: upstream.scopes.join(' '),
        state: pending.state,
        nonce: pending.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(pending.codeVerifier),
        code_challenge_method: 'S256',
      });
      return { url, pending };
    },

    async finishLogin(callbackUrl, pending) {
      const tokens = await oidc.authorizationCodeGrant(client, callbackUrl, {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      const idClaims = tokens.claims()!;
      const userinfo = await oidc.fetchUserInfo(client, tokens.access_token, idClaims.sub);
      return { ...idClaims, ...userinfo, sub: idClaims.sub };
    },
  };
}
