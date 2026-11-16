import { describe, expect, it } from 'vitest';
import { storeAdapter } from '../src/oidc-adapter.ts';
import { memoryStore } from '../src/store.ts';

describe('storeAdapter (oidc-provider persistence on the Store)', () => {
  it('stores, finds and destroys a model by id', async () => {
    const adapter = storeAdapter(memoryStore())('Interaction');
    await adapter.upsert('i1', { uid: 'i1', returnTo: '/auth/i1' }, 600);

    expect(await adapter.find('i1')).toEqual({ uid: 'i1', returnTo: '/auth/i1' });
    await adapter.destroy('i1');
    expect(await adapter.find('i1')).toBeUndefined();
  });

  it('keeps models apart by name', async () => {
    const forModel = storeAdapter(memoryStore());
    await forModel('Grant').upsert('x', { kind: 'Grant' }, 600);

    expect(await forModel('Session').find('x')).toBeUndefined();
  });

  it('marks a code as consumed and keeps it findable', async () => {
    const adapter = storeAdapter(memoryStore())('AuthorizationCode');
    await adapter.upsert('c1', { grantId: 'g1', accountId: 'alice' }, 60);

    await adapter.consume('c1');

    expect(await adapter.find('c1')).toMatchObject({ grantId: 'g1', consumed: expect.any(Number) });
  });

  it('finds a session by its uid', async () => {
    const adapter = storeAdapter(memoryStore())('Session');
    await adapter.upsert('s1', { uid: 'u1', accountId: 'alice' }, 600);

    expect(await adapter.findByUid('u1')).toEqual({ uid: 'u1', accountId: 'alice' });
    expect(await adapter.findByUid('unknown')).toBeUndefined();
  });

  it('revokes every code and token of a grant', async () => {
    const forModel = storeAdapter(memoryStore());
    await forModel('AuthorizationCode').upsert('c1', { grantId: 'g1' }, 60);
    await forModel('AccessToken').upsert('t1', { grantId: 'g1' }, 600);
    await forModel('AccessToken').upsert('t2', { grantId: 'g2' }, 600);

    await forModel('AccessToken').revokeByGrantId('g1');

    expect(await forModel('AuthorizationCode').find('c1')).toBeUndefined();
    expect(await forModel('AccessToken').find('t1')).toBeUndefined();
    expect(await forModel('AccessToken').find('t2')).toEqual({ grantId: 'g2' });
  });
});
