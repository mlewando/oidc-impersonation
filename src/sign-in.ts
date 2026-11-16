import Router from '@koa/router';
import { requestIp, type AuditSink } from './audit.ts';
import { personalClaims, type IdentityClaims } from './claims.ts';
import type { BridgeConfig } from './config.ts';
import { errorMessage } from './errors.ts';
import { SIGN_IN_TTL, type BridgeProvider } from './provider.ts';
import type { Store } from './store.ts';
import type { PendingUpstreamLogin, Upstream } from './upstream.ts';

export interface SignInDeps {
  bridgeProvider: BridgeProvider;
  store: Store;
  upstream: Upstream;
  audit: AuditSink;
}

/** Stored while the browser is at the Upstream provider. Key: `signin:state:<upstream state>`. */
interface SentUpstream {
  interactionUid: string;
  upstream: PendingUpstreamLogin;
}

/** Stored once the Upstream provider answered. Key: `signin:result:<interaction uid>`. */
interface UpstreamAnswered {
  realPerson: { sub: string; username?: string };
  claims: IdentityClaims;
}

const EXPIRED = 'Sign-in expired or unknown. Start again from the app.';

/**
 * The Bridge's login step, run by oidc-provider on every authorization request (ADR 0002):
 *
 *   1. `GET /interaction/:uid`         → send the browser upstream
 *   2. `GET /callback`                 → the Upstream provider's answer, checked server to server
 *   3. `GET /interaction/:uid/finish`  → decide the identity, audit it, hand it to oidc-provider
 *
 * Each stored step is taken once, so no step can be replayed.
 */
export function signInRoutes(config: BridgeConfig, deps: SignInDeps) {
  const { store } = deps;
  const { provider, issueIdentity } = deps.bridgeProvider;
  const router = new Router();

  router.get('/interaction/:uid', async (ctx) => {
    const details = await provider.interactionDetails(ctx.req, ctx.res);
    const { url, pending } = await deps.upstream.startLogin();
    const sent: SentUpstream = { interactionUid: details.uid, upstream: pending };
    await store.set(`signin:state:${pending.state}`, sent, SIGN_IN_TTL);
    ctx.redirect(url.href);
  });

  // The Upstream provider's redirect URI (README: `<issuer>/callback`).
  router.get('/callback', async (ctx) => {
    const state = typeof ctx.query.state === 'string' ? ctx.query.state : '';
    const sent = state ? await store.take<SentUpstream>(`signin:state:${state}`) : undefined;
    if (!sent) {
      ctx.status = 400;
      ctx.body = EXPIRED;
      return;
    }

    // Built from the configured issuer, never from request headers.
    const callbackUrl = new URL(`/callback?${ctx.querystring}`, config.issuer);
    let answered: UpstreamAnswered;
    try {
      const upstreamClaims = await deps.upstream.finishLogin(callbackUrl, sent.upstream);
      const username = upstreamClaims.preferred_username;
      answered = {
        realPerson: { sub: upstreamClaims.sub, ...(typeof username === 'string' && { username }) },
        claims: personalClaims(upstreamClaims),
      };
    } catch (error) {
      console.error(`upstream sign-in failed: ${errorMessage(error)}`);
      ctx.status = 400;
      ctx.body = 'Sign-in with the upstream provider failed. Start again from the app.';
      return;
    }
    await store.set(`signin:result:${sent.interactionUid}`, answered, SIGN_IN_TTL);

    // The interaction cookie is scoped to /interaction/<uid>, so finish there: that proves the
    // browser that came back is the one that started the sign-in.
    ctx.redirect(`/interaction/${sent.interactionUid}/finish`);
  });

  router.get('/interaction/:uid/finish', async (ctx) => {
    const details = await provider.interactionDetails(ctx.req, ctx.res);
    const answered = await store.take<UpstreamAnswered>(`signin:result:${details.uid}`);
    if (!answered) {
      ctx.status = 400;
      ctx.body = EXPIRED;
      return;
    }

    deps.audit.write({
      event: 'sign-in',
      client: String(details.params.client_id),
      ...(answered.realPerson.username !== undefined && { realUser: answered.realPerson.username }),
      realSub: answered.realPerson.sub,
      identity: 'personal',
      result: 'ok',
      ip: requestIp(ctx.req, config.trustedProxies),
    });

    ctx.redirect(await issueIdentity(ctx, details, answered.claims));
  });

  return router;
}
