import { Redis } from 'ioredis';
import type { StoreConfig } from './config.ts';
import type { Store } from './store.ts';

/**
 * The Store on Valkey (or Redis). Every operation is 1 Valkey command or 1 MULTI, so it is atomic
 * on the server; values are JSON strings; TTLs are Valkey's own key expiry.
 */
export function valkeyStore(opts: StoreConfig): Store {
  const client = new Redis(opts.url, {
    ...(opts.username !== undefined && { username: opts.username }),
    ...(opts.password !== undefined && { password: opts.password }),
    keyPrefix: opts.keyPrefix,
    lazyConnect: true,
    // Fail a command after a few retries instead of hanging a sign-in forever.
    maxRetriesPerRequest: 3,
  });
  const parse = <T>(json: string | null) => (json === null ? undefined : (JSON.parse(json) as T));

  return {
    async get<T>(key: string) {
      return parse<T>(await client.get(key));
    },

    async set(key, value, ttlSeconds) {
      const json = JSON.stringify(value);
      if (ttlSeconds === 'keep') await client.set(key, json, 'KEEPTTL');
      else if (ttlSeconds === undefined) await client.set(key, json);
      else await client.set(key, json, 'EX', ttlSeconds);
    },

    async delete(...keys) {
      if (keys.length) await client.del(...keys);
    },

    async take<T>(key: string) {
      return parse<T>(await client.getdel(key));
    },

    async addToSet(key, member, ttlSeconds) {
      // NX sets the 1st expiry; GT only ever extends it. Together: the longest-lived member wins.
      await client.multi().sadd(key, member).expire(key, ttlSeconds, 'NX').expire(key, ttlSeconds, 'GT').exec();
    },

    async members(key) {
      return client.smembers(key);
    },

    async ready() {
      if (client.status === 'wait') await client.connect();
      await client.ping();
    },

    async close() {
      client.disconnect();
    },
  };
}
