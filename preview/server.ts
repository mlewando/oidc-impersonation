import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { html, renderHtml } from '../src/html.ts';
import { PAGE_HEADERS } from '../src/pages.ts';
import { scenarios } from './scenarios.ts';

// `pnpm preview`: every page the Bridge renders, with sample data, at http://localhost:4173.
// No Bridge, Valkey or SSO needed. Runs under `node --watch`, so saving a page restarts this server
// and the open page reloads itself.

const port = Number(process.env.PREVIEW_PORT ?? 4173);

/**
 * The page with the Bridge's own headers, plus 1 script (allowed by nonce) that reloads it after
 * a restart. Anything else the page tries to load is blocked exactly as in production.
 */
function sendPage(res: ServerResponse, page: string) {
  const nonce = randomBytes(16).toString('base64');
  const csp = `${PAGE_HEADERS['content-security-policy']}; script-src 'nonce-${nonce}'; connect-src 'self'`;
  const reload = `<script nonce="${nonce}">
new EventSource('/__reload').onerror = function () {
  this.close();
  (function retry() { fetch('/__ping').then(() => location.reload(), () => setTimeout(retry, 200)); })();
};
</script>`;
  res
    .writeHead(200, { ...PAGE_HEADERS, 'content-security-policy': csp, 'content-type': 'text/html; charset=utf-8' })
    .end(page.replace('</body>', `${reload}</body>`));
}

function index() {
  return renderHtml(html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Bridge pages</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.6}
code{color:#666}</style></head>
<body><h1>Bridge pages</h1>
<p>Sample data lives in <code>preview/scenarios.ts</code>; the pages in <code>src/pages.ts</code>.</p>
<ul>${scenarios.map((s) => html`<li><a href="/${s.path}">${s.title}</a> <code>/${s.path}</code></li>`)}</ul>
</body></html>`);
}

/** What a form on a preview page would have sent. */
async function posted(req: IncomingMessage) {
  let body = '';
  for await (const chunk of req) body += chunk;
  const fields = [...new URLSearchParams(body)];
  return renderHtml(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Posted</title></head>
<body style="font-family:system-ui,sans-serif;margin:3rem auto;max-width:28rem">
<h1>Posted to ${req.url}</h1>
<ul>${fields.map(([k, v]) => html`<li><code>${k}</code> = <code>${v}</code></li>`)}</ul>
<p><a href="/">All pages</a></p></body></html>`);
}

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://preview').pathname.replace(/^\/|\/$/g, '');
  if (path === '__ping') return res.writeHead(204).end();
  if (path === '__reload') {
    // Held open until this process restarts; the page reloads when it drops.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }).write(': open\n\n');
    return;
  }
  if (req.method === 'POST') return sendPage(res, await posted(req));
  if (path === '') return sendPage(res, index());

  const scenario = scenarios.find((s) => s.path === path);
  if (!scenario) return res.writeHead(404, { 'content-type': 'text/plain' }).end('No such page. See /');
  sendPage(res, scenario.render());
}).listen(port, '127.0.0.1', () => {
  console.log(`Bridge pages: http://localhost:${port}`);
});
