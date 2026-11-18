/**
 * passages.mjs — source text → ranked, budgeted passages. Pure functions, no I/O.
 *
 * Live lookup answers from text that is not a reviewed wiki page: committed
 * sidecars, staged connector snapshots, documents fetched on a miss. All of it
 * carries the locator markers the ingest rules and `connectors/render.mjs`
 * write (`=== page 3 ===`, `=== section: Failover ===`, `=== row 14 ===`,
 * `=== slide 2 ===`, `=== t 00:14:32 ===`), each alone on its own line. This
 * file splits on them, ranks the pieces with the same lexical scoring as
 * `search.mjs` (BM25 over fields, title above body), and packs the best into a
 * token budget the way `packSections` in `tools.mjs` packs wiki sections.
 *
 * A line that merely looks like a marker was neutralised on the way in (a
 * leading backslash), so it is not a marker here either: it stays text. That is
 * what stops fetched content from forging a locator.
 *
 * Nothing here reads a file, calls a provider or decides who may see what. The
 * caller owns that; `meta` on a document is passed through untouched.
 */
import { B, K1, estimateTokens, tokenize } from './search.mjs';
import { HEADER_CLOSE, parseSnapshotHeader } from '../connectors/snapshot-file.mjs';

export const DEFAULT_MAX_CHARS = 1500;
export const PASSAGE_FIELDS = { title: 3, heading: 1.5, body: 1 };

/** Any marker line, the same shape `citations.mjs` stops at. Neutralised lines start with `\` and do not match. */
const MARKER_LINE = /^===\s.*\s===$/;

/** The inverse of `markerFor` in `citations.mjs`: a marker line to the locator that cites it, or ''. */
export function locatorFor(marker) {
  const m = String(marker).trim().match(/^===\s+(.*?)\s+===$/);
  if (!m) return '';
  const inner = m[1];
  let k;
  if ((k = inner.match(/^page (\d+)$/))) return `p.${k[1]}`;
  if ((k = inner.match(/^row (\d+)$/))) return `row ${k[1]}`;
  if ((k = inner.match(/^slide (\d+)$/))) return `slide ${k[1]}`;
  if ((k = inner.match(/^t (\d{1,2}:\d{2}:\d{2})$/))) return `t ${k[1]}`;
  if ((k = inner.match(/^section:\s*(.+)$/))) return `§${k[1].trim()}`;
  return '';
}

/** The text without its snapshot header, when it has one. */
export function stripSnapshotHeader(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!parseSnapshotHeader(s)) return s;
  const lines = s.split('\n');
  const close = lines.indexOf(HEADER_CLOSE);
  return close < 0 ? s : lines.slice(close + 1).join('\n');
}

/** Cut one block of text into pieces of at most `maxChars`: paragraphs first, then lines, then characters. */
function cutText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const pieces = [];
  let cur = '';
  const flush = () => { if (cur.trim()) pieces.push(cur.trim()); cur = ''; };
  const add = (unit, sep) => {
    if (cur && (cur + sep + unit).length > maxChars) flush();
    cur = cur ? cur + sep + unit : unit;
  };
  for (const para of text.split(/\n[ \t]*\n/)) {
    if (para.length <= maxChars) { add(para, '\n\n'); continue; }
    flush();
    for (const line of para.split('\n')) {
      if (line.length <= maxChars) { add(line, '\n'); continue; }
      flush();
      for (let i = 0; i < line.length; i += maxChars) pieces.push(line.slice(i, i + maxChars).trim());
    }
    flush();
  }
  flush();
  return pieces.filter(Boolean);
}

/**
 * @param {string} text   a snapshot, a sidecar, or any text with locator markers
 * @param {object} [opts]
 * @param {number} [opts.maxChars]  longest passage; longer ones are cut into parts
 * @returns {Array<{ marker: string, locator: string, text: string, part: number }>}
 *   in source order. `part` counts from 1 and is greater than 1 only when a
 *   marker's text was cut; parts share the marker.
 */
