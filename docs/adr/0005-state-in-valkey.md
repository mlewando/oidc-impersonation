# The Bridge keeps its state in Valkey

The Bridge must remember a few things between requests:
- `oidc-provider`'s authorization codes, access tokens, grants, sessions and interactions
- sign-ins in progress while the browser is at the Upstream provider
- the identity each sign-in issued, read back for the ID token and userinfo
- later, the Impersonation session registry (ADR 0003)

All of it now goes through 1 small key-value interface (`Store`: get, set with TTL, delete,
take-once, sets) backed by Valkey. Nothing lives in process memory. Every entry has a TTL, so
nothing accumulates. Values are JSON; keys share a configurable prefix.

We chose this for a predictable architecture: 1 place holds all state, a restart drops nothing,
and what the Bridge remembers can be inspected with ordinary Valkey tools. Valkey's own key expiry
and single-command atomicity (GETDEL, SET … KEEPTTL, MULTI) match what the Bridge needs, and it is
the usual backend for `oidc-provider`. More than 1 Bridge instance becomes possible, though nothing
needs it yet.

The signing key and the other secrets stay in files (README); the store holds only short-lived
protocol state.

## Considered options

- **In-memory only:** rejected. Simple, but a restart drops every sign-in in progress, the default
  `oidc-provider` memory adapter silently evicts after 1,000 entries, and state is spread across
  ad-hoc maps.
- **SQLite (`node:sqlite`) on a volume:** rejected. No extra service, but still exactly 1 instance,
  expiry would be hand-written, and a read-only root filesystem needs a writable volume anyway.

## Consequences

- Valkey is a required dependency. `/healthz` is `503` while it is unreachable; the Bridge starts
  without it and retries.
- Whoever can read the Bridge's Valkey can redeem its codes and tokens while they live. It needs its
  own instance or ACL user, TLS and a password, and its disk must be protected if persistence is on.
- ADR 0003's startup logout ("the registry is empty after a restart") no longer has to be the
  only safety net: the `sid` registry can live in Valkey too. Revisit when implementing it.
- Tests run the same `Store` contract against an in-memory implementation (unit tests) and a real
  Valkey (`pnpm test:valkey`, and the e2e stack).
