import { describe, expect, it } from 'vitest';
import { personalClaims } from '../src/claims.ts';

describe('personalClaims', () => {
  it('passes the 4 identity claims through unchanged and drops everything else', () => {
    const upstream = {
      sub: '9f1c2a',
      email: 'alice@example.org',
      name: 'Alice',
      preferred_username: 'alice',
      groups: ['photos-family'],
      immich_role: 'admin',
      email_verified: true,
    };

    expect(personalClaims(upstream)).toEqual({
      sub: '9f1c2a',
      email: 'alice@example.org',
      name: 'Alice',
      preferred_username: 'alice',
    });
  });

  it('omits identity claims the Upstream provider did not send', () => {
    expect(personalClaims({ sub: '9f1c2a' })).toEqual({ sub: '9f1c2a' });
  });
});
