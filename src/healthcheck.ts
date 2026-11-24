// Container healthcheck: exits 0 when the Bridge's own `/healthz` answers 200, otherwise 1.
// It reads only the part of the config it needs (port, listen address, tls, healthz credentials)
// and only asks the local listener, so it skips certificate verification (the certificate names
// the public host, not the address it connects to).
//
//   node src/healthcheck.ts
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { loadProbeConfig, probeHost } from './config.ts';
import { errorMessage } from './errors.ts';

const fail = (error: unknown) => {
  console.error(`healthcheck: ${errorMessage(error)}`);
  process.exit(1);
};

const config = await loadProbeConfig(process.env.CONFIG_FILE ?? '/config/config.yaml').catch(fail);
const get = config.tls ? httpsGet : httpGet;
const url = `${config.tls ? 'https' : 'http'}://${probeHost(config.listenAddress)}:${config.port}/healthz`;

const req = get(
  url,
  { auth: `${config.healthz.username}:${config.healthz.password}`, rejectUnauthorized: false, timeout: 3_000 },
  (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  },
);
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', fail);
