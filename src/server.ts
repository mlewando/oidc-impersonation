import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { unwatchFile, watchFile } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { AuditSink } from './audit.ts';
import { createBridge } from './bridge.ts';
import type { BridgeConfig } from './config.ts';
import { errorMessage } from './errors.ts';
import type { Store } from './store.ts';
import type { Upstream } from './upstream.ts';

export interface ServerDeps {
  /** Upstream discovery; retried until it succeeds. */
  discover: () => Promise<Upstream>;
  audit: AuditSink;
  store: Store;
  /** Operational messages (stderr in production; never stdout, which is the audit log). */
  log: (line: string) => void;
  discoveryRetryMs?: number;
  tlsPollMs?: number;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Listens right away. Until the store answers and upstream discovery succeeds, `/healthz` and
 * every other route answer 503; after that the Bridge serves normally, and `/healthz` answers 200
 * as long as the store does. `/healthz` requires the configured basic-auth credentials.
 */
export async function startServer(config: BridgeConfig, deps: ServerDeps): Promise<RunningServer> {
  const retryMs = deps.discoveryRetryMs ?? 2_000;
  let bridge: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  let stopped = false;

  const healthzAuthorized = basicAuthCheck(config.healthz.username, config.healthz.password);
  const healthz = async (req: IncomingMessage, res: ServerResponse) => {
    // Credentials first: without them, not even readiness is revealed.
    if (!healthzAuthorized(req.headers.authorization)) {
      res
        .writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Basic realm="healthz", charset="UTF-8"' })
        .end('unauthorized');
      return;
    }
    const healthy = bridge !== undefined && (await deps.store.ready().then(() => true, () => false));
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'text/plain' }).end(healthy ? 'ok' : 'not ready');
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://bridge').pathname;
    if (path === '/healthz') {
      void healthz(req, res);
      return;
    }
    if (!bridge) {
      res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '2' }).end('starting');
      return;
    }
    bridge(req, res);
  };

  let retryTimer: NodeJS.Timeout | undefined;
  const start = async () => {
    try {
      await deps.store.ready();
      const upstream = await deps.discover();
      if (stopped) return;
      bridge = createBridge(config, { upstream, audit: deps.audit, store: deps.store });
      deps.log(`store reachable and upstream discovery succeeded (${config.upstream.issuer}); ready`);
    } catch (error) {
      if (stopped) return;
      deps.log(`not ready, retrying in ${retryMs} ms: ${errorMessage(error)}`);
      retryTimer = setTimeout(start, retryMs);
    }
  };

  const tls = config.tls;
  const server = tls ? createHttpsServer({ cert: tls.cert, key: tls.key }, handler) : createHttpServer(handler);
  const stopWatching = tls ? watchTls(server as ReturnType<typeof createHttpsServer>, tls, deps) : () => {};
  if (!tls) {
    deps.log(
      'WARNING: serving plain HTTP. Configure `tls` unless a proxy on the same host terminates HTTPS ' +
        '(README: "Use HTTPS on every hop").',
    );
  }

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  const { port } = server.address() as AddressInfo;
  deps.log(`oidc-impersonation listening on :${port} as ${config.issuer}`);
  void start();

  return {
    url: `${tls ? 'https' : 'http'}://localhost:${port}`,
    port,
    async close() {
      stopped = true;
      clearTimeout(retryTimer);
      stopWatching();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Polls the certificate and key files and swaps them in when they change. Polling (not inotify)
 * also sees files replaced by rename or through a symlink swap, as renewal tools and secret mounts
 * do. A broken pair is logged and the current certificate stays in use.
 */
function watchTls(
  server: ReturnType<typeof createHttpsServer>,
  tls: { certFile: string; keyFile: string },
  deps: ServerDeps,
) {
  const interval = deps.tlsPollMs ?? 5_000;
  let pending: NodeJS.Timeout | undefined;

  const reload = async () => {
    try {
      const [cert, key] = await Promise.all([readFile(tls.certFile, 'utf8'), readFile(tls.keyFile, 'utf8')]);
      server.setSecureContext({ cert, key });
      deps.log(`TLS certificate reloaded from ${tls.certFile}`);
    } catch (error) {
      deps.log(`TLS reload failed, keeping the current certificate: ${errorMessage(error)}`);
    }
  };
  // Cert and key are usually replaced 1 after the other; wait a moment so both are new.
  const onChange = () => {
    clearTimeout(pending);
    pending = setTimeout(reload, interval);
  };

  watchFile(tls.certFile, { interval }, onChange);
  watchFile(tls.keyFile, { interval }, onChange);
  return () => {
    clearTimeout(pending);
    unwatchFile(tls.certFile, onChange);
    unwatchFile(tls.keyFile, onChange);
  };
}

/**
 * Checks an `Authorization: Basic …` header in constant time: both sides are hashed first, so
 * neither the length nor the content of the expected credentials leaks through timing.
 */
function basicAuthCheck(username: string, password: string) {
  const expected = createHash('sha256').update(`${username}:${password}`).digest();
  return (header: string | undefined) => {
    const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header ?? '');
    if (!match) return false;
    const given = createHash('sha256').update(Buffer.from(match[1]!, 'base64').toString('utf8')).digest();
    return timingSafeEqual(given, expected);
  };
}
