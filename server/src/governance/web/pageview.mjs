/**
 * web/pageview.mjs — "the page as it will be written", for the review page.
 *
 *   pageText   a page's Markdown source shown as text: headings by style,
 *              lists as lines, citations as small chips. Markdown is not
 *              rendered, and nothing in the text is ever read as HTML.
 *   diffView   a parsed diff, unified or split, with unchanged stretches folded.
 *   metaList   the front matter as a short definition list.
 *
 * Every value goes through `html`, which escapes it.
 */
import matter from 'gray-matter';

import { normalizeSources, safeFrontmatter } from '../../../../tools/lib/wiki-core.mjs';
import { html } from '../html.mjs';

// Page text is agent-written: front matter is read as YAML only, never as code.
const parseFrontmatter = safeFrontmatter(matter);

/** Front matter and body of a page, or the whole text as the body when it cannot be read. */
export function splitPage(text) {
  try {
    const parsed = parseFrontmatter(String(text ?? ''));
    return { data: parsed.data || {}, body: parsed.content, ok: true };
  } catch {
    return { data: {}, body: String(text ?? ''), ok: false };
  }
}

const list = (v) => (Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)]);

/** The details of a page worth reading before its body. */
export function metaList(data, { tier = '' } = {}) {
  const tags = list(data.tags);
  const aliases = list(data.aliases);
  const sources = normalizeSources(data.sources);
  const row = (label, value) => (value ? html`<dt>${label}</dt><dd>${value}</dd>` : '');
  return html`<dl class="al-dl al-docmeta">
    ${row('Title', data.title == null ? '' : String(data.title))}
    ${row('Type', data.type == null ? '' : String(data.type))}
    ${row('Tier', tier || (data.tier == null ? '' : String(data.tier)))}
    ${row('Confidence', data.confidence == null ? '' : String(data.confidence))}
    ${tags.length ? html`<dt>Tags</dt><dd>${tags.join(', ')}</dd>` : ''}
    ${aliases.length ? html`<dt>Also known as</dt><dd>${aliases.join(', ')}</dd>` : ''}
    ${sources.length ? html`<dt>Sources</dt><dd><ul class="al-docmeta__sources" role="list">${sources.map((s) => html`<li>${s.id ? html`<span class="al-code">${s.id}</span> ` : ''}${s.title || s.path || ''}${s.title && s.path ? html` <span class="al-text-tertiary">${s.path}</span>` : ''}</li>`)}</ul></dd>` : ''}
  </dl>`;
}

// ── the body as text ─────────────────────────────────────────────────────────

const INLINE = /\[source:([^\]]*)\]|\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

/**
 * Text with its `[source: id, locator]` markers as small chips and its
 * `[[wikilinks]]` as their text. The chip says only the locator when the page
 * has one source, and "id · locator" when it has more; the source's title is
 * in its `title`. Every piece is escaped.
 */
function inline(text, ctx) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    out.push(html`${text.slice(last, m.index)}`);
    if (m[1] !== undefined) {
      const inner = m[1].trim();
      const comma = inner.indexOf(',');
      const id = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      const loc = comma < 0 ? '' : inner.slice(comma + 1).trim();
      const label = ctx.single ? (loc || id) : (loc ? `${id} · ${loc}` : id);
      out.push(html`<span class="al-cite" title="${ctx.titles.get(id) || inner}">${label}</span>`);
    } else {
      const slug = m[2].trim();
      out.push(html`<span class="al-wikilink" title="${slug}">${(m[3] || slug).trim()}</span>`);
    }
    last = m.index + m[0].length;
  }
  out.push(html`${text.slice(last)}`);
  return html`${out}`;
}

const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const ALIGN = /^:?-{1,}:?$/;

/** A pipe table as a real table, or null when it is not a well-formed one (then its lines stay plain text). */
function tableOf(lines, ctx) {
  if (lines.length < 2) return null;
  const head = cellsOf(lines[0]);
  const rule = cellsOf(lines[1]);
  if (head.length < 1 || rule.length !== head.length || !rule.every((c) => ALIGN.test(c))) return null;
  const rows = lines.slice(2).map(cellsOf);
  return html`<div class="al-doc__tablewrap"><table class="al-doctable">
    <thead><tr>${head.map((c) => html`<th scope="col">${inline(c, ctx)}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr>${r.map((c) => html`<td>${inline(c, ctx)}</td>`)}</tr>`)}</tbody>
  </table></div>`;
}

