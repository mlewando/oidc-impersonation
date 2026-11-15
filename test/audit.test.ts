import { describe, expect, it } from 'vitest';
import { clientIp, jsonLinesAuditSink } from '../src/audit.ts';

describe('jsonLinesAuditSink', () => {
  it('writes 1 JSON line per event, timestamped, with exactly the event fields', () => {
    const lines: string[] = [];
    const sink = jsonLinesAuditSink({
      write: (line) => lines.push(line),
      now: () => new Date('2026-11-13T09:12:44.120Z'),
    });

    sink.write({
      event: 'sign-in',
      client: 'immich',
      realUser: 'alice',
      realSub: '9f1c',
      identity: 'personal',
      result: 'ok',
      ip: '203.0.113.7',
    });

    expect(lines).toEqual([
      '{"ts":"2026-11-13T09:12:44.120Z","event":"sign-in","client":"immich","realUser":"alice","realSub":"9f1c","identity":"personal","result":"ok","ip":"203.0.113.7"}\n',
    ]);
  });
});

describe('clientIp', () => {
  it('uses the socket address when there are no trusted proxies', () => {
    expect(clientIp('203.0.113.7', '198.51.100.1', [])).toBe('203.0.113.7');
  });

  it('ignores X-Forwarded-For from an untrusted peer', () => {
    expect(clientIp('203.0.113.7', '198.51.100.1', ['10.0.0.0/8'])).toBe('203.0.113.7');
  });

  it('takes the client from X-Forwarded-For when the peer is a trusted proxy', () => {
    expect(clientIp('10.0.0.5', '198.51.100.1', ['10.0.0.0/8'])).toBe('198.51.100.1');
  });

  it('skips trusted hops and ignores addresses a client could have prepended', () => {
    // spoofed by the client, real client, then a 2nd trusted proxy
    expect(clientIp('10.0.0.5', '1.2.3.4, 198.51.100.1, 10.0.0.9', ['10.0.0.0/8'])).toBe('198.51.100.1');
  });

  it('matches exact addresses, IPv6 and IPv4-mapped IPv6 peers', () => {
    expect(clientIp('::ffff:10.0.0.5', '198.51.100.1', ['10.0.0.5'])).toBe('198.51.100.1');
    expect(clientIp('::1', '2001:db8::1', ['::1'])).toBe('2001:db8::1');
    expect(clientIp('::ffff:203.0.113.7', undefined, [])).toBe('203.0.113.7');
  });

  it('falls back to the proxy address when X-Forwarded-For is missing or only has trusted hops', () => {
    expect(clientIp('10.0.0.5', undefined, ['10.0.0.0/8'])).toBe('10.0.0.5');
    expect(clientIp('10.0.0.5', '10.0.0.9', ['10.0.0.0/8'])).toBe('10.0.0.9');
  });

  it('ignores X-Forwarded-For entries that are not IP addresses', () => {
    expect(clientIp('10.0.0.5', 'garbage, 198.51.100.1', ['10.0.0.0/8'])).toBe('198.51.100.1');
    expect(clientIp('10.0.0.5', '198.51.100.1, <script>', ['10.0.0.0/8'])).toBe('198.51.100.1');
  });
});
