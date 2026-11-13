# The Bridge keeps no login session of its own

By default, `oidc-provider` remembers a signed-in user in its own session cookie and answers later
authorization requests without any interaction. The Bridge turns that off: every authorization
request runs the Bridge's login step and a silent round trip to the Upstream provider. The
Upstream session (Authelia: 8h) means no prompt.

The decision whether to impersonate must be fresh on every sign-in. A remembered Bridge session
could skip the Account selection page, reuse stale group membership, or attribute an
Impersonation to the wrong real person. The Upstream provider stays the only authority on who is
signed in. The cost is 1 extra redirect per sign-in.

## Consequences

- Signing out of the Upstream provider means the next app sign-in prompts for credentials.
- The Bridge can't tell browsers apart (Authelia sends no `sid`). Any feature that needs to know
  which browser it is dealing with must add its own marker.
