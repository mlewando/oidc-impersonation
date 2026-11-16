import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { parse } from 'yaml';

// The Bridge container, seen through the Docker socket mounted into the e2e runner: its stdout
// (the audit log, README: 1 JSON line per decision), its health and restarts, and its Valkey.

const BRIDGE_CONTAINER = 'oidc-impersonation-e2e-bridge-1';
const STORE_CONTAINER = 'oidc-impersonation-e2e-store-1';

/**
 * `/healthz` credentials, read from the Bridge's own e2e config and secret file. The runner works
 * in the copied `e2e/` directory, where the Bridge's `/config/…` paths are `bridge/…`.
 */
export const HEALTHZ_AUTH = (() => {
  const config = parse(readFileSync('bridge/config.yaml', 'utf8'));
  const secretPath = String(config.healthz.password_file).replace(/^\/config\//, 'bridge/');
  const password = readFileSync(secretPath, 'utf8').trim();
  return `Basic ${Buffer.from(`${config.healthz.username}:${password}`).toString('base64')}`;
})();

/** Everything the Bridge has written to stdout so far. */
export async function bridgeStdout(): Promise<string> {
  const res = await dockerApi('GET', `/containers/${BRIDGE_CONTAINER}/logs?stdout=1&stderr=0`);
  if (res.status !== 200) throw new Error(`docker logs: ${res.status}`);
  return demultiplex(res.body);
}

export interface AuditLine {
  ts: string;
  event: string;
  result: string;
  [field: string]: unknown;
}

/** The audit lines written since `since` (each stdout line must be JSON). */
export async function auditLinesSince(since: Date): Promise<AuditLine[]> {
  const lines = (await bridgeStdout()).split('\n').filter(Boolean);
  return lines.map((line) => JSON.parse(line) as AuditLine).filter((l) => new Date(l.ts) >= since);
}

/** Waits until an audit line matching `match` appears (stdout is flushed asynchronously). */
export async function waitForAuditLine(
  since: Date,
  match: (line: AuditLine) => boolean,
  timeoutMs = 5_000,
): Promise<AuditLine> {
  let found: AuditLine | undefined;
  await pollUntil(async () => (found = (await auditLinesSince(since)).find(match)) !== undefined, timeoutMs, 'audit line');
  return found!;
}

/** Restarts the Bridge container and waits until its own healthcheck reports it healthy again. */
export async function restartBridge() {
  const res = await dockerApi('POST', `/containers/${BRIDGE_CONTAINER}/restart?t=5`);
  if (res.status !== 204) throw new Error(`docker restart: ${res.status}`);
  await pollUntil(
    async () => {
      const inspect = await dockerApi('GET', `/containers/${BRIDGE_CONTAINER}/json`);
      return JSON.parse(inspect.body.toString()).State?.Health?.Status === 'healthy';
    },
    30_000,
    'healthy Bridge after restart',
  );
}

/**
 * Deletes the session cap's registry marker from the Bridge's Valkey, as if Valkey had lost its
 * data: the next Bridge start logs out every Target by `sub`.
 */
export async function forgetSessionRegistry() {
  const command =
    'REDISCLI_AUTH="$(cat /run/valkey-password)" valkey-cli --tls --cacert /certs/ca.crt -h store.e2e.test ' +
    'DEL oidc-impersonation:cap:registry';
  const exec = await dockerApi('POST', `/containers/${STORE_CONTAINER}/exec`, {
    Cmd: ['sh', '-c', command],
    AttachStdout: true,
    AttachStderr: true,
  });
  if (exec.status !== 201) throw new Error(`docker exec: ${exec.status}`);
  const { Id } = JSON.parse(exec.body.toString());
  const run = await dockerApi('POST', `/exec/${Id}/start`, { Detach: false });
  const output = demultiplex(run.body).trim();
  if (output !== '1') throw new Error(`deleting the registry marker answered "${output}"`);
}

export async function pollUntil(condition: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`no ${what} within ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function dockerApi(method: 'GET' | 'POST', path: string, json?: unknown) {
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const headers = json === undefined ? {} : { 'content-type': 'application/json' };
    const req = request({ socketPath: '/var/run/docker.sock', method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(json === undefined ? undefined : JSON.stringify(json));
  });
}

/** Docker's non-TTY log stream: frames of an 8-byte header (stream, 0, 0, 0, size×4) + payload. */
function demultiplex(raw: Buffer) {
  let out = '';
  for (let offset = 0; offset + 8 <= raw.length; ) {
    const size = raw.readUInt32BE(offset + 4);
    out += raw.subarray(offset + 8, offset + 8 + size).toString('utf8');
    offset += 8 + size;
  }
  return out;
}
