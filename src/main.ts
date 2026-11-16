import { jsonLinesAuditSink } from './audit.ts';
import { ConfigError, loadConfig, type BridgeConfig } from './config.ts';
import { startServer } from './server.ts';
import { valkeyStore } from './valkey-store.ts';
import { discoverUpstream } from './upstream.ts';

// stdout carries only audit JSON lines (README); every other message goes to stderr, including
// libraries' console.log/info notices (oidc-provider prints those).
console.log = console.error;
console.info = console.error;

let config: BridgeConfig;
try {
  config = await loadConfig(process.env.CONFIG_FILE ?? '/config/config.yaml');
} catch (error) {
  // An invalid config is an operator error: print the list, not a stack trace.
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}

const store = valkeyStore(config.store);
const server = await startServer(config, {
  discover: () => discoverUpstream(config),
  audit: jsonLinesAuditSink(),
  store,
  log: (line) => console.error(line),
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    console.error(`${signal} received, shutting down`);
    void server
      .close()
      .then(() => store.close())
      .then(() => process.exit(0));
  });
}
