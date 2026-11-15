import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createBridge } from './bridge.ts';
import { ConfigError, loadConfig, type BridgeConfig } from './config.ts';
import { discoverUpstream } from './upstream.ts';

let config: BridgeConfig;
try {
  config = await loadConfig(process.env.CONFIG_FILE ?? '/config/config.yaml');
} catch (error) {
  // An invalid config is an operator error: print the list, not a stack trace.
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}
const upstream = await discoverUpstream(config);
const handler = createBridge(config, { upstream });

const server = config.tls
  ? createHttpsServer({ cert: config.tls.cert, key: config.tls.key }, handler)
  : createHttpServer(handler);

server.listen(config.port, () => {
  console.error(`oidc-impersonation listening on :${config.port} as ${config.issuer}`);
});
