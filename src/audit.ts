import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';

/**
 * 1 decision of the Bridge, attributed to the real person. Never carries tokens, codes, cookies or
 * secrets: only the fields below exist.
 */
export type AuditEvent = SignInEvent;

export interface SignInEvent {
  event: 'sign-in';
  client: string;
  realUser?: string;
  realSub?: string;
  identity?: 'personal' | 'impersonation';
  target?: string;
  result: 'ok' | 'not-allowed' | 'email-collides-with-target' | 'bad-csrf' | 'replay';
  ip: string;
}

export interface AuditSink {
  write(event: AuditEvent): void;
}

/** Writes each event as 1 JSON line (stdout in production), with `ts` first. */
export function jsonLinesAuditSink(opts: {
  write?: (line: string) => void;
  now?: () => Date;
} = {}): AuditSink {
  const write = opts.write ?? ((line) => process.stdout.write(line));
  const now = opts.now ?? (() => new Date());
  return {
    write(event) {
      write(`${JSON.stringify({ ts: now().toISOString(), ...event })}\n`);
    },
  };
}

/**
 * The address to audit for a request. `X-Forwarded-For` counts only when the peer is a trusted
 * proxy; then the rightmost hop that isn't a trusted proxy is the client, so addresses a client
 * prepends itself are ignored.
 */
export function clientIp(peer: string, forwardedFor: string | undefined, trustedProxies: string[]): string {
  const trusted = blockList(trustedProxies);
  const peerIp = normalise(peer);
  if (!forwardedFor || !isTrusted(trusted, peerIp)) return peerIp;

  const hops = forwardedFor
    .split(',')
    .map((hop) => normalise(hop.trim()))
    .filter((hop) => isIP(hop));
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]!;
    if (!isTrusted(trusted, hop)) return hop;
  }
  return hops[0] ?? peerIp;
}

/** `clientIp` for an incoming request. */
export function requestIp(req: IncomingMessage, trustedProxies: string[]): string {
  const forwarded = req.headers['x-forwarded-for'];
  return clientIp(
    req.socket.remoteAddress ?? '',
    Array.isArray(forwarded) ? forwarded.join(',') : forwarded,
    trustedProxies,
  );
}

const blockLists = new Map<string, BlockList>();

function blockList(entries: string[]) {
  const key = entries.join(',');
  let list = blockLists.get(key);
  if (!list) {
    list = new BlockList();
    for (const entry of entries) {
      const [address, prefix] = entry.split('/') as [string, string | undefined];
      const type = isIP(address) === 6 ? 'ipv6' : 'ipv4';
      if (prefix === undefined) list.addAddress(address, type);
      else list.addSubnet(address, Number(prefix), type);
    }
    blockLists.set(key, list);
  }
  return list;
}

function isTrusted(list: BlockList, ip: string) {
  const version = isIP(ip);
  return version !== 0 && list.check(ip, version === 6 ? 'ipv6' : 'ipv4');
}

/** `::ffff:10.0.0.5` (an IPv4 peer on a dual-stack socket) → `10.0.0.5`. */
function normalise(ip: string) {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}
