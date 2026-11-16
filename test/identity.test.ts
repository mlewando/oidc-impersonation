import { describe, expect, it } from 'vitest';
import type { ClientConfig, TargetConfig } from '../src/config.ts';
import { choose, decide, PERSONAL_CHOICE, realPerson, type RealPerson } from '../src/identity.ts';

const WEB = 'https://photos.example.org/auth/login';
const PHONE = 'app.immich:///oauth-callback';

const family: TargetConfig = {
  id: 'family',
  label: 'Family',
  allowedGroups: ['photos-family'],
  sessionTtl: 3600,
  claims: { sub: 'family-sub', email: 'family@example.org', name: 'Family' },
};
const archive: TargetConfig = {
  id: 'archive',
  label: 'Archive',
  allowedGroups: ['photos-archive', 'photos-admins'],
  sessionTtl: 3600,
  claims: { sub: 'archive-sub', email: 'Archive@Example.org' },
};

function client(overrides: Partial<ClientConfig> = {}): ClientConfig {
  return {
    id: 'immich',
    secret: 's',
    tokenEndpointAuthMethod: 'client_secret_post',
    redirectUris: [WEB, PHONE],
    selectableRedirectUris: [WEB],
    targets: [family, archive],
    ...overrides,
  };
}

function person(groups: string[], overrides: Partial<RealPerson['claims']> = {}): RealPerson {
  const claims = { sub: 'alice-sub', email: 'alice@example.org', name: 'Alice', preferred_username: 'alice', ...overrides };
  return realPerson({ ...claims, groups }, 'groups');
}

const personal = (p: RealPerson) => ({ kind: 'issue', identity: { kind: 'personal', claims: p.claims } });

describe('realPerson', () => {
  it('reads the groups from the configured claim, as a list or a single string', () => {
    expect(realPerson({ sub: 's', roles: ['a', 1, 'b'] }, 'roles').groups).toEqual(['a', 'b']);
    expect(realPerson({ sub: 's', roles: 'a' }, 'roles').groups).toEqual(['a']);
    expect(realPerson({ sub: 's', groups: ['a'] }, 'roles').groups).toEqual([]);
  });

  it('keeps only the pass-through claims as the Personal identity', () => {
    const p = realPerson({ sub: 's', email: 'e', preferred_username: 'u', groups: ['g'], role: 'admin' }, 'groups');
    expect(p).toEqual({ sub: 's', username: 'u', claims: { sub: 's', email: 'e', preferred_username: 'u' }, groups: ['g'] });
  });
});

describe('decide', () => {
  it.each([
    ['allowed Targets, selectable redirect URI', ['photos-family'], WEB, 'choose'],
    ['allowed Targets, phone redirect URI', ['photos-family'], PHONE, 'personal'],
    ['no allowed Targets, selectable redirect URI', ['other'], WEB, 'personal'],
    ['no allowed Targets, phone redirect URI', [], PHONE, 'personal'],
  ])('%s → %s', (_label, groups, redirectUri, expected) => {
    const p = person(groups);
    const decision = decide(p, client(), redirectUri);
    if (expected === 'choose') expect(decision).toEqual({ kind: 'choose', targets: [family] });
    else expect(decision).toEqual(personal(p));
  });

  it('lists every Target any of whose allowed groups the person is in, in config order', () => {
    expect(decide(person(['photos-admins', 'photos-family']), client(), WEB)).toEqual({
      kind: 'choose',
      targets: [family, archive],
    });
  });

  it('never shows the page for a client without selectable redirect URIs', () => {
    const p = person(['photos-family']);
    expect(decide(p, client({ selectableRedirectUris: [] }), WEB)).toEqual(personal(p));
  });

  it('refuses an upstream email equal to a Target email (any case) without its sub', () => {
    const p = person([], { email: 'archive@example.ORG' });
    expect(decide(p, client(), PHONE)).toEqual({ kind: 'refuse', result: 'email-collides-with-target', target: archive });
  });

  describe('when the upstream account is a Target (same sub)', () => {
    it('gets its Personal identity, not an Impersonation', () => {
      const p = person(['photos-family'], { sub: 'family-sub', email: 'family@example.org' });
      expect(decide(p, client(), WEB)).toEqual(personal(p));
    });

    it('still sees the other Targets it may impersonate', () => {
      const p = person(['photos-family', 'photos-archive'], { sub: 'family-sub', email: 'family@example.org' });
      expect(decide(p, client(), WEB)).toEqual({ kind: 'choose', targets: [archive] });
    });
  });
});

describe('choose', () => {
  const alice = person(['photos-family']);

  it('issues the Personal identity', () => {
    expect(choose(alice, client(), WEB, PERSONAL_CHOICE)).toEqual(personal(alice));
  });

  it("issues exactly the chosen Target's claims", () => {
    expect(choose(alice, client(), WEB, 'family')).toEqual({
      kind: 'issue',
      identity: { kind: 'impersonation', target: family, claims: family.claims },
    });
  });

  it.each([
    ['a Target the person is not allowed', 'archive', WEB],
    ['an unknown Target', 'nobody', WEB],
    ['an allowed Target through a redirect URI that is not selectable', 'family', PHONE],
  ])('refuses %s', (_label, choice, redirectUri) => {
    expect(choose(alice, client(), redirectUri, choice)).toEqual({ kind: 'refuse', result: 'not-allowed' });
  });

  it('refuses the Target that is the person themselves', () => {
    const family_ = person(['photos-family'], { sub: 'family-sub' });
    expect(choose(family_, client(), WEB, 'family')).toEqual({ kind: 'refuse', result: 'not-allowed' });
  });
});
