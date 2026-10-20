/**
 * claims.mjs — a page body as a list of claims, and the difference between two.
 *
 * A claim is a sentence, bullet or table row that carries at least one
 * `[source: …]` citation. That is the unit a reviewer judges: "is this fact
 * true, and does the source say so?" — not "is this diff hunk fine?".
 *
 * Block structure comes from wiki-core's parseBody (paragraphs and list
 * items); citations from its parseCitation. Tables are read here, because
 * parseBody deliberately skips them and a table row with a Source column is
 * still a fact.
 */
import { parseBody, parseCitation } from '../../../tools/lib/wiki-core.mjs';

const CITATION = /\[source:([^\]]*)\]/g;
const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

/** Display form: no citation markers, wikilinks as their label, tidy spacing. */
export function cleanText(text) {
  return String(text)
    .replace(CITATION, ' ')
    .replace(WIKILINK, (_m, target, label) => String(label ?? target).trim())
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?)])/g, '$1')
    .replace(/^[\s.,;:]+/, '')
    .trim();
}

/** Comparison form: lowercase word tokens. */
export function tokens(text) {
  return cleanText(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function citationsIn(text) {
  const out = [];
  CITATION.lastIndex = 0;
  let m;
  while ((m = CITATION.exec(text)) !== null) {
    const c = parseCitation(m[1]);
    out.push({ index: m.index, end: m.index + m[0].length, ...(c.ok ? { id: c.id, locator: c.locator, date: c.date } : { id: c.id || '', locator: '', invalid: true }) });
  }
  return out;
}

const cite = (c) => ({ id: c.id, locator: c.locator || '', ...(c.date ? { date: c.date } : {}) });

/**
 * Split a paragraph into claims: each run of citations closes the text before
 * it. "A. [source: x, p.1] B. [source: y, p.2]" → two claims.
 */
function paragraphClaims(block) {
  const text = block.text;
  const cites = citationsIn(text);
  const out = [];
  let start = 0;
  let i = 0;
  while (i < cites.length) {
    const run = [cites[i]];
    while (i + 1 < cites.length && /^[\s,;]*$/.test(text.slice(cites[i].end, cites[i + 1].index))) run.push(cites[++i]);
    const segment = text.slice(start, run[0].index);
    // A full stop written after the citation belongs to the claim it closes.
    let end = run[run.length - 1].end;
    const tail = text.slice(end).match(/^\s*[.,;:]/);
    if (tail) end += tail[0].length;
    let clean = cleanText(segment);
    if (tail && /[.!?]/.test(tail[0]) && clean && !/[.!?]$/.test(clean)) clean += tail[0].trim();
    if (clean && /[\p{L}\p{N}]/u.test(clean)) {
      out.push({ text: clean, citations: run.map(cite), section: block.section, line: block.line });
    } else if (out.length) {
      out[out.length - 1].citations.push(...run.map(cite));
    }
    start = end;
    i++;
  }
  return out;
}

function tableClaims(body) {
  const out = [];
  let fence = '';
  let section = '';
  String(body).split('\n').forEach((line, i) => {
    const t = line.trim();
    const f = t.match(/^(```|~~~)/);
    if (f) { if (!fence) fence = f[1]; else if (fence === f[1]) fence = ''; return; }
    if (fence) return;
    const h = t.match(/^(#{1,2})\s+(.*)$/);
    if (h) { section = h[2].trim(); return; }
    if (!t.startsWith('|') || !t.includes('[source:')) return;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const cites = citationsIn(t);
    const text = cells.filter((c) => !/^\[source:[^\]]*\]$/.test(c)).map(cleanText).filter(Boolean).join(' · ');
    if (text) out.push({ text, citations: cites.map(cite), section, line: i + 1, table: true });
  });
  return out;
}

/** Every claim on a page body, in document order. */
export function extractClaims(body) {
  const claims = [];
  for (const block of parseBody(body)) {
    if (!block.text.includes('[source:')) continue;
    if (block.kind === 'list-item') {
      const cites = citationsIn(block.text);
      const text = cleanText(block.text);
      if (text) claims.push({ text, citations: cites.map(cite), section: block.section, line: block.line });
    } else {
      claims.push(...paragraphClaims(block));
    }
  }
  claims.push(...tableClaims(body));
  return claims.sort((a, b) => a.line - b.line);
}

const citeKey = (c) => (c.citations || []).map((x) => `${x.id}@${x.locator}`).join('|');
const textKey = (c) => tokens(c.text).join(' ');

/** Dice coefficient over word bigrams (words for very short claims). */
export function similarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const grams = (t) => (t.length < 2 ? t : t.slice(1).map((w, i) => `${t[i]} ${w}`));
  const ga = grams(ta);
  const gb = grams(tb);
  const counts = new Map();
  for (const g of ga) counts.set(g, (counts.get(g) || 0) + 1);
  let hits = 0;
  for (const g of gb) {
    const n = counts.get(g) || 0;
    if (n > 0) { hits++; counts.set(g, n - 1); }
  }
  return (2 * hits) / (ga.length + gb.length);
}

function sameFirstCitation(a, b) {
  const x = a.citations?.[0];
  const y = b.citations?.[0];
  return Boolean(x && y && x.id === y.id && x.locator === y.locator);
}

function claimOut(op, c, before) {
  const out = { op, text: c.text, section: c.section || '' };
  if (before) {
    out.before = before.text;
    if (citeKey(before) !== citeKey(c)) out.beforeCitation = before.citations?.[0] ? { ...before.citations[0] } : null;
  }
  if (c.citations?.length) {
    out.citation = { ...c.citations[0] };
    if (c.citations.length > 1) out.citations = c.citations.map((x) => ({ ...x }));
  }
  return out;
}

/**
 * Claim-level diff. Unchanged claims are dropped; what is left is pairs that
 * changed, and claims that only exist on one side.
 *
 * Pairing, in order: identical text with a different citation; then the most
 * similar remaining pair (a shared citation lowers the bar, because "same
 * source, same spot, reworded" is the common revision).
 */
export function diffClaims(before = [], after = []) {
  const B = before.map((c, i) => ({ c, i, used: false }));
  const A = after.map((c, i) => ({ c, i, pair: null, same: false }));

  for (const a of A) {
    const hit = B.find((b) => !b.used && textKey(b.c) === textKey(a.c) && citeKey(b.c) === citeKey(a.c));
    if (hit) { hit.used = true; a.same = true; }
  }
  for (const a of A) {
    if (a.same) continue;
    const hit = B.find((b) => !b.used && textKey(b.c) === textKey(a.c));
    if (hit) { hit.used = true; a.pair = hit; }
  }
  const candidates = [];
  for (const a of A) {
    if (a.same || a.pair) continue;
    for (const b of B) {
      if (b.used) continue;
      const shared = sameFirstCitation(a.c, b.c);
      const score = similarity(a.c.text, b.c.text) + (shared ? 0.15 : 0);
      if (score >= (shared ? 0.3 : 0.5)) candidates.push({ a, b, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  for (const { a, b } of candidates) {
    if (a.pair || b.used) continue;
    a.pair = b;
    b.used = true;
  }

  const out = [];
  for (const a of A) {
    if (a.same) continue;
    out.push(a.pair ? claimOut('change', a.c, a.pair.c) : claimOut('add', a.c));
  }
  for (const b of B) if (!b.used) out.push(claimOut('remove', b.c));
  return out;
}