/**
 * The Markdown source of a page body as readable text. Blocks are found by
 * the shape of their first characters only; nothing is rendered as HTML.
 * `titles` maps a source id to its title; `single` is true when the page has
 * one source.
 */
export function pageText(body, { titles = new Map(), single = false, removed = false } = {}) {
  const ctx = { titles, single };
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let fence = '';
  const flush = () => { if (para.length) { blocks.push(html`<p class="al-doc__p">${inline(para.join(' '), ctx)}</p>`); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.trim().match(/^(```|~~~)/);
    if (f) {
      flush();
      if (!fence) fence = f[1]; else if (fence === f[1]) fence = '';
      blocks.push(html`<div class="al-doc__code">${line}</div>`);
      continue;
    }
    if (fence) { blocks.push(html`<div class="al-doc__code">${line}</div>`); continue; }
    if (line.trim() === '') { flush(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); blocks.push(html`<div class="al-doc__h al-doc__h--${Math.min(h[1].length, 4)}">${inline(h[2], ctx)}</div>`); continue; }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flush();
      const depth = Math.min(Math.floor(li[1].replace(/\t/g, '  ').length / 2), 4);
      blocks.push(html`<div class="al-doc__li al-doc__li--${depth}"><span class="al-doc__bullet" aria-hidden="true">${/^\d/.test(li[2]) ? li[2] : '•'}</span><span>${inline(li[3], ctx)}</span></div>`);
      continue;
    }
    if (line.trim().startsWith('|')) {
      flush();
      const run = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) run.push(lines[i++]);
      i--;
      const table = tableOf(run, ctx);
      if (table) blocks.push(table);
      else for (const r of run) blocks.push(html`<div class="al-doc__row">${inline(r.trim(), ctx)}</div>`);
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return html`<div class="al-doc${removed ? ' al-doc--removed' : ''}">${blocks}</div>`;
}

// ── what changed in a page's details ─────────────────────────────────────────

const dateOr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v));
const unlink = (s) => String(s).replace(/^\[\[|\]\]$/g, '').split(/[|#]/)[0].trim();
const SCALARS = [['title', 'Title'], ['type', 'Page type'], ['tier', 'Tier'], ['status', 'Status'], ['confidence', 'Confidence'], ['owner', 'Owner team'], ['origin', 'Origin'],
  ['date_created', 'Date created'], ['date_modified', 'Date last changed'], ['last_verified', 'Date last checked']];
const LISTS = [['tags', 'Tag'], ['aliases', 'Also known as']];
const RELATIONS = { supports: ['Now supports', 'No longer supports'], contradicts: ['Now contradicts', 'No longer contradicts'], supersedes: ['Now replaces', 'No longer replaces'], depends_on: ['Now depends on', 'No longer depends on'] };

/** The sentences that say what changed in a page's details, from its parsed front matter before and after. */
export function detailChanges(before, after) {
  const out = [];
  for (const [key, label] of SCALARS) {
    const a = dateOr(before[key]);
    const b = dateOr(after[key]);
    if (a === b) continue;
    out.push(!a ? `${label} set to “${b}”` : !b ? `${label} removed (it was “${a}”)` : `${label} changed from “${a}” to “${b}”`);
  }
  const diffList = (x, y) => [list(y).filter((v) => !list(x).includes(v)), list(x).filter((v) => !list(y).includes(v))];
  for (const [key, label] of LISTS) {
    const [added, removed] = diffList(before[key], after[key]);
    for (const v of added) out.push(`${label} added: ${v}`);
    for (const v of removed) out.push(`${label} removed: ${v}`);
  }
  const name = (s) => s.title || s.path || s.id;
  const keyOf = (s) => s.id || s.path;
  const bs = normalizeSources(before.sources);
  const as = normalizeSources(after.sources);
  for (const s of as) if (!bs.some((o) => keyOf(o) === keyOf(s))) out.push(`Source added: ${name(s)}`);
  for (const s of bs) if (!as.some((o) => keyOf(o) === keyOf(s))) out.push(`Source removed: ${name(s)}`);
  const [relAdded, relRemoved] = diffList(list(before.related).map(unlink), list(after.related).map(unlink));
  for (const v of relAdded) out.push(`Related page added: ${v}`);
  for (const v of relRemoved) out.push(`Related page removed: ${v}`);
  for (const [key, [on, off]] of Object.entries(RELATIONS)) {
    const [added, removed] = diffList(list(before.relations?.[key]).map(unlink), list(after.relations?.[key]).map(unlink));
    for (const v of added) out.push(`${on}: ${v}`);
    for (const v of removed) out.push(`${off}: ${v}`);
  }
  return out;
}

// ── a diff ───────────────────────────────────────────────────────────────────

function parts(line, kind) {
  if (!line.parts) return html`${line.text}`;
  const cls = kind === 'add' ? 'al-diff__ins' : 'al-diff__rem';
  const tag = (t) => (kind === 'add' ? html`<ins class="${cls}">${t}</ins>` : html`<del class="${cls}">${t}</del>`);
  return html`${line.parts.map((p) => (p.changed ? tag(p.text) : html`${p.text}`))}`;
}

function codeCell(line) {
  const notes = [
    line.cut ? html` <span class="al-diff__eol">(the rest of this long line is not shown)</span>` : '',
    line.noEol ? html` <span class="al-diff__eol">(no newline at end of file)</span>` : '',
  ];
  return html`<span class="al-diff__code">${parts(line, line.type)}${notes}</span>`;
}

const ln = (n) => html`<span class="al-diff__ln">${n ?? ''}</span>`;

function unifiedLine(line, extra = '') {
  const cls = line.type === 'add' ? 'al-diff__line--add' : line.type === 'del' ? 'al-diff__line--del' : 'al-diff__line--ctx';
  return html`<div class="al-diff__line ${cls}${extra}">${ln(line.oldNo)}${ln(line.newNo)}${codeCell(line)}</div>`;
}

function splitSide(line, side, twin = false) {
  if (!line) return html`<div class="al-diff__line al-diff__line--empty"><span class="al-diff__ln"></span><span class="al-diff__code"></span></div>`;
  const cls = line.type === 'add' ? 'al-diff__line--add' : line.type === 'del' ? 'al-diff__line--del' : 'al-diff__line--ctx';
  return html`<div class="al-diff__line ${cls}${twin ? ' al-diff__line--twin' : ''}">${ln(side === 'left' ? line.oldNo : line.newNo)}${codeCell(line)}</div>`;
}

function hunkRowsHtml(rows, mode) {
  if (mode === 'split') {
    return rows.map((r) => html`<div class="al-diff__row">${splitSide(r.left, 'left')}${splitSide(r.right, 'right', r.left === r.right)}</div>`);
  }
  const out = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].left && rows[i].left === rows[i].right) { out.push(unifiedLine(rows[i].left)); i++; continue; }
    const dels = [];
    const adds = [];
    while (i < rows.length && !(rows[i].left && rows[i].left === rows[i].right)) {
      if (rows[i].left) dels.push(rows[i].left);
      if (rows[i].right) adds.push(rows[i].right);
      i++;
    }
    for (const l of dels) out.push(unifiedLine(l));
    for (const l of adds) out.push(unifiedLine(l));
  }
  return out;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function foldHtml(item, mode) {
  if (!item.lines) {
    return html`<div class="al-diff__fold al-diff__fold--static">${plural(item.count, 'unchanged line')}, not shown because the page is large</div>`;
  }
  const rows = item.lines.map((l) => ({ left: l, right: l }));
  return html`<details class="al-diff__fold"><summary>${plural(item.count, 'unchanged line')}</summary>${hunkRowsHtml(rows, mode)}</details>`;
}

/**
 * @param {Array} items  layoutDiff() output
 * @param {'unified'|'split'} mode
 */
export function diffView(items, mode, label) {
  return html`<div class="al-diff${mode === 'split' ? ' al-diff--split' : ''}" role="group" aria-label="${label}">
    ${items.map((it) => (it.kind === 'fold'
      ? foldHtml(it, mode)
      : html`<div class="al-diff__hunk">${it.empty ? 'No lines changed here' : `From line ${it.newStart || it.oldStart}`}${it.header ? html` · ${it.header}` : ''}</div>${hunkRowsHtml(it.rows, mode)}`))}
  </div>`;
}
