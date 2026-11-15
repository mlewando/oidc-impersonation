// Container healthcheck: exits 0 when the Bridge's own `/healthz` answers 200, otherwise 1.
// It only asks the local listener whether it is ready, so it skips certificate verification
// (the certificate is issued for the public host name, not for 127.0.0.1).
//
//   node src/healthcheck.ts
import { readFile } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { parse } from 'yaml';

const raw = parse(await readFile(process.env.CONFIG_FILE ?? '/config/config.yaml', 'utf8')) ?? {};
const port = typeof raw.port === 'number' ? raw.port : 8080;
const get = raw.tls ? httpsGet : httpGet;
const url = `${raw.tls ? 'https' : 'http'}://127.0.0.1:${port}/healthz`;

const req = get(url, { rejectUnauthorized: false, timeout: 3_000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', (error) => {
  console.error(`healthcheck: ${error.message}`);
  process.exit(1);
});
