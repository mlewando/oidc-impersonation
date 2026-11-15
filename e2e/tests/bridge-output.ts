import { request } from 'node:http';

// Reads the Bridge container's stdout through the Docker socket mounted into the e2e runner. That
// is where the audit log goes (README: 1 JSON line per decision on stdout).

const BRIDGE_CONTAINER = 'oidc-impersonation-e2e-bridge-1';

/** Everything the Bridge has written to stdout so far. */
export async function bridgeStdout(): Promise<string> {
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const req = request(
      { socketPath: '/var/run/docker.sock', path: `/containers/${BRIDGE_CONTAINER}/logs?stdout=1&stderr=0` },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`docker logs: ${res.statusCode}`)),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
  return demultiplex(raw);
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

/** Polls until an audit line matching `match` appears (stdout is flushed asynchronously). */
export async function waitForAuditLine(since: Date, match: (line: AuditLine) => boolean): Promise<AuditLine> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const found = (await auditLinesSince(since)).find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error('no matching audit line within 5s');
    await new Promise((r) => setTimeout(r, 200));
  }
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
