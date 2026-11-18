/**
 * The site shows raw HTML from a wiki page as text, drops script-running
 * links and images, and renders ordinary Markdown and wikilinks as before.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import matter from 'gray-matter';
import { marked } from 'marked';

import { loadWiki } from '../../tools/lib/wiki-core.mjs';
import { isSafeUrl, renderMarkdown } from '../src/lib/markdown.mjs';

const dirs = [];
after(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

const plain = (md) => marked.parse(md, { async: false });

describe('raw HTML in a page is shown as text', () => {
  const noTag = (html, tag) => assert.doesNotMatch(html, new RegExp(`<${tag}[\\s>/]`, 'i'), `${tag} must not be a tag in: ${html}`);

  it('a script tag, as a block and inside a line', () => {
    for (const md of ['<script>alert(1)</script>\n', 'Text <script>alert(1)</script> more.\n', 'Text\n\n<script src="//evil.test/x.js"></script>\n']) {
      const html = renderMarkdown(md);
      noTag(html, 'script');
      assert.match(html, /&lt;script/);
    }
  });

  it('an event handler attribute', () => {
    for (const md of ['<img src=x onerror=alert(1)>\n', 'Text <img src=x onerror=alert(1)> more.\n', '<a href="/x" onclick="alert(1)">x</a>\n', '<svg onload=alert(1)>\n']) {
      const html = renderMarkdown(md);
      noTag(html, 'img');
      noTag(html, 'svg');
      assert.doesNotMatch(html, /<a [^>]*onclick/);
      assert.match(html, /onerror=alert\(1\)|onclick=|onload=/);
    }
  });

  it('an unclosed <details> or <div hidden> does not swallow what follows', () => {
    for (const open of ['<details>', '<div hidden>', '<details open>', '<style>', '<textarea>', '<iframe src="//x">']) {
      const html = renderMarkdown(`## Before\n\ntext\n\n${open}\n\n## Later section\n\nAdded later.\n`);
      assert.match(html, /<h2[^>]*>Later section<\/h2>/, open);
      assert.doesNotMatch(html, /<(details|div|style|textarea|iframe)[\s>]/i, open);
      assert.match(html, /&lt;/);
    }
  });

  it('a style or script block that runs to the end of the text still ends as text', () => {
    const html = renderMarkdown('## A\n\n<style>\nbody { display: none }\n');
    noTag(html, 'style');
    assert.match(html, /display: none/);
  });

  it('an HTML comment, closed or not', () => {
    for (const md of ['<!-- hidden note -->\n\ntext\n', 'Text <!-- inline --> more\n', '<!--\nunclosed\n\n## Later\n']) {
      const html = renderMarkdown(md);
      assert.doesNotMatch(html, /<!--/);
      assert.match(html, /&lt;!--/);
    }
  });

  it('text inside the HTML stays visible, escaped', () => {
    const html = renderMarkdown('<b>bold</b> and <i onmouseover=x>it</i>\n');
    assert.doesNotMatch(html, /<b>|<i /);
    assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/);
  });
});

describe('links and images that run script are dropped', () => {
  const bad = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', '&#106;avascript:alert(1)', '&#x6A;avascript:alert(1)', 'jav&Tab;ascript:alert(1)',
    'vbscript:msgbox(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'DATA:text/html,<b>x</b>', '%6Aavascript:alert(1)', ' javascript:alert(1)',
  ];
  for (const url of bad) {
    it(`link ${JSON.stringify(url)}`, () => {
      const html = renderMarkdown(`[click me](${url.replace(/ /g, '%20').startsWith('%20') ? url.trim() : url})\n`);
      assert.doesNotMatch(html, /<a[\s>]/);
      assert.doesNotMatch(html, /href=/);
      assert.match(html, /click me/);
    });
  }
  it('an image, a reference-style link and an autolink', () => {
    assert.doesNotMatch(renderMarkdown('![alt text](javascript:alert(1))\n'), /<img|src=/);
    assert.match(renderMarkdown('![alt text](javascript:alert(1))\n'), /alt text/);
    assert.doesNotMatch(renderMarkdown('![a](data:image/svg+xml;base64,PHN2Zz4=)\n'), /<img/);
    const ref = renderMarkdown('[click][1]\n\n[1]: javascript:alert(1)\n');
    assert.doesNotMatch(ref, /<a[\s>]|href=/);
    assert.doesNotMatch(renderMarkdown('<javascript:alert(1)>\n'), /<a[\s>]|href=/);
  });
  it('ordinary addresses pass', () => {
    for (const url of ['https://example.com/a?b=1', 'http://example.com', '/relative/page/', '../up.md', '#anchor', 'mailto:a@b.test', 'tel:+123', 'page.md', 'ftp://host/x']) {
      assert.equal(isSafeUrl(url), true, url);
    }
    assert.match(renderMarkdown('[ok](https://example.com/a)\n'), /<a href="https:\/\/example.com\/a">ok<\/a>/);
    assert.match(renderMarkdown('![pic](/img/a.png "T")\n'), /<img src="\/img\/a.png" alt="pic" title="T">/);
  });
});

describe('ordinary Markdown renders exactly as before', () => {
  const samples = {
    headings: '# One\n\n## Two\n\n### Three\n',
    emphasis: 'Some *emphasis*, **strong**, ~~strike~~ and `code`.\n',
    lists: '- a\n- b\n  - c\n\n1. one\n2. two\n',
    tasks: '- [ ] open\n- [x] done\n',
    table: '| A | B |\n|---|:-:|\n| 1 | 2 |\n| `x` | [l](https://example.com) |\n',
    code: '```js\nconst a = 1 < 2 && b > 3;\n```\n\n    indented code\n',
    quote: '> quoted\n> text\n\n---\n',
    links: '[site](https://example.com "T") and <https://example.com/auto> and https://bare.example.com\n',
    image: '![alt](/img/a.png)\n',
    entities: 'AT&T &amp; &lt;b&gt; 5 < 6 and 7 > 3\n',
    citation: 'The service retries three times. [source: alpha-pdf, p.3]\n',
    breaks: 'line one  \nline two\n',
    footnote: 'Text with a [bracket] and a (paren).\n',
  };
  for (const [name, md] of Object.entries(samples)) {
    it(name, () => assert.equal(renderMarkdown(md), plain(md)));
  }
});

describe('wikilinks are rendered as the site always did', () => {
  function wiki(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-md-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'brain', 'wiki'), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(root, 'brain', 'wiki', `${name}.md`), `---\ntitle: ${name}\ntype: topic\ntier: curated\n---\n\n${body}\n`);
    }
    return loadWiki({ repoRoot: root, matter, wikiDirs: [{ name: 'brain', prefix: '', dir: 'brain/wiki' }], render: renderMarkdown, onWarn: () => {} }).pages;
  }
  const html = (pages, slug) => pages.find((p) => p.slug === slug).html;

  it('a link, a labelled link and a broken link keep their markup', () => {
    const pages = wiki({ foo: 'See [[bar]], [[bar|the bar page]] and [[nope]].', bar: 'Bar.' });
    const out = html(pages, 'foo');
    assert.match(out, /<a class="wikilink" href="\/bar\/">bar<\/a>/);
    assert.match(out, /<a class="wikilink" href="\/bar\/">the bar page<\/a>/);
    assert.match(out, /<span class="wikilink is-broken" title="No page named &quot;nope&quot;">nope<\/span>/);
  });

  it('a wikilink on its own line, in a list and in a table', () => {
    const pages = wiki({ foo: '[[bar]]\n\n- [[bar]]\n\n| A |\n|---|\n| [[bar]] |', bar: 'Bar.' });
    const out = html(pages, 'foo');
    assert.equal((out.match(/<a class="wikilink" href="\/bar\/">bar<\/a>/g) || []).length, 3, out);
  });

  it('a label that carries HTML stays text, and a stray closing tag stays text', () => {
    const pages = wiki({ foo: '[[bar|<img src=x onerror=alert(1)>]] and </a><script>alert(2)</script>', bar: 'Bar.' });
    const out = html(pages, 'foo');
    assert.doesNotMatch(out, /<img|<script/);
    assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(out, /&lt;\/a&gt;/);
    assert.equal((out.match(/<a /g) || []).length, 1);
  });

  it('a hand-written lookalike with another address is text', () => {
    const out = renderMarkdown('<a class="wikilink" href="//evil.test/">x</a> <a class="wikilink" href="/ok/" onclick="x()">y</a>\n');
    assert.doesNotMatch(out, /<a /);
  });
});
