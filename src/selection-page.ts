import type { TargetConfig } from './config.ts';
import { PERSONAL_CHOICE, type RealPerson } from './identity.ts';

/**
 * Headers for every page the Bridge renders itself: no framing (clickjacking), no scripts, no
 * caching, no referrer. Forms may only post back to the Bridge.
 */
export const PAGE_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

/**
 * The Account selection page: who the real person is upstream, their Personal identity
 * (preselected) and the Targets they may impersonate. Only a POST of this form, with its CSRF
 * token, can start an Impersonation.
 */
export function selectionPage(opts: {
  action: string;
  csrf: string;
  person: RealPerson;
  targets: TargetConfig[];
}): string {
  const { person } = opts;
  const who = person.claims.name ?? person.username ?? person.claims.email ?? person.sub;
  const detail = person.claims.email ?? person.username;
  const option = (value: string, label: string, checked: boolean) =>
    `<label><input type="radio" name="account" value="${escapeHtml(value)}"${checked ? ' checked' : ''}> ${escapeHtml(label)}</label>`;

  return page(
    'Choose an account',
    `<h1>Choose an account</h1>
<p class="who">Signed in as <strong>${escapeHtml(who)}</strong>${detail && detail !== who ? ` (${escapeHtml(detail)})` : ''}</p>
<form method="post" action="${escapeHtml(opts.action)}">
<input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">
<fieldset>
<legend>Continue as</legend>
${option(PERSONAL_CHOICE, `${who} (yourself)`, true)}
${opts.targets.map((t) => option(t.id, t.label, false)).join('\n')}
</fieldset>
<button type="submit">Continue</button>
</form>
<p class="note">Picking another account signs you in as that account. Your choice is recorded under your name.</p>`,
  );
}

/** A short message page: no internal details, nothing to retry from here. */
export function messagePage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
fieldset{border:1px solid #ccc;border-radius:.5rem;padding:.75rem 1rem;margin:1rem 0}
label{display:block;padding:.4rem 0;cursor:pointer}
button{font:inherit;padding:.5rem 1.25rem;border-radius:.4rem;border:1px solid #444;background:#222;color:#fff;cursor:pointer}
.note{color:#666;font-size:.875rem}
</style></head>
<body>${body}</body></html>`;
}

export function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
