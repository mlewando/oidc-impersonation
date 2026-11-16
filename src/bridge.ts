import type { IncomingMessage, ServerResponse } from 'node:http';
import Koa from 'koa';
import { requestIp, type AuditSink } from './audit.ts';
import type { BridgeConfig } from './config.ts';
import { createProvider } from './provider.ts';
import { signInRoutes } from './sign-in.ts';
import type { Store } from './store.ts';
import type { Upstream } from './upstream.ts';

export interface BridgeDeps {
  upstream: Upstream;
  audit: AuditSink;
  store: Store;
}

/**
 * The Bridge as 1 Node request handler: the Bridge's own sign-in routes (`/callback`,
 * `/interaction/…`) and, for everything else, the OIDC provider.
 */
export function createBridge(config: BridgeConfig, deps: BridgeDeps) {
  const bridgeProvider = createProvider(config, deps.store);
  const { provider } = bridgeProvider;

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

  const signIn = new Koa().use(signInRoutes(config, { ...deps, bridgeProvider }).routes()).callback();
  const oidc = provider.callback();

  return (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://bridge').pathname;
    return path === '/callback' || path.startsWith('/interaction/') ? signIn(req, res) : oidc(req, res);
  };
}
