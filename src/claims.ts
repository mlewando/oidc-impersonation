/** Claims the Bridge hands to a Client app. The ID token and userinfo always carry exactly these. */
export interface IdentityClaims {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
}

const PASS_THROUGH = ['email', 'name', 'preferred_username'] as const;

/**
 * The Personal identity: the real person's Upstream claims, passed through unchanged.
 * Everything else (groups, role or admin claims, …) is dropped.
 */
export function personalClaims(upstream: { sub: string; [claim: string]: unknown }): IdentityClaims {
  const claims: IdentityClaims = { sub: upstream.sub };
  for (const key of PASS_THROUGH) {
    const value = upstream[key];
    if (typeof value === 'string') {
      claims[key] = value;
    }
  }
  return claims;
}
