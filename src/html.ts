import { html, raw } from 'hono/html';

/**
 * HTML built with Hono's `html` tagged template, escaped by default:
 *
 *   html`<p>Signed in as ${name}</p>`
 *
 * Every `${}` value is HTML-escaped, unless it is itself made by `html` or `raw`. Arrays are
 * joined, and `null`, `undefined` and booleans render as nothing, so lists and conditionals read
 * naturally. Only `raw()` skips escaping, visibly: never pass it anything from a request or the SSO.
 */
export { html, raw };

/** What `html` returns. It is a Promise only when a value is one, which no page uses. */
export type Html = ReturnType<typeof html>;

/** The finished page as a string. */
export function renderHtml(page: Html): string {
  if (page instanceof Promise) throw new Error('pages are synchronous: no Promise may be interpolated');
  return page.toString();
}
