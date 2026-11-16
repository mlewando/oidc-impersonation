# Immich + Authelia

Household members impersonate a shared **Family** Immich account through oidc-impersonation,
signing in with their own Authelia login and 2FA. The repo's [README](../../README.md) explains
every setting; these files are a starting point for a production deployment.

| File | What it is |
|---|---|
| [`config.yaml`](config.yaml) | The bridge's config |
| [`authelia.yml`](authelia.yml) | The Authelia client for the bridge |
| [`immich.yaml`](immich.yaml) | Immich's OAuth settings |

Steps:
1. Find the Family user's `oauthId` in Immich and put it in the Target's `claims.sub`.
2. Create the secret files the bridge config names, and the Valkey user and password.
3. Add the Authelia client and the `photos-family` group, then restart Authelia.
4. Start the bridge and check `GET /healthz`.
5. Point Immich's OAuth settings at the bridge. Keep the redirect URIs exactly as listed.

To impersonate Family: in Immich, Account → Log out → Login with OAuth → pick *Family*. To stop, do
the same and pick yourself. After `session_ttl` (8 h here), Immich signs the Family session out.

The e2e stack in [`e2e/`](../../e2e/) runs the same setup with test values.
