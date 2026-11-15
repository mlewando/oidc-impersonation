import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createBridge } from './bridge.ts';
import { loadConfig } from './config.ts';
import { discoverUpstream } from './upstream.ts';

const config = await loadConfig(process.env.CONFIG_FILE ?? '/config/config.yaml');
const upstream = await discoverUpstream(config);
const handler = createBridge(config, { upstream });

const server = config.tls
  ? createHttpsServer({ cert: config.tls.cert, key: config.tls.key }, handler)
  : createHttpServer(handler);

server.listen(config.port, () => {
  console.error(`oidc-impersonation listening on :${config.port} as ${config.issuer}`);
});
