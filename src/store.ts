/**
 * The Bridge's only state: a small key-value store with per-key TTLs. Everything the Bridge must
 * remember between requests lives here (oidc-provider's codes, tokens, grants and sessions, sign-ins
 * in progress, issued identities), so swapping the backend changes nothing else.
 *
 * Values are JSON: what comes back is always a copy, as it would be from a networked store.
 */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  /** `ttlSeconds`: expire after that long; `'keep'`: keep the key's current expiry; omitted: never. */
  set(key: string, value: unknown, ttlSeconds?: number | 'keep'): Promise<void>;
  delete(...keys: string[]): Promise<void>;
  /** Gets and deletes in 1 step, so a value can be used once only. */
  take<T>(key: string): Promise<T | undefined>;
  /** Adds `member` to the set at `key`; the set expires with its longest-lived member. */
  addToSet(key: string, member: string, ttlSeconds: number): Promise<void>;
  members(key: string): Promise<string[]>;
  /** Resolves once the store answers; rejects if it can't be reached. */
  ready(): Promise<void>;
  close(): Promise<void>;
}

interface Entry {
  json: string;
  expiresAt: number; // ms since epoch; Infinity = never
}

/**
 * In-process store, for tests. Expired entries are dropped when read. `now` lets tests move time
 * by hand; the same contract tests run against Valkey in real time.
 */
export function memoryStore(opts: { now?: () => number } = {}): Store {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const live = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.expiresAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };

  const expiry = (ttlSeconds: number | undefined) =>
    ttlSeconds === undefined ? Infinity : now() + ttlSeconds * 1000;

  return {
    async get<T>(key: string) {
      const entry = live(key);
      return entry ? (JSON.parse(entry.json) as T) : undefined;
    },

    async set(key, value, ttlSeconds) {
      const expiresAt = ttlSeconds === 'keep' ? (live(key)?.expiresAt ?? Infinity) : expiry(ttlSeconds);
      entries.set(key, { json: JSON.stringify(value), expiresAt });
    },

    async delete(...keys) {
      for (const key of keys) entries.delete(key);
    },

    async take<T>(key: string) {
      const entry = live(key);
      entries.delete(key);
      return entry ? (JSON.parse(entry.json) as T) : undefined;
    },

    async addToSet(key, member, ttlSeconds) {
      const entry = live(key);
      const members = new Set<string>(entry ? JSON.parse(entry.json) : []);
      members.add(member);
      entries.set(key, {
        json: JSON.stringify([...members]),
        expiresAt: Math.max(entry?.expiresAt ?? 0, expiry(ttlSeconds)),
      });
    },

    async members(key) {
      const entry = live(key);
      return entry ? (JSON.parse(entry.json) as string[]) : [];
    },

    async ready() {},

    async close() {
      entries.clear();
    },
  };
}
