---
status: accepted
---

# Cap Impersonation sessions with OIDC back-channel logout

Apps like Immich don't let you set a session lifetime. An Immich login session never expires; it
is cleaned up only after 90 days of no use, and its cookie lasts 400 days. A real person who
forgets to sign back in as themselves would keep impersonating the Target, with the Target's full
rights, more or less indefinitely.

Because the Bridge is the app's issuer, it can end Impersonation sessions through OIDC
back-channel logout (Immich v2+: `POST /api/oauth/backchannel-logout`). This is an **optional
per-client** setting:
- If a Client app has a back-channel logout URL configured, every ID token issued to it carries a
  fresh `sid`. When the app redeems the code of an Impersonation, the Bridge records
  `sid → {client, target, real person, due at}` in its store.
- After the Target's session TTL, the Bridge signs a logout token for that `sid` and POSTs it to
  the app. Failed POSTs are retried for about 10 min and audited.
- The record lives in Valkey (ADR 0005), so a restart resumes every pending logout and signs
  nobody out.
- If the store lost the record (a marker key is missing: Valkey restarted without persistence,
  was replaced, or the Bridge didn't run for 30 days), the next start sends 1 logout per Target and
  client by the Target's `sub` alone, which ends all its sessions. Losing the record fails safe.
- Personal sessions are never capped, because that would log out phone apps. One exception: if
  the Upstream provider has its own account for a Target (same `sub`), that account's own sessions
  also end in a logout by `sub`, because the app can't tell them apart from Impersonation
  sessions. With the record in the store, that happens only after the record was lost.
- A Client app without back-channel logout keeps its own session lifetime. That is documented as a
  known limit.

Back-channel logout is also the building block for a later 1-click Impersonation with automatic
logout (ADR 0004).

## Considered options

- **Accept that Impersonation sessions have no time limit:** rejected; it was only a stopgap.
- **Expire app cookies in a reverse proxy:** rejected. It is brittle and app-specific.
- **Always log out every Target by `sub` on startup** (the 1st version of this ADR, when the
  record lived in memory): replaced once state moved to Valkey. Every Bridge restart would have
  ended the sessions of upstream accounts that *are* a Target, such as a shared login used on
  phones.

## Confirmed against Immich

Checked in the e2e stack against Immich v3.4.1 (`e2e/tests/session-cap.spec.ts`) and in its
source:
- Immich stores the ID token's `sid` on the session and, for a logout token with `sid` and `sub`,
  deletes exactly the session with that `sid` whose user has that `oauthId`.
- A logout token with `sub` alone deletes every session of the user with that `oauthId`.
- Immich verifies the token's signature through the Bridge's JWKS, its `iss`, `aud` and the
  back-channel logout event, and refuses a `nonce`.
