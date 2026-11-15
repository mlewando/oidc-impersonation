import { readFile } from 'node:fs/promises';
import { unwatchFile, watchFile } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { AuditSink } from './audit.ts';
import { createBridge } from './bridge.ts';
import type { BridgeConfig } from './config.ts';
import type { Upstream } from './upstream.ts';

export interface ServerDeps {
  /** Upstream discovery; retried until it succeeds. */
  discover: () => Promise<Upstream>;
  audit: AuditSink;
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
 * Listens right away. Until upstream discovery succeeds, `/healthz` and every other route answer
 * 503; after that `/healthz` answers 200 and the Bridge serves normally.
 */
export async function startServer(config: BridgeConfig, deps: ServerDeps): Promise<RunningServer> {
  const retryMs = deps.discoveryRetryMs ?? 2_000;
  let bridge: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  let stopped = false;

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://bridge').pathname;
    if (path === '/healthz') {
      res.writeHead(bridge ? 200 : 503, { 'content-type': 'text/plain' }).end(bridge ? 'ok' : 'starting');
      return;
    }
    if (!bridge) {
      res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '2' }).end('starting');
      return;
    }
    bridge(req, res);
  };

  let retryTimer: NodeJS.Timeout | undefined;
  const discover = async () => {
    try {
      const upstream = await deps.discover();
      if (stopped) return;
      bridge = createBridge(config, { upstream, audit: deps.audit });
      deps.log(`upstream discovery succeeded (${config.upstream.issuer}); ready`);
    } catch (error) {
      if (stopped) return;
      deps.log(`upstream discovery failed, retrying in ${retryMs} ms: ${errorMessage(error)}`);
      retryTimer = setTimeout(discover, retryMs);
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
  void discover();

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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
