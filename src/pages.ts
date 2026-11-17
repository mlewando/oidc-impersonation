import type { TargetConfig } from './config.ts';
import { html, renderHtml, type Html } from './html.ts';
import { PERSONAL_CHOICE, type RealPerson } from './identity.ts';

// Every page the Bridge renders itself. `pnpm preview` shows each of them with sample data, with
// live reload, without starting the Bridge (preview/server.ts).

/**
 * Headers for every page the Bridge renders: no framing (clickjacking), no scripts, no caching,
 * no referrer.
 */
export const PAGE_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export interface SelectionPageProps {
  /** Where the form posts. */
  action: string;
  csrf: string;
  person: RealPerson;
  targets: TargetConfig[];
}

/**
 * The Account selection page: who the real person is upstream, a card for their Personal identity
 * (first) and one for each Target they may impersonate. Each card's button submits the form with
 * that account; only this POST, with its CSRF token, can start an Impersonation.
 */
export function selectionPage({ action, csrf, person, targets }: SelectionPageProps): string {
  const who = person.claims.name ?? person.username ?? person.claims.email ?? person.sub;
  const detail = person.claims.email ?? person.username;
  const secondary = detail !== who ? detail : undefined;

  return layout(
    'Choose an account',
    html`<main>
      <h1>Choose an account</h1>
      <p class="who">Signed in as <strong>${who}</strong>${secondary && html` (${secondary})`}</p>
      <form method="post" action="${action}">
        <input type="hidden" name="csrf" value="${csrf}">
        <ul class="accounts">
          ${accountCard({ value: PERSONAL_CHOICE, name: who, email: secondary, yourself: true })}
          ${targets.map((t) => accountCard({ value: t.id, name: t.label, email: t.claims.email, yourself: false }))}
        </ul>
      </form>
      <p class="note">Logging in as another account signs you in as that account. Your choice is recorded under your name.</p>
    </main>`,
  );
}

interface AccountCardProps {
  /** The form value for this account: a Target id, or the Personal choice. */
  value: string;
  name: string;
  email: string | undefined;
  yourself: boolean;
}

function accountCard({ value, name, email, yourself }: AccountCardProps) {
  const label = yourself ? `${name} (yourself)` : name;
  return html`<li class="card">
    <span class="avatar" aria-hidden="true">${initial(name)}</span>
    <span class="account">
      <span class="name"><span class="label">${name}</span>${yourself && html`<span class="badge">You</span>`}</span>
      ${email && html`<span class="email">${email}</span>`}
    </span>
    <button type="submit" name="account" value="${value}" aria-label="Log in as ${label}">Log in</button>
  </li>`;
}

/** The first letter of a name, for the card's avatar (a whole code point, so emoji stay intact). */
const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?';

/** The sign-in was refused (not allowed, bad CSRF token, email collision): no reason is given. */
export const refusedPage = () =>
  messagePage('Sign-in refused', 'This sign-in was refused. Start again from the app, or ask your administrator.');

/** The sign-in step is unknown, already used or timed out. */
export const expiredPage = () =>
  messagePage('Sign-in expired', 'This sign-in has expired or is unknown. Start again from the app.');

/** The Upstream provider's answer didn't check out. */
export const upstreamFailedPage = () =>
  messagePage('Sign-in failed', 'Sign-in with the upstream provider failed. Start again from the app.');

/** A short message page: no internal details, nothing to retry from here. */
function messagePage(title: string, message: string): string {
  return layout(title, html`<main><h1>${title}</h1><p>${message}</p></main>`);
}

/** oidc-provider's error page: the OAuth error code and its description. */
export function errorPage(error: string, description: string | undefined): string {
  return layout(
    'Sign-in error',
    html`<main>
      <h1>Sign-in error</h1>
      <p><strong>${error}</strong>${description && html`: ${description}`}</p>
      <p>Start again from the app.</p>
    </main>`,
  );
}

function layout(title: string, body: Html): string {
  return renderHtml(html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${title}</title>
<style>
:root{color-scheme:dark;--text:#e6ebf5;--muted:#8d97ad;--card:rgb(255 255 255 / .05);--card-hover:rgb(255 255 255 / .09);--border:rgb(255 255 255 / .1);--accent:#4f7cff;--accent-hover:#6b91ff}
*{box-sizing:border-box}
html{min-height:100%;background:#000 linear-gradient(160deg,#16294f 0%,#0a1328 45%,#000 100%) no-repeat fixed}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1rem;font-family:system-ui,sans-serif;line-height:1.5;color:var(--text)}
main{width:fit-content;min-width:min(28rem,100%);max-width:min(40rem,100%)}
h1{font-size:1.5rem;font-weight:600;margin:0 0 .25rem;text-align:center}
main>p{text-align:center;overflow-wrap:anywhere;contain:inline-size}
.who{color:var(--muted);margin:0 0 1.5rem}
.who strong{color:var(--text);font-weight:500}
.accounts{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:minmax(0,1fr);gap:.75rem}
.card{display:flex;align-items:center;gap:.875rem;padding:.875rem 1rem;background:var(--card);border:1px solid var(--border);border-radius:.875rem;transition:background .15s,border-color .15s}
.card:hover{background:var(--card-hover);border-color:rgb(255 255 255 / .18)}
.avatar{flex:none;display:grid;place-items:center;width:2.5rem;height:2.5rem;border-radius:50%;background:linear-gradient(135deg,#3a5bd9,#1d2f6b);font-weight:600}
.account{flex:1;min-width:0;display:flex;flex-direction:column}
.name{display:flex;align-items:center;gap:.375rem;font-weight:500}
.label,.email{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.email{color:var(--muted);font-size:.875rem}
.badge{flex:none;padding:.0625rem .5rem;border-radius:999px;background:rgb(79 124 255 / .18);color:#a9bfff;font-size:.75rem;font-weight:500}
button{flex:none;font:inherit;font-size:.875rem;font-weight:500;padding:.5rem 1rem;border:0;border-radius:.5rem;background:var(--accent);color:#fff;cursor:pointer;transition:background .15s}
button:hover{background:var(--accent-hover)}
button:focus-visible{outline:2px solid #a9bfff;outline-offset:2px}
.note{color:var(--muted);font-size:.8125rem;margin-top:1.5rem}
</style>
</head>
<body>${body}</body>
</html>`);
}
