import type { Adapter, AdapterPayload } from 'oidc-provider';
import type { Store } from './store.ts';

/** Models whose codes and tokens hang off a grant and are revoked with it. */
const GRANTABLE = new Set(['AccessToken', 'AuthorizationCode']);

/**
 * oidc-provider's persistence (codes, tokens, grants, sessions, interactions) on the Bridge's
 * Store, so all state lives in 1 place. Keys: `oidc:<Model>:<id>`, plus 2 indexes:
 * `oidc:sessionUid:<uid>` → session id, and `oidc:grant:<grantId>` → the keys issued under it.
 */
export function storeAdapter(store: Store) {
  return (model: string): Adapter => {
    const key = (id: string) => `oidc:${model}:${id}`;

    return {
      async upsert(id: string, payload: AdapterPayload, expiresIn: number) {
        // Independent writes: sent together (ioredis pipelines them into 1 round trip).
        await Promise.all([
          store.set(key(id), payload, expiresIn),
          model === 'Session' && payload.uid && store.set(`oidc:sessionUid:${payload.uid}`, id, expiresIn),
          GRANTABLE.has(model) &&
            payload.grantId &&
            store.addToSet(`oidc:grant:${payload.grantId}`, key(id), expiresIn),
        ]);
      },

      async find(id: string) {
        return store.get<AdapterPayload>(key(id));
      },

      async findByUid(uid: string) {
        const id = await store.get<string>(`oidc:sessionUid:${uid}`);
        return id === undefined ? undefined : store.get<AdapterPayload>(key(id));
      },

      // Device flow is disabled, so there are no user codes.
      async findByUserCode() {
        return undefined;
      },

      async consume(id: string) {
        const payload = await store.get<AdapterPayload>(key(id));
        if (payload) {
          await store.set(key(id), { ...payload, consumed: Math.floor(Date.now() / 1000) }, 'keep');
        }
      },

      async destroy(id: string) {
        await store.delete(key(id));
      },

      async revokeByGrantId(grantId: string) {
        const grantKey = `oidc:grant:${grantId}`;
        await store.delete(...(await store.members(grantKey)), grantKey);
      },
    };
  };
}
