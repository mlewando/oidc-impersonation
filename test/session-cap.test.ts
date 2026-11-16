import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../src/audit.ts';
import type { BridgeConfig, ClientConfig } from '../src/config.ts';
import { sessionCap, type SessionCap } from '../src/session-cap.ts';
import { memoryStore, type Store } from '../src/store.ts';

const HOUR = 3600;

function client(id: string, overrides: Partial<ClientConfig> = {}): ClientConfig {
  return {
    id,
    secret: 's',
    tokenEndpointAuthMethod: 'client_secret_basic',
    redirectUris: ['https://app.example.org/cb'],
    selectableRedirectUris: ['https://app.example.org/cb'],
    backchannelLogoutUri: `https://${id}.example.org/backchannel-logout`,
    targets: [
      { id: 'family', label: 'Family', allowedGroups: ['g'], sessionTtl: 8 * HOUR, claims: { sub: `${id}-family` } },
      { id: 'archive', label: 'Archive', allowedGroups: ['g'], sessionTtl: HOUR, claims: { sub: `${id}-archive` } },
    ],
    ...overrides,
  };
}

const { backchannelLogoutUri: _, ...nocap } = client('nocap');
const config = { clients: [client('immich'), nocap] } as BridgeConfig;

const session = {
  client: 'immich',
  target: 'family',
  sub: 'immich-family',
  sid: 'sid-1',
  realSub: 'alice-sub',
  realUser: 'alice',
};

let store: Store;
let audit: AuditEvent[];
let sent: { client: string; sub: string; sid?: string }[];
let failures: number;
let caps: SessionCap[];

function makeCap() {
  const cap = sessionCap(config, {
    store,
    audit: { write: (e) => audit.push(e) },
    send: async (client, sub, sid) => {
      sent.push({ client, sub, ...(sid !== undefined && { sid }) });
      if (failures > 0) {
        failures--;
        throw new Error('503 Service Unavailable');
      }
    },
    log: () => {},
    retryMs: 30_000,
    giveUpMs: 10 * 60_000,
  });
  caps.push(cap);
  return cap;
}

/** A cap that already ran once, so the registry marker exists. */
async function startedCap() {
  const cap = makeCap();
  await cap.start();
  sent.length = 0;
  audit.length = 0;
  return cap;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-16T10:00:00Z') });
  store = memoryStore();
  audit = [];
  sent = [];
  failures = 0;
  caps = [];
});

afterEach(() => {
  for (const cap of caps) cap.stop();
  vi.useRealTimers();
});

describe('after session_ttl', () => {
  it('sends 1 logout for the sid and audits it', async () => {
    const cap = await startedCap();
    await cap.register(session);

    await vi.advanceTimersByTimeAsync(8 * HOUR * 1000 - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(sent).toEqual([{ client: 'immich', sub: 'immich-family', sid: 'sid-1' }]);
    expect(audit).toEqual([
      {
        event: 'impersonation-logout',
        client: 'immich',
        target: 'family',
        realUser: 'alice',
        realSub: 'alice-sub',
        reason: 'ttl',
        result: 'ok',
      },
    ]);
  });

  it("uses each Target's own session_ttl", async () => {
    const cap = await startedCap();
    await cap.register({ ...session, target: 'archive', sub: 'immich-archive', sid: 'sid-2' });

    await vi.advanceTimersByTimeAsync(HOUR * 1000);
    expect(sent).toEqual([{ client: 'immich', sub: 'immich-archive', sid: 'sid-2' }]);
  });

  it('retries a failed logout, then audits ok', async () => {
    const cap = await startedCap();
    await cap.register(session);
    failures = 2;

    await vi.advanceTimersByTimeAsync(8 * HOUR * 1000);
    expect(sent).toHaveLength(1);
    expect(audit).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sent).toHaveLength(3);
    expect(audit).toEqual([expect.objectContaining({ reason: 'ttl', result: 'ok' })]);
  });

  it('gives up after about 10 min of failures and audits failed', async () => {
    const cap = await startedCap();
    await cap.register(session);
    failures = Infinity;

    await vi.advanceTimersByTimeAsync(8 * HOUR * 1000 + 9 * 60_000);
    expect(audit).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(audit).toEqual([expect.objectContaining({ reason: 'ttl', result: 'failed' })]);
    const attempts = sent.length;
    await vi.advanceTimersByTimeAsync(HOUR * 1000);
    expect(sent).toHaveLength(attempts);
  });

  it('tracks nothing for a client without back-channel logout, or an unknown Target', async () => {
    const cap = await startedCap();
    await cap.register({ ...session, client: 'nocap', sub: 'nocap-family' });
    await cap.register({ ...session, target: 'nobody' });

    await vi.advanceTimersByTimeAsync(24 * HOUR * 1000);
    expect(sent).toEqual([]);
    expect(await store.members('cap:sessions')).toEqual([]);
  });
});

describe('across a restart', () => {
  it('resumes a pending logout from the store, without logging anyone out at startup', async () => {
    const before = await startedCap();
    await before.register(session);
    await vi.advanceTimersByTimeAsync(2 * HOUR * 1000);
    before.stop();

    const after = makeCap();
    await after.start();
    expect(sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(6 * HOUR * 1000);
    expect(sent).toEqual([{ client: 'immich', sub: 'immich-family', sid: 'sid-1' }]);
  });

  it('sends a logout that fell due while the Bridge was down right away', async () => {
    const before = await startedCap();
    await before.register(session);
    before.stop();
    await vi.advanceTimersByTimeAsync(9 * HOUR * 1000);

    const after = makeCap();
    await after.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([{ client: 'immich', sub: 'immich-family', sid: 'sid-1' }]);
    expect(await store.members('cap:sessions')).toEqual([]);
  });
});

describe('when the registry was lost', () => {
  it('logs out every Target of every capped client by sub alone, once', async () => {
    const cap = makeCap();
    await cap.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toEqual([
      { client: 'immich', sub: 'immich-family' },
      { client: 'immich', sub: 'immich-archive' },
    ]);
    expect(audit).toEqual([
      { event: 'impersonation-logout', client: 'immich', target: 'family', reason: 'startup', result: 'ok' },
      { event: 'impersonation-logout', client: 'immich', target: 'archive', reason: 'startup', result: 'ok' },
    ]);

    cap.stop();
    sent.length = 0;
    await makeCap().start();
    expect(sent).toEqual([]);
  });

  it('retries a startup logout with the same rules', async () => {
    failures = Infinity;
    await makeCap().start();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(audit).toEqual([
      expect.objectContaining({ target: 'family', reason: 'startup', result: 'failed' }),
      expect.objectContaining({ target: 'archive', reason: 'startup', result: 'failed' }),
    ]);
  });

  it('counts as lost after 30 days without a running Bridge', async () => {
    (await startedCap()).stop();
    await vi.advanceTimersByTimeAsync(31 * 24 * HOUR * 1000);

    await makeCap().start();
    expect(sent).toHaveLength(2);
  });
});
