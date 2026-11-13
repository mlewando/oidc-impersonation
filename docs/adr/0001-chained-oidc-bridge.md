# Impersonation through a chained OIDC bridge

People need to impersonate another account (a Target) inside an app's own UI. The first case is
Immich's shared Family account, used for things like duplicate review. Constraints:
- the same browser profile
- no shared password
- each person's own SSO 2FA
- every Impersonation attributed to the real person
- no changes to the app

We put a Bridge between the 2 sides:
- toward Client apps, it is an OIDC **provider** and their only issuer
- toward the Upstream provider, it is an OIDC **client** (Authorization Code + PKCE)

By default, the Bridge passes the real person's Upstream identity through unchanged (`sub`,
`email`, `name`, `preferred_username`), so existing app users keep matching. It issues a Target
identity only when the person picks that Target on the Account selection page (ADR 0004) and is
allowed to impersonate it.

The Bridge is generic. Client apps, Targets and the Upstream provider are all configuration.
Immich and Authelia are the first deployment, not dependencies. It is built on certified
libraries (`oidc-provider` and `openid-client`) and does not trust `Remote-*` headers.

## Considered options

- **Passkey-only shared login in Authelia:** rejected. Authelia counts a passkey as 1 factor and
  still asks for a password.
- **A 2nd browser profile signed in as the Target:** rejected. It breaks the 1-profile rule and
  needs a shared credential.
- **Doing Target work in a separate helper app:** rejected. Bulk tools such as Immich's duplicate
  review exist only in the app's own UI.
- **Sharing with editor rights (Immich albums):** rejected. An editor can't delete the owner's
  photos.
- **ForwardAuth with `Remote-*` headers:** rejected. Apps like Immich don't use them for their own
  accounts, and trusting headers widens the attack surface.
- **An Immich-specific bridge:** rejected. Impersonation is pure OIDC, and coupling it to 1 app
  would add nothing.

## Consequences

- A Client app depends on the Bridge for every sign-in. Rollback means pointing the app back at
  the Upstream provider directly.
- The `sub` the Bridge receives must equal the `sub` the app got before it was moved behind the
  Bridge. With Authelia, that means no sector identifier on either client.
