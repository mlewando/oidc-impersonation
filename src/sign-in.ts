import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import Router from '@koa/router';
import type { Context } from 'koa';
import { requestIp, type AuditSink, type SignInEvent } from './audit.ts';
import type { BridgeConfig, ClientConfig } from './config.ts';
import { errorMessage } from './errors.ts';
import { choose, decide, realPerson, type Identity, type RealPerson } from './identity.ts';
import { SIGN_IN_TTL, type BridgeProvider } from './provider.ts';
import { messagePage, PAGE_HEADERS, selectionPage } from './selection-page.ts';
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
  person: RealPerson;
}

/** Stored while the Account selection page is shown. Key: `signin:choice:<interaction uid>`. */
interface AwaitingChoice {
  person: RealPerson;
  csrf: string;
}

interface Interaction {
  details: { uid: string; params: Record<string, unknown> };
  client: ClientConfig;
  redirectUri: string;
}

const EXPIRED ='This sign-in has expired or is unknown. Start again from the app.';
const REFUSED = 'This sign-in was refused. Start again from the app, or ask your administrator.';

/**
 * The Bridge's login step, run by oidc-provider on every authorization request (ADR 0002):
 *
 *   1. `GET /interaction/:uid`          → send the browser upstream
 *   2. `GET /callback`                  → the Upstream provider's answer, checked server to server
 *   3. `GET /interaction/:uid/finish`   → decide the identity: issue it, refuse, or show the
 *                                         Account selection page
 *   4. `POST /interaction/:uid/choose`  → the choice from that page, checked again
 *
 * Each stored step is taken once, so no step can be replayed.
 */
