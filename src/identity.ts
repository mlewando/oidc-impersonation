import { personalClaims, type IdentityClaims } from './claims.ts';
import type { ClientConfig, TargetConfig } from './config.ts';

/** The real person, as the Upstream provider described them in this sign-in. */
export interface RealPerson {
  sub: string;
  username?: string;
  /** Their Personal identity: the Upstream claims passed through. */
  claims: IdentityClaims;
  groups: string[];
}

/** The identity a sign-in ends with. */
export type Identity =
  | { kind: 'personal'; claims: IdentityClaims }
  | { kind: 'impersonation'; target: TargetConfig; claims: IdentityClaims };

export type Decision =
  | { kind: 'issue'; identity: Identity }
  | { kind: 'choose'; targets: TargetConfig[] }
  | { kind: 'refuse'; result: 'email-collides-with-target'; target: TargetConfig };

export type Choice = { kind: 'issue'; identity: Identity } | { kind: 'refuse'; result: 'not-allowed' };

/** The posted value that picks the Personal identity on the Account selection page. */
export const PERSONAL_CHOICE = 'personal';

/** Builds the real person from the Upstream claims (`groupsClaim`: where group membership is). */
export function realPerson(upstream: { sub: string; [claim: string]: unknown }, groupsClaim: string): RealPerson {
  const username = upstream.preferred_username;
  const groups = upstream[groupsClaim];
  return {
    sub: upstream.sub,
    ...(typeof username === 'string' && { username }),
    claims: personalClaims(upstream),
    groups: Array.isArray(groups) ? groups.filter((g) => typeof g === 'string') : typeof groups === 'string' ? [groups] : [],
  };
}

/**
 * What a sign-in to `client` through `redirectUri` gets (README "How it works"):
 * - an upstream email that equals a Target's email without being that Target's account → refused
 * - at least 1 Target the person may impersonate, and a selectable redirect URI → the Account
 *   selection page, listing those Targets
 * - otherwise → the Personal identity, silently
 *
 * A Target whose `sub` is the person's own upstream `sub` *is* their account: it is never listed,
 * and their Personal identity is what they get.
 */
export function decide(person: RealPerson, client: ClientConfig, redirectUri: string): Decision {
  const email = person.claims.email?.toLowerCase();
  const collision = client.targets.find(
    (t) => email !== undefined && t.claims.email?.toLowerCase() === email && t.claims.sub !== person.sub,
  );
  if (collision) return { kind: 'refuse', result: 'email-collides-with-target', target: collision };

  const targets = allowedTargets(person, client);
  if (targets.length > 0 && client.selectableRedirectUris.includes(redirectUri)) return { kind: 'choose', targets };
  return { kind: 'issue', identity: personal(person) };
}

/**
 * The identity for a choice posted from the Account selection page. Checked again from scratch:
 * a Target counts only if this sign-in would have listed it.
 */
export function choose(person: RealPerson, client: ClientConfig, redirectUri: string, choice: string): Choice {
  if (choice === PERSONAL_CHOICE) return { kind: 'issue', identity: personal(person) };
  const decision = decide(person, client, redirectUri);
  const target = decision.kind === 'choose' ? decision.targets.find((t) => t.id === choice) : undefined;
  if (!target) return { kind: 'refuse', result: 'not-allowed' };
  return { kind: 'issue', identity: { kind: 'impersonation', target, claims: { ...target.claims } } };
}

function allowedTargets(person: RealPerson, client: ClientConfig) {
  const groups = new Set(person.groups);
  return client.targets.filter((t) => t.claims.sub !== person.sub && t.allowedGroups.some((g) => groups.has(g)));
}

function personal(person: RealPerson): Identity {
  return { kind: 'personal', claims: person.claims };
}
