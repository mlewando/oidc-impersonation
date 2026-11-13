---
status: accepted (open investigation)
---

# Cap Impersonation sessions with OIDC back-channel logout

Apps like Immich don't let you set a session lifetime. An Immich login session never expires; it
is cleaned up only after 90 days of no use, and its cookie lasts 400 days. A real person who
forgets to sign back in as themselves would keep impersonating the Target, with the Target's full
rights, more or less indefinitely.

Because the Bridge is the app's issuer, it can end Impersonation sessions through OIDC
back-channel logout (Immich v2+: `POST /api/oauth/backchannel-logout`). This is an **optional
per-client** setting:
- If a Client app has a back-channel logout URL configured, every Target identity issued to it
  carries a fresh `sid`. The Bridge keeps `sid → {target, real person, issued at}` in memory.
- After the Target's session TTL, the Bridge signs a logout token for that `sid` and POSTs it to
  the app. Failed POSTs are retried for about 10 min and audited.
- On startup the in-memory registry is empty, so the Bridge sends 1 logout per Target and client
  by the Target's `sub`, which ends all its Impersonation sessions. It fails safe and needs no
  persistent store.
- Personal sessions are never capped, because that would log out phone apps. One exception: if
  the Upstream provider has its own account for a Target (same `sub`), that account's own sessions
  also end in the startup logout, because the app can't tell them apart from Impersonation
  sessions.
- A Client app without back-channel logout keeps its own session lifetime. That is documented as a
  known limit.

Back-channel logout is also the building block for a later 1-click Impersonation with automatic
logout (ADR 0004).

## Considered options

- **Accept that Impersonation sessions have no time limit:** rejected; it was only a stopgap.
- **Expire app cookies in a reverse proxy:** rejected. It is brittle and app-specific.

## Open questions

Still to confirm against the Immich version actually deployed:
- that the ID token's `sid` is stored on the session and matched exactly
- that a logout by `sub` alone ends every session of that user
