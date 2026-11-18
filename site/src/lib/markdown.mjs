/**
 * The one place the site configures `marked`.
 *
 * Wiki pages are Markdown. An agent writes them from sources nobody has read
 * yet, so a page may carry raw HTML: a `<script>`, an `onerror` attribute, an
 * open `<details>` or `<div hidden>` that swallows every section after it.
 * Pages have no need for any of it. This renderer shows raw HTML from a page
 * as visible text, and drops a link or an image whose address is
 * `javascript:`, `vbscript:` or `data:`.
 *
 * One kind of HTML is the site's own: `tools/lib/wiki-core.mjs` rewrites each
 * `[[wikilink]]` into an `<a class="wikilink" href="/page/">` (or a
 * `<span class="wikilink is-broken" title="…">` when the page does not exist)
 * before the Markdown is rendered. Exactly those two opening tags pass, with
 * their matching closing tag, and nothing else does: the text between them is
 * the page's own and goes through the same rules as the rest of the page.
 *
 * Plain `.mjs`, so a test under bare Node can import it.
 */
import { Marked, Tokenizer } from 'marked';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeText = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** The opening tags wiki-core writes for a wikilink, and nothing wider. */
const WIKILINK_OPEN = [
  { tag: 'a', re: /^<a class="wikilink" href="\/(?!\/)[^"<>\s'`\\]*">$/ },
  { tag: 'span', re: /^<span class="wikilink is-broken" title="No page named [^"<>]*">$/ },
];

const NAMED = { colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')', sol: '/', period: '.', comma: ',' };

/** The scheme a browser would read from `href`, after the tricks it tolerates: entities, control characters, case. */
function schemeOf(href) {
  let s = String(href ?? '');
  for (let i = 0; i < 3; i++) {
    const next = s
      .replace(/&#x([0-9a-f]+);?/gi, (_m, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10FFFF)))
      .replace(/&#(\d+);?/g, (_m, d) => String.fromCodePoint(Math.min(Number(d), 0x10FFFF)))
      .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
    let decoded = next;
    try { decoded = decodeURIComponent(next); } catch { /* not percent-encoded */ }
    if (decoded === s) break;
    s = decoded;
  }
  s = s.replace(/[\u0000-\u0020\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, '').toLowerCase();
  const m = /^([a-z][a-z0-9+.-]*):/.exec(s);
  return m ? m[1] : '';
}

/** False for an address that runs script or carries a document: `javascript:`, `vbscript:`, `data:`. */
export function isSafeUrl(href) {
  return !['javascript', 'vbscript', 'data'].includes(schemeOf(href));
}

let open = [];   // the wikilink tags opened and not yet closed in this render

const marked = new Marked({
  async: false,
  tokenizer: {
    // CommonMark lets an HTML block of some kinds (`<script`, `<pre`, `<style`,
    // `<textarea`, `<?`, `<!x`, `<![CDATA[`) run to the end of the page, past
    // blank lines. Raw HTML is only text here, so a block is one line: what
    // follows it is Markdown again and cannot be swallowed.
    html(src) {
      const token = Tokenizer.prototype.html.call(this, src);
      if (!token) return token;
      const newline = token.raw.indexOf('\n');
      if (newline === -1 || newline === token.raw.length - 1) return token;
      const first = token.raw.slice(0, newline + 1);
      return { ...token, raw: first, text: first.replace(/\s+$/, '') };
    },
  },
  renderer: {
    html({ text, block }) {
      if (block) return `<p class="raw-html">${escapeText(String(text).replace(/\s+$/, ''))}</p>\n`;
      const tag = String(text);
      const opener = WIKILINK_OPEN.find((o) => o.re.test(tag));
      if (opener) { open.push(opener.tag); return tag; }
      const closer = /^<\/(a|span)>$/.exec(tag);
      if (closer && open[open.length - 1] === closer[1]) { open.pop(); return tag; }
      return escapeText(tag);
    },
    // A link or image the browser would run is dropped: the link keeps its text, the image its alt text.
    link(token) {
      return isSafeUrl(token.href) ? false : this.parser.parseInline(token.tokens);
    },
    image(token) {
      return isSafeUrl(token.href) ? false : escapeText(token.text);
    },
  },
});

/** Markdown to HTML for a wiki page body. */
export function renderMarkdown(markdown) {
  open = [];
  try { return marked.parse(String(markdown ?? ''), { async: false }); }
  finally { open = []; }
}