export function signInRoutes(config: BridgeConfig, deps: SignInDeps) {
  const { store } = deps;
  const { provider, issueIdentity } = deps.bridgeProvider;
  const router = new Router();

  /** The interaction this request belongs to, proven by its cookie, and its client. */
  const interaction = async (ctx: Context): Promise<Interaction> => {
    const details = await provider.interactionDetails(ctx.req, ctx.res);
    if (ctx.params.uid !== undefined && ctx.params.uid !== details.uid) throw new Error('interaction mismatch');
    const clientId = String(details.params.client_id);
    const client = config.clients.find((c) => c.id === clientId);
    if (!client) throw new Error(`unknown client ${clientId}`);
    return { details, client, redirectUri: String(details.params.redirect_uri) };
  };

  const audit = (
    ctx: Context,
    client: ClientConfig,
    person: RealPerson,
    fields: { result: SignInEvent['result']; identity?: Identity['kind']; target?: string | undefined },
  ) =>
    deps.audit.write({
      event: 'sign-in',
      client: client.id,
      ...(person.username !== undefined && { realUser: person.username }),
      realSub: person.sub,
      ...(fields.identity && { identity: fields.identity }),
      ...(fields.target !== undefined && { target: fields.target }),
      result: fields.result,
      ip: requestIp(ctx.req, config.trustedProxies),
    });

  const issue = async (
    ctx: Context,
    { details, client }: Interaction,
    person: RealPerson,
    identity: Identity,
  ) => {
    const target = identity.kind === 'impersonation' ? identity.target.id : undefined;
    audit(ctx, client, person, { result: 'ok', identity: identity.kind, target });
    const redirectTo = await issueIdentity(ctx, details, {
      claims: identity.claims,
      ...(target !== undefined && {
        impersonation: { target, realSub: person.sub, ...(person.username !== undefined && { realUser: person.username }) },
      }),
    });
    ctx.redirect(redirectTo);
  };

  const showPage = (ctx: Context, status: number, html: string) => {
    ctx.set(PAGE_HEADERS);
    ctx.status = status;
    ctx.type = 'html';
    ctx.body = html;
  };

  const showChoice = (ctx: Context, { details, client, redirectUri }: Interaction, awaiting: AwaitingChoice) => {
    const decision = decide(awaiting.person, client, redirectUri);
    const targets = decision.kind === 'choose' ? decision.targets : [];
    const action = `/interaction/${details.uid}/choose`;
    showPage(ctx, 200, selectionPage({ action, csrf: awaiting.csrf, person: awaiting.person, targets }));
  };

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
    if (!sent) return showPage(ctx, 400, messagePage('Sign-in expired', EXPIRED));

    // Built from the configured issuer, never from request headers.
    const callbackUrl = new URL(`/callback?${ctx.querystring}`, config.issuer);
    let answered: UpstreamAnswered;
    try {
      const upstreamClaims = await deps.upstream.finishLogin(callbackUrl, sent.upstream);
      answered = { person: realPerson(upstreamClaims, config.upstream.groupsClaim) };
    } catch (error) {
      console.error(`upstream sign-in failed: ${errorMessage(error)}`);
      return showPage(ctx, 400, messagePage('Sign-in failed', 'Sign-in with the upstream provider failed. Start again from the app.'));
    }
    await store.set(`signin:result:${sent.interactionUid}`, answered, SIGN_IN_TTL);

    // The interaction cookie is scoped to /interaction/<uid>, so finish there: that proves the
    // browser that came back is the one that started the sign-in.
    ctx.redirect(`/interaction/${sent.interactionUid}/finish`);
  });

  router.get('/interaction/:uid/finish', async (ctx) => {
    const current = await interaction(ctx);
    const { details, client, redirectUri } = current;
    const answered = await store.take<UpstreamAnswered>(`signin:result:${details.uid}`);
    if (!answered) {
      // A reload of the Account selection page shows it again, with the same CSRF token.
      const awaiting = await store.get<AwaitingChoice>(`signin:choice:${details.uid}`);
      if (!awaiting) return showPage(ctx, 400, messagePage('Sign-in expired', EXPIRED));
      return showChoice(ctx, current, awaiting);
    }

    const { person } = answered;
    const decision = decide(person, client, redirectUri);
    switch (decision.kind) {
      case 'refuse':
        audit(ctx, client, person, { result: decision.result, target: decision.target.id });
        return showPage(ctx, 403, messagePage('Sign-in refused', REFUSED));
      case 'issue':
        return issue(ctx, current, person, decision.identity);
      case 'choose': {
        const awaiting: AwaitingChoice = { person, csrf: randomBytes(32).toString('base64url') };
        await store.set(`signin:choice:${details.uid}`, awaiting, SIGN_IN_TTL);
        return showChoice(ctx, current, awaiting);
      }
    }
  });

  router.post('/interaction/:uid/choose', async (ctx) => {
    const current = await interaction(ctx);
    const { details, client, redirectUri } = current;
    const form = await readForm(ctx.req);
    // Taken once: whatever is posted, this page can't be submitted again.
    const awaiting = await store.take<AwaitingChoice>(`signin:choice:${details.uid}`);
    if (!awaiting) return showPage(ctx, 400, messagePage('Sign-in expired', EXPIRED));
    const { person } = awaiting;

    if (!sameSecret(form.get('csrf') ?? '', awaiting.csrf)) {
      audit(ctx, client, person, { result: 'bad-csrf' });
      return showPage(ctx, 403, messagePage('Sign-in refused', REFUSED));
    }

    const posted = form.get('account') ?? '';
    const choice = choose(person, client, redirectUri, posted);
    if (choice.kind === 'refuse') {
      // Only a configured Target id is audited; anything else posted is not echoed.
      const target = client.targets.some((t) => t.id === posted) ? posted : undefined;
      audit(ctx, client, person, { result: choice.result, target });
      return showPage(ctx, 403, messagePage('Sign-in refused', REFUSED));
    }
    return issue(ctx, current, person, choice.identity);
  });

  return router;
}

/** Compares 2 secrets in constant time (hashed first, so the length doesn't leak either). */
function sameSecret(given: string, expected: string) {
  const hash = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(given), hash(expected));
}

/** Reads a small `application/x-www-form-urlencoded` body. */
async function readForm(req: IncomingMessage, limit = 4096): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded\b/.test(req.headers['content-type'] ?? '')) return new URLSearchParams();
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw Object.assign(new Error('form too large'), { status: 413, expose: true });
  }
  return new URLSearchParams(body);
}
