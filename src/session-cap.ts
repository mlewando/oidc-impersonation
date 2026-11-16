import type { AuditSink } from './audit.ts';
import type { BridgeConfig } from './config.ts';
import { errorMessage } from './errors.ts';
import type { Store } from './store.ts';

/**
 * Ends Impersonation sessions through OIDC back-channel logout (ADR 0003), for Client apps with a
 * `backchannel_logout_uri`:
 * - every Impersonation session is registered by its `sid`; after the Target's `session_ttl` the
 *   Bridge sends a logout token for that `sid`
 * - the registry lives in the Store, so a restart resumes every pending logout
 * - if the registry itself was lost (its marker is gone, for example Valkey restarted without
 *   persistence), startup sends 1 logout per Target by `sub` alone, which ends every session of it
 *
 * A failed logout is retried every `retryMs` for `giveUpMs`, then given up. Every outcome is
 * audited as `impersonation-logout`.
 */
export interface SessionCap {
  /** Checks the registry marker and schedules every pending logout. */
  start(): Promise<void>;
  /** Registers an Impersonation session the Client app just opened. */
  register(session: ImpersonationSession): Promise<void>;
  /** Stops every timer (pending logouts stay in the Store). */
  stop(): void;
}

export interface ImpersonationSession {
  client: string;
  target: string;
  /** The Target's `sub` and the `sid` its ID token carried. */
  sub: string;
  sid: string;
  realSub: string;
  realUser?: string;
}

export interface SessionCapDeps {
  store: Store;
  audit: AuditSink;
  /** Sends 1 logout token (by `sid`, or by `sub` alone); rejects unless the app accepted it. */
  send(clientId: string, sub: string, sid?: string): Promise<void>;
  log(line: string): void;
  retryMs?: number;
  giveUpMs?: number;
}

/** A registered session, with when its logout is due (ms since epoch). */
interface Pending extends ImpersonationSession {
  dueAt: number;
}

interface Logout {
  client: string;
  target: string;
  sub: string;
  sid?: string;
  realSub?: string;
  realUser?: string;
  reason: 'ttl' | 'startup';
  /** Store key of the registered session, deleted once it is settled. */
  key?: string;
}

const REGISTRY = 'cap:sessions';
const MARKER = 'cap:registry';
const DAY = 24 * 3600;
/** How long the marker (and a pending entry past its due time) outlives a stopped Bridge. */
const KEEP = 30 * DAY;
/** setTimeout's limit; longer waits are chained. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export function sessionCap(config: BridgeConfig, deps: SessionCapDeps): SessionCap {
  const retryMs = deps.retryMs ?? 30_000;
  const giveUpMs = deps.giveUpMs ?? 10 * 60_000;
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;

  const wait = (ms: number, then: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopped) return;
      if (ms > MAX_TIMER_MS) wait(ms - MAX_TIMER_MS, then);
      else then();
    }, Math.min(Math.max(ms, 0), MAX_TIMER_MS));
    timers.add(timer);
  };

  const deliver = (logout: Logout, deadline = Date.now() + giveUpMs) => {
    const settle = async (result: 'ok' | 'failed') => {
      deps.audit.write({
        event: 'impersonation-logout',
        client: logout.client,
        target: logout.target,
        ...(logout.realUser !== undefined && { realUser: logout.realUser }),
        ...(logout.realSub !== undefined && { realSub: logout.realSub }),
        reason: logout.reason,
        result,
      });
      if (logout.key) await Promise.all([deps.store.delete(logout.key), deps.store.removeFromSet(REGISTRY, logout.key)]);
    };

    deps.send(logout.client, logout.sub, logout.sid).then(
      () => settle('ok'),
      async (error) => {
        if (stopped) return;
        if (Date.now() + retryMs > deadline) {
          deps.log(`back-channel logout to ${logout.client} failed, giving up: ${errorMessage(error)}`);
          await settle('failed');
        } else {
          deps.log(`back-channel logout to ${logout.client} failed, retrying: ${errorMessage(error)}`);
          wait(retryMs, () => deliver(logout, deadline));
        }
      },
    ).catch((error) => deps.log(`session cap: ${errorMessage(error)}`));
  };

  const schedule = (key: string, pending: Pending) =>
    wait(pending.dueAt - Date.now(), () => deliver({ ...pending, reason: 'ttl', key }));

  const capped = (clientId: string) => config.clients.find((c) => c.id === clientId && c.backchannelLogoutUri);

  return {
    async start() {
      const marker = await deps.store.get<{ since: string }>(MARKER);
      if (!marker) {
        deps.log('session registry not found in the store: logging out every Target by sub');
        for (const client of config.clients.filter((c) => c.backchannelLogoutUri)) {
          for (const target of client.targets) {
            deliver({ client: client.id, target: target.id, sub: target.claims.sub, reason: 'startup' });
          }
        }
      }
      // Kept alive while the Bridge runs; after 30 days down, the next startup fails safe.
      const keepMarker = () => deps.store.set(MARKER, marker ?? { since: new Date().toISOString() }, KEEP);
      await keepMarker();
      const refresh = setInterval(() => void keepMarker().catch(() => {}), DAY * 1000);
      refresh.unref();
      timers.add(refresh);

      for (const key of await deps.store.members(REGISTRY)) {
        const pending = await deps.store.get<Pending>(key);
        if (pending) schedule(key, pending);
      }
    },

    async register(session) {
      const client = capped(session.client);
      const target = client?.targets.find((t) => t.id === session.target);
      if (!target) return;
      const pending: Pending = { ...session, dueAt: Date.now() + target.sessionTtl * 1000 };
      const key = `cap:session:${session.client}:${session.sid}`;
      const ttl = target.sessionTtl + KEEP;
      await deps.store.set(key, pending, ttl);
      await deps.store.addToSet(REGISTRY, key, ttl);
      schedule(key, pending);
    },

    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
