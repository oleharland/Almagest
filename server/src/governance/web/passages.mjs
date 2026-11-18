/**
 * web/passages.mjs — facts next to the source passage they cite.
 *
 * Two jobs, both pure:
 *
 *   groupClaims   consecutive facts that cite the same source and spot, and whose
 *                 excerpts overlap, become one group with one merged passage, so
 *                 a passage is printed once instead of once per fact.
 *   markPassage   the passage as HTML with the words that also occur in the
 *                 fact(s) wrapped in <mark>. Built from split pieces, each one
 *                 escaped by the `html` template. Never by editing escaped HTML.
 */
import { html } from '../html.mjs';
import { tokens } from '../claims.mjs';

// ── grouping ─────────────────────────────────────────────────────────────────

/** Shortest run of text two excerpts must share to count as the same passage. */
const MIN_OVERLAP = 24;

function strip(text) {
  let core = String(text).trim();
  const pre = core.startsWith('… ');
  const post = core.endsWith(' …');
  if (pre) core = core.slice(2);
  if (post) core = core.slice(0, -2);
  return { core, pre, post };
}

const flat = (s) => s.replace(/\s+/g, ' ').trim();

/** Join `a` and `b` when one holds the other or they overlap at an edge; otherwise null. */
function joinCores(a, b) {
  if (a.core.includes(b.core)) return a;
  if (b.core.includes(a.core)) return b;
  for (let k = Math.min(a.core.length, b.core.length) - 1; k >= MIN_OVERLAP; k--) {
    if (a.core.endsWith(b.core.slice(0, k))) return { core: a.core + b.core.slice(k), pre: a.pre, post: b.post };
    if (b.core.endsWith(a.core.slice(0, k))) return { core: b.core + a.core.slice(k), pre: b.pre, post: a.post };
  }
  return null;
}

/** One passage out of two overlapping ones, or null when they do not overlap. */
export function mergePassages(a, b) {
  const x = strip(a);
  const y = strip(b);
  let out = joinCores(x, y);
  if (!out) {
    // One side was cut with its line breaks turned into spaces.
    out = joinCores({ ...x, core: flat(x.core) }, { ...y, core: flat(y.core) });
  }
  if (!out) return null;
  return `${out.pre ? '… ' : ''}${out.core}${out.post ? ' …' : ''}`;
}

const spotOf = (c) => `${c?.id || ''}\u0000${c?.locator || ''}`;

/**
 * @param {Array} claims  a page's claims, in order
 * @returns {Array<{ citation, status, passage: string|null, items: Array<{ claim, index }> }>}
 */
export function groupClaims(claims) {
  const groups = [];
  claims.forEach((claim, index) => {
    const last = groups[groups.length - 1];
    if (last && last.passage !== null && claim.excerptStatus === 'found' && typeof claim.excerpt === 'string'
      && last.status === 'found' && spotOf(last.citation) === spotOf(claim.citation) && claim.citation?.id) {
      const merged = mergePassages(last.passage, claim.excerpt);
      if (merged !== null) {
        last.passage = merged;
        last.items.push({ claim, index });
        return;
      }
    }
    groups.push({
      citation: claim.citation || null,
      status: claim.excerptStatus || 'no-citation',
      passage: claim.excerptStatus === 'found' && typeof claim.excerpt === 'string' ? claim.excerpt : null,
      items: [{ claim, index }],
    });
  });
  return groups;
}

// ── supporting words ─────────────────────────────────────────────────────────

const STOPWORDS = new Set(`a about above after again all also am an and any are as at be because been before being below between both
but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is
it its itself just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the
their them then there these they this those through to too under until up very was we were what when where which while who whom why will
with would you your yours`.split(/\s+/));

const WORD = /[\p{L}\p{N}]+/gu;

/** The words of a fact that can tell a reader where in the passage it came from. */
export function factWords(text) {
  return new Set(tokens(text).filter((t) => !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t))));
}

const UNIT_STARTS = /^(\||#{1,6}\s|[-*+]\s|\d+[.)]\s)/;
const LONG_UNIT = 300;

/**
 * A passage as short units a person reads as one thing: each Markdown line
 * (a heading, a list item, a table row) is one, and prose is cut into sentences.
 * An excerpt that was flattened to one line is also cut at list dashes, bars and
 * headings, so a unit stays short enough to read.
 */
export function splitUnits(passage) {
  const text = String(passage).trim().replace(/^… /, '').replace(/ …$/, '');
  const units = [];
  const push = (t) => { const v = t.trim(); if (v) units.push(v); };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = UNIT_STARTS.test(t) ? [t] : t.split(/(?<=[.!?])\s+(?=\S)/);
    for (const part of parts) {
      if (part.length <= LONG_UNIT) { push(part); continue; }
      for (const piece of part.split(/(?<=[;:])\s+|\s+\|\s+|\s+(?=#{1,6}\s)|\s+-\s+(?=[A-Z0-9*])/)) push(piece);
    }
  }
  return units;
}

/** How many of the fact's words a unit shares. */
const shared = (unit, words) => new Set(tokens(unit).filter((t) => words.has(t))).size;

/** The start of a passage, for when nothing in it clearly matches. */
function opening(passage, max = 280) {
  const t = String(passage).trim().replace(/^… /, '');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).trimEnd()} …`;
}

/** The fewest words a sentence must share with a fact to count as its support. */
export const MIN_SHARED = 2;

/**
 * The part of a passage that supports one fact: the best sentence by shared
 * words, and its neighbours when they share some too (at most three in a row).
 * When no sentence shares at least MIN_SHARED words, nothing is claimed.
 * @returns {{ matched: boolean, html: object }}
 */
export function supportFor(passage, factText) {
  const words = factWords(factText);
  const units = splitUnits(passage);
  const scores = units.map((u) => shared(u, words));
  let best = -1;
  scores.forEach((n, i) => { if (n > (best < 0 ? 0 : scores[best])) best = i; });
  if (best < 0 || scores[best] < MIN_SHARED) return { matched: false, html: html`${opening(passage)}` };
  let lo = best;
  let hi = best;
  if (lo > 0 && scores[lo - 1] > 0) lo--;
  if (hi < units.length - 1 && scores[hi + 1] > 0 && hi - lo < 2) hi++;
  if (hi - lo < 2 && lo > 0 && scores[lo - 1] > 0) lo--;
  return { matched: true, html: markWords(units.slice(lo, hi + 1).join(' '), words) };
}

/**
 * `text` with each word in `words` wrapped in <mark>. Built from split pieces
 * through `html`, so nothing in the text can be read as markup. Words are
 * never bridged: two marks only join when nothing but spaces lies between.
 */
export function markWords(text, words) {
  const s = String(text);
  const hits = [...s.matchAll(WORD)].filter((m) => words.has(m[0].toLowerCase()));
  const out = [];
  let cursor = 0;
  let i = 0;
  while (i < hits.length) {
    let j = i;
    while (j + 1 < hits.length && /^\s+$/.test(s.slice(hits[j].index + hits[j][0].length, hits[j + 1].index))) j++;
    const start = hits[i].index;
    const end = hits[j].index + hits[j][0].length;
    out.push(html`${s.slice(cursor, start)}`, html`<mark>${s.slice(start, end)}</mark>`);
    cursor = end;
    i = j + 1;
  }
  out.push(html`${s.slice(cursor)}`);
  return html`${out}`;
}
