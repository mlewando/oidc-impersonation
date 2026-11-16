import type { IncomingMessage, ServerResponse } from 'node:http';
import Koa from 'koa';
import { requestIp, type AuditSink } from './audit.ts';
import type { BridgeConfig } from './config.ts';
import { errorMessage } from './errors.ts';
import { createProvider } from './provider.ts';
import { sessionCap } from './session-cap.ts';
import { signInRoutes } from './sign-in.ts';
import type { Store } from './store.ts';
import type { Upstream } from './upstream.ts';

export interface BridgeDeps {
  upstream: Upstream;
  audit: AuditSink;
  store: Store;
  log: (line: string) => void;
}

export interface Bridge {
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** Starts the session cap: resumes pending logouts, or logs out every Target if they were lost. */
  start(): Promise<void>;
  stop(): void;
}

/**
 * The Bridge as 1 Node request handler: the Bridge's own sign-in routes (`/callback`,
 * `/interaction/…`) and, for everything else, the OIDC provider. Plus the session cap, which ends
 * Impersonation sessions after their `session_ttl`.
 */
export function createBridge(config: BridgeConfig, deps: BridgeDeps): Bridge {
  const bridgeProvider = createProvider(config, deps.store);
  const { provider } = bridgeProvider;
  const cap = sessionCap(config, {
    store: deps.store,
    audit: deps.audit,
    send: bridgeProvider.backchannelLogout,
    log: deps.log,
  });

  // A reused authorization code: oidc-provider rejects it and revokes what it issued; we audit it.
  provider.on('grant.error', (ctx, error) => {
    if ((error as { error_detail?: string }).error_detail !== 'authorization code already consumed') return;
    deps.audit.write({
      event: 'sign-in',
      client: ctx.oidc.client?.clientId ?? 'unknown',
      result: 'replay',
      ip: requestIp(ctx.req, config.trustedProxies),
    });
  });

  // The Client app redeemed a code: if it was an Impersonation with a `sid`, its session is open.
  provider.on('grant.success', (ctx) => {
    const code = ctx.oidc.entities.AuthorizationCode;
    if (!code?.sid || !code.grantId || !code.accountId || !code.clientId) return;
    const { sid, grantId, accountId, clientId } = code;
    void (async () => {
      const issued = await bridgeProvider.issuedIdentity(grantId);
      if (!issued?.impersonation) return;
      await cap.register({ client: clientId, sub: accountId, sid, ...issued.impersonation });
    })().catch((error) => deps.log(`could not register an Impersonation session: ${errorMessage(error)}`));
  });

  const signIn = new Koa().use(signInRoutes(config, { ...deps, bridgeProvider }).routes()).callback();
  const oidc = provider.callback();

  return {
    handle(req, res) {
      const path = new URL(req.url ?? '/', 'http://bridge').pathname;
      void (path === '/callback' || path.startsWith('/interaction/') ? signIn(req, res) : oidc(req, res));
    },
    start: () => cap.start(),
    stop: () => cap.stop(),
  };
}
