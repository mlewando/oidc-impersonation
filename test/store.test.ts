import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { memoryStore, type Store } from '../src/store.ts';
import { valkeyStore } from '../src/valkey-store.ts';

// 1 contract, 2 backends. The Valkey run needs a server: set VALKEY_URL (for example
// `pnpm test:valkey`, which starts a throwaway container); otherwise it is skipped.

interface Backend {
  store: Store;
  /** Lets `seconds` pass: a fake clock for memory, real time for Valkey. */
  advance(seconds: number): Promise<void>;
}

function memoryBackend(): Backend {
  let now = 1_000_000;
  return {
    store: memoryStore({ now: () => now }),
    advance: async (seconds) => {
      now += seconds * 1000;
    },
  };
}

function valkeyBackend(url: string): Backend {
  const store = valkeyStore({ url, keyPrefix: `test:${randomUUID()}:` });
  afterAll(() => store.close());
  return { store, advance: (seconds) => new Promise((r) => setTimeout(r, seconds * 1000)) };
}

const backends: [string, () => Backend][] = [['memory', memoryBackend]];
const valkeyUrl = process.env.VALKEY_URL;
if (valkeyUrl) backends.push(['valkey', () => valkeyBackend(valkeyUrl)]);

describe.each(backends)('Store contract: %s', (_name, makeBackend) => {
  const { store, advance } = makeBackend();

  it('is ready', async () => {
    await expect(store.ready()).resolves.toBeUndefined();
  });

  it('returns what was set, as a copy', async () => {
    const value = { a: 1, nested: { b: 2 } };
    await store.set('copy', value);
    value.nested.b = 99;

    expect(await store.get('copy')).toEqual({ a: 1, nested: { b: 2 } });
  });

  it('returns undefined for a missing key', async () => {
    expect(await store.get('missing')).toBeUndefined();
  });

  it('forgets a key after its TTL', async () => {
    await store.set('ttl', 'v', 2);

    await advance(1);
    expect(await store.get('ttl')).toBe('v');
    await advance(1.5);
    expect(await store.get('ttl')).toBeUndefined();
  });

  it('keeps the TTL when asked to', async () => {
    await store.set('keep', 'v1', 2);
    await advance(1);
    await store.set('keep', 'v2', 'keep');

    expect(await store.get('keep')).toBe('v2');
    await advance(1.5);
    expect(await store.get('keep')).toBeUndefined();
  });

  it('take returns a value once', async () => {
    await store.set('once', 'v', 60);

    expect(await store.take('once')).toBe('v');
    expect(await store.take('once')).toBeUndefined();
    expect(await store.get('once')).toBeUndefined();
  });

  it('deletes keys', async () => {
    await store.set('del', 'v');
    await store.delete('del');
    expect(await store.get('del')).toBeUndefined();
  });

  it('keeps sets whose TTL only ever grows', async () => {
    await store.addToSet('set', 'a', 1);
    await store.addToSet('set', 'b', 3);
    await store.addToSet('set', 'a', 1); // a shorter TTL never shortens the set

    expect((await store.members('set')).sort()).toEqual(['a', 'b']);
    await advance(2);
    expect((await store.members('set')).sort()).toEqual(['a', 'b']);
    await advance(1.5);
    expect(await store.members('set')).toEqual([]);
  });

  it('removes a member from a set', async () => {
    await store.addToSet('shrink', 'a', 60);
    await store.addToSet('shrink', 'b', 60);
    await store.removeFromSet('shrink', 'a');
    await store.removeFromSet('missing-set', 'a');

    expect(await store.members('shrink')).toEqual(['b']);
    await store.removeFromSet('shrink', 'b');
    expect(await store.members('shrink')).toEqual([]);
  });
});