export function splitPassages(text, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const limit = Math.max(50, Number(maxChars) || DEFAULT_MAX_CHARS);
  const blocks = [];
  let cur = { marker: '', lines: [] };
  for (const line of stripSnapshotHeader(text).split('\n')) {
    if (MARKER_LINE.test(line.trim())) {
      blocks.push(cur);
      cur = { marker: line.trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  blocks.push(cur);

  const out = [];
  for (const b of blocks) {
    const body = b.lines.join('\n').trim();
    if (!body) continue;
    const locator = locatorFor(b.marker);
    cutText(body, limit).forEach((piece, i) => out.push({ marker: b.marker, locator, text: piece, part: i + 1 }));
  }
  return out;
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

/**
 * @param {Array<{ key: string, title?: string, kind?: string, text: string, meta?: * }>} docs
 * @param {object} [opts]
 * @param {number} [opts.maxChars]  passed to `splitPassages`
 * @returns an index for `searchPassages`. The document title counts ×3, a
 *   section heading ×1.5, the body ×1.
 */
export function buildPassageIndex(docs, { maxChars } = {}) {
  const entries = [];
  const df = new Map();
  const totals = Object.fromEntries(Object.keys(PASSAGE_FIELDS).map((f) => [f, 0]));

  for (const input of docs || []) {
    const { text, ...doc } = input;
    doc.title = doc.title ?? '';
    const titleTokens = tokenize(doc.title);
    splitPassages(text, { maxChars }).forEach((passage, order) => {
      const headingText = passage.locator.startsWith('§') ? passage.locator.slice(1) : '';
      const fields = { title: titleTokens, heading: tokenize(headingText), body: tokenize(passage.text) };
      const entry = { doc, passage: { ...passage, order }, tf: {}, len: {} };
      const seen = new Set();
      for (const [f, tokens] of Object.entries(fields)) {
        entry.tf[f] = termFreq(tokens);
        entry.len[f] = tokens.length;
        totals[f] += tokens.length;
        for (const t of tokens) seen.add(t);
      }
      for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
      entries.push(entry);
    });
  }

  const n = entries.length;
  const avg = Object.fromEntries(Object.entries(totals).map(([f, total]) => [f, total / (n || 1)]));
  return { entries, df, avg, n };
}

function idf(index, term) {
  const d = index.df.get(term) || 0;
  if (!d) return 0;
  return Math.log(1 + (index.n - d + 0.5) / (d + 0.5));
}

function score(index, entry, terms) {
  let total = 0;
  let matched = 0;
  for (const term of terms) {
    let tfw = 0;
    for (const [f, w] of Object.entries(PASSAGE_FIELDS)) {
      const tf = entry.tf[f].get(term);
      if (!tf || !index.avg[f]) continue;
      tfw += (w * tf) / (1 - B + (B * entry.len[f]) / index.avg[f]);
    }
    if (tfw > 0) {
      matched += 1;
      total += idf(index, term) * (tfw / (K1 + tfw));
    }
  }
  return { score: total, matched };
}

/**
 * @param {object} index  from `buildPassageIndex`
 * @param {string} query
 * @param {object} [opts]
 * @param {string[]} [opts.terms]  ready terms; replaces tokenizing `query`
 * @returns {{ terms: string[], answered: boolean, results: Array<{ doc: object, passage: object, score: number, coverage: number }> }}
 *   `answered` is true when the best passage clears both `minScore` and
 *   `minCoverage`, the test `search()` applies to pages. `results` holds every
 *   passage that matched at least one term, best first, up to `limit`.
 */
export function searchPassages(index, query, { limit = 8, minScore = 0.2, minCoverage = 0.5, terms: given } = {}) {
  const terms = [...new Set(Array.isArray(given) ? given.map(String).filter(Boolean) : tokenize(query))];
  if (!terms.length || !index?.n) return { terms, answered: false, results: [] };

  const scored = [];
  for (const entry of index.entries) {
    const { score: s, matched } = score(index, entry, terms);
    if (!s) continue;
    scored.push({ entry, score: s, coverage: matched / terms.length });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.passage.order - b.entry.passage.order);

  const results = scored.slice(0, limit).map((s) => ({
    doc: s.entry.doc,
    passage: s.entry.passage,
    score: Math.round(s.score * 1000) / 1000,
    coverage: Math.round(s.coverage * 100) / 100,
  }));
  const top = scored[0];
  const answered = Boolean(top && top.score >= minScore && top.coverage >= minCoverage);
  return { terms, answered, results };
}

/**
 * Greedy by score inside a token budget (`estimateTokens`, plus 12 a passage
 * for its label, as `packSections` does). A passage that does not fit is cut to
 * the room left when at least 200 characters remain, else skipped; either way
 * `truncated` is true.
 * @param {Array} results  from `searchPassages`
 * @param {number} budget  tokens
 * @returns {{ items: Array<{ doc: object, passages: Array<{ marker: string, locator: string, text: string, part: number }> }>, tokens: number, truncated: boolean }}
 *   documents ordered by their best passage, passages in document order.
 */
export function packPassages(results, budget) {
  const ranked = [...(results || [])]
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.score - a.r.score || a.i - b.i)
    .map((x) => x.r);

  const chosen = [];
  let tokens = 0;
  let truncated = false;
  for (const r of ranked) {
    let text = r.passage.text;
    if (tokens + estimateTokens(text) + 12 > budget) {
      const room = (budget - tokens - 12) * 4 - 8;
      truncated = true;
      if (room < 200) continue;
      text = text.slice(0, room).trimEnd() + ' […]';
    }
    tokens += estimateTokens(text) + 12;
    chosen.push({ doc: r.doc, passage: { ...r.passage, text } });
  }

  const groups = new Map();   // doc → entries; Map keeps first-seen order, which is best-passage order
  for (const c of chosen) {
    const key = c.doc.key ?? c.doc;
    if (!groups.has(key)) groups.set(key, { doc: c.doc, entries: [] });
    groups.get(key).entries.push(c.passage);
  }
  const items = [...groups.values()].map(({ doc, entries }) => ({
    doc,
    passages: entries
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(({ marker, locator, text, part }) => ({ marker, locator, text, part })),
  }));
  return { items, tokens, truncated };
}
