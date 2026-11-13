# Start an Impersonation by signing in again through an Account selection page

To impersonate a Target, or to stop, the real person logs out of the Client app with its own
button and signs in again. During that sign-in, the Bridge shows an **Account selection page**
listing Personal and every Target the person may impersonate there. Only a click on that page (a
form POST with a CSRF token, `frame-ancestors 'none'`) starts an Impersonation.

The page appears only when both of these are true:
- the person is allowed at least 1 Target for that Client app
- the redirect URI is marked as selectable (for Immich, only the web `/auth/login`)

Everyone else, and every phone-app sign-in, gets Personal silently.

This works with any OIDC app and needs nothing on the app's own site.

## Considered options

- **A `/switch?to=…` link plus a "log out and sign in again" page served on the app's own
  origin:** rejected. It means hosting Bridge code on someone else's site, which is too intrusive
  and different for every app.
- **A `/switch` link plus back-channel logout plus an auto-start login URL:** deferred. It allows
  a 1-click Impersonation, but only for apps that support both (Immich does). It will be added
  later as an optional per-client feature on top of this flow, not instead of it.
- **Personal silently by default, and Impersonation only after an explicit intent link:**
  rejected. Without a 1-click link, the person has no way to express the intent.

## Consequences

- People allowed a Target see 1 extra page on each web sign-in. Apps like Immich keep sessions
  for a long time, so this is rare.
- A link alone can never start an Impersonation.
