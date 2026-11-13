# OIDC impersonation bridge

Lets an authenticated person impersonate another account (a shared or role account) inside an
app, using their own SSO login and 2FA, and return to their own account in the same browser.
Every impersonation is attributable to the real person.

## Language

### Parties

**Bridge**:
The identity service an app trusts as its only sign-in provider; it decides, on each sign-in,
whether the real person signs in as themselves or impersonates a Target.
_Avoid_: proxy, gateway, middleman

**Upstream provider**:
The SSO the Bridge signs people in with, and the only source of truth for who they are and which
groups they belong to.
_Avoid_: IdP, Authelia (as a generic term), backend

**Client app**:
An app that signs people in through the Bridge.
_Avoid_: RP, service, Immich (as a generic term)

### People and identities

**Real person**:
The Upstream provider user who is actually at the keyboard, whatever identity the Client app ends
up seeing.
_Avoid_: user, member, owner, impersonator

**Personal identity**:
The real person's own Upstream identity, handed to the Client app unchanged.
_Avoid_: own account, normal login

**Target**:
A configured account in a specific Client app that real people may impersonate, such as Immich's
Family account. Every Target belongs to exactly 1 Client app.
_Avoid_: alias, shared user, impersonated user

**Target identity**:
The identity (claims) the Bridge issues to a Client app when a real person impersonates a Target.
_Avoid_: shared login, family token

### Impersonation

**Impersonation**:
A sign-in in which the Bridge issues a Target identity on behalf of a real person who picked that
Target and is allowed to use it. Signing in directly with an Upstream account that *is* a Target
is not an Impersonation; that is the account's Personal identity.
_Avoid_: switch, delegation, sudo, login-as

**Impersonation session**:
A Client app session that was opened by an Impersonation.
_Avoid_: target session, family session, switched session

**Account selection page**:
The Bridge page, shown during sign-in, where the real person picks their Personal identity or a
Target to impersonate. It is the only way an Impersonation can start.
_Avoid_: confirm page, consent screen, chooser, switch page
