import { describe, expect, it } from 'vitest';
import { html, raw, renderHtml } from '../src/html.ts';

// The guarantees the pages rely on from hono/html.
describe('html', () => {
  it('escapes every interpolated value', () => {
    const name = `<script>alert("x")</script> & 'y'`;
    expect(renderHtml(html`<p title="${name}">${name}</p>`)).toBe(
      '<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;">' +
        '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;</p>',
    );
  });

  it('nests html without escaping it twice, and escapes each array item', () => {
    const items = ['a<', 'b'].map((i) => html`<li>${i}</li>`);
    expect(renderHtml(html`<ul>${items}${['<c>']}</ul>`)).toBe('<ul><li>a&lt;</li><li>b</li>&lt;c&gt;</ul>');
  });

  it('renders null, undefined and false as nothing, so conditions read naturally', () => {
    const none = undefined;
    expect(renderHtml(html`a${null}b${none}c${false && html`<x>`}d`)).toBe('abcd');
    expect(renderHtml(html`${0} ${''}`)).toBe('0 ');
  });

  it('inserts raw markup only when asked to', () => {
    expect(renderHtml(html`${raw('<br>')}${'<br>'}`)).toBe('<br>&lt;br&gt;');
  });

  it('refuses a Promise value instead of rendering it later', () => {
    expect(() => renderHtml(html`${Promise.resolve('x')}`)).toThrow(/synchronous/);
  });
});
