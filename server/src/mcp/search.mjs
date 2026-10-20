/**
 * search.mjs — BM25F over main's pages. No dependency, no embeddings: the
 * brain is a few hundred to a few thousand curated pages, every one of which
 * carries a title, aliases and tags written for exactly this lookup. A lexical
 * index over those fields is predictable, explainable in a sentence, and
 * rebuilds in milliseconds when main moves.
 *
 * Fields and boosts: title ×3 · aliases ×3 · tags ×2 · section headings ×1.5 ·
 * body ×1. An alias (or title, or slug) that matches the whole query exactly
 * ranks first; one that appears as a phrase inside the query ranks next —
 * aliases are the brain's own entity-dedup table (brain/.index/aliases.tsv),
 * so a named entity beats a page that merely mentions the words.
 */

export const FIELDS = { title: 3, aliases: 3, tags: 2, headings: 1.5, body: 1 };
export const K1 = 1.2;
export const B = 0.75;

export const STOPWORDS = new Set(`
a about above after again against all am an and any are as at be because been before being below between both but by
can could did do does doing down during each few for from further had has have having he her here hers herself him
himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other
our ours ourselves out over own same she should so some such than that the their theirs them themselves then there
these they this those through to too under until up very was we were what when where which while who whom why will
with would you your yours yourself yourselves s t don shall may might must also us let tell know please
`.split(/\s+/).filter(Boolean));

/**
 * Deliberately small suffix stripper — enough that "retries", "retrying" and
 * "retried" meet, not enough to surprise anyone. Applied identically to the
 * index and the query, so its mistakes cancel out.
 */
export function stem(word) {
  let w = word;
  if (w.length <= 3 || /^\d+$/.test(w)) return w;
  const rules = [
    ['ational', 'ate'], ['ization', 'ize'], ['fulness', 'ful'], ['iveness', 'ive'], ['ousness', 'ous'],
    ['ically', 'ic'], ['nesses', ''], ['ments', ''], ['ment', ''], ['ness', ''], ['ingly', ''], ['edly', ''],
    ['ings', ''], ['ing', ''], ['ies', 'y'], ['ied', 'y'], ['sses', 'ss'], ['ed', ''], ['ly', ''], ['es', ''], ['s', ''],
  ];
  let stripped = '';
  for (const [suffix, repl] of rules) {
    if (!w.endsWith(suffix)) continue;
    if (suffix === 's' && /(ss|us|is)$/.test(w)) continue;
    const base = w.slice(0, -suffix.length) + repl;
    if (base.length < 3) continue;
    w = base;
    stripped = suffix;
    break;
  }
  // stopped → stop, running → run: undouble the consonant pair -ed / -ing left behind
  if (/^(ed|ing|ings)$/.test(stripped) && /([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz|ff)$/.test(w)) w = w.slice(0, -1);
  return w;
}

function fold(text) {
  return String(text ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** Lowercase, fold accents, split on anything that is not a letter or digit, drop stopwords, stem. */
export function tokenize(text, { keepStopwords = false } = {}) {
  const out = [];
  for (const raw of fold(text).match(/[\p{L}\p{N}]+/gu) || []) {
    if (raw.length < 2 && !/\d/.test(raw)) continue;
    if (!keepStopwords && STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** `"B-1"` and `"b 1"` compare equal; used for alias / title phrase matching. */
export function normalizePhrase(text) {
  return (fold(text).match(/[\p{L}\p{N}]+/gu) || []).join(' ');
}

/** Wikilinks to their label, citations kept — a snippet should read like the page. */
export function plain(text) {
  return String(text)
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target, label) => (label ?? target).trim())
    .replace(/\*\*|__|`/g, '');
}

function stripForIndex(text) {
  return plain(text).replace(/\[source:[^\]]*\]/g, ' ');
}

/** Split a body at `#`/`##` headings. `###` and deeper stay inside their section. */
export function splitSections(body) {
  const sections = [];
  let cur = { name: '', text: [], line: 1 };
  let fence = '';
  const lines = String(body).split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    const f = t.match(/^(```|~~~)/);
    if (f) { if (!fence) fence = f[1]; else if (fence === f[1]) fence = ''; }
    const h = !fence && t.match(/^(#{1,2})\s+(.*)$/);
    if (h) {
      if (cur.name || cur.text.some((l) => l.trim())) sections.push(cur);
      cur = { name: h[2].replace(/\s*#+\s*$/, '').trim(), text: [], line: i + 1 };
      return;
    }
    cur.text.push(line);
  });
  if (cur.name || cur.text.some((l) => l.trim())) sections.push(cur);
  return sections.map((s) => ({ name: s.name, line: s.line, text: s.text.join('\n').trim() }));
}

function headingText(body) {
  return (String(body).match(/^#{1,6}\s+.*$/gm) || []).map((h) => h.replace(/^#+\s+/, '')).join(' ');
}

function bodyWithoutHeadings(body) {
  return String(body).replace(/^#{1,6}\s+.*$/gm, ' ');
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

/**
 * @param {Array} pages   from ctx.snapshot.load().pages (wiki-core shape)
 * @param {string} sha    the snapshot commit — the index is valid for exactly this
 */
export function buildIndex(pages, sha = '') {
  const docs = [];
  const df = new Map();
  const totals = Object.fromEntries(Object.keys(FIELDS).map((f) => [f, 0]));
  const phrases = [];   // { phrase, slug, kind }

  for (const page of pages) {
    const fields = {
      title: tokenize(page.title),
      aliases: tokenize(page.aliases.join(' ')),
      tags: tokenize(page.tags.join(' ')),
      headings: tokenize(headingText(page.body)),
      body: tokenize(stripForIndex(bodyWithoutHeadings(page.body))),
    };
    const doc = { page, tf: {}, len: {} };
    const seen = new Set();
    for (const [f, tokens] of Object.entries(fields)) {
      doc.tf[f] = termFreq(tokens);
      doc.len[f] = tokens.length;
      totals[f] += tokens.length;
      for (const t of tokens) seen.add(t);
    }
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    docs.push(doc);

    for (const a of page.aliases) phrases.push({ phrase: normalizePhrase(a), id: page.id, kind: 'alias' });
    phrases.push({ phrase: normalizePhrase(page.title), id: page.id, kind: 'title' });
    phrases.push({ phrase: normalizePhrase(page.slug), id: page.id, kind: 'slug' });
  }

  const n = docs.length || 1;
  const avg = Object.fromEntries(Object.entries(totals).map(([f, total]) => [f, total / n]));
  return { sha, docs, df, avg, n: docs.length, phrases: phrases.filter((p) => p.phrase), byId: new Map(docs.map((d) => [d.page.id, d])) };
}

export function idf(index, term) {
  const d = index.df.get(term) || 0;
  if (!d) return 0;
  return Math.log(1 + (index.n - d + 0.5) / (d + 0.5));
}

function bm25f(index, doc, terms) {
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    let tfw = 0;
    for (const [f, w] of Object.entries(FIELDS)) {
      const tf = doc.tf[f].get(term);
      if (!tf || !index.avg[f]) continue;
      tfw += (w * tf) / (1 - B + (B * doc.len[f]) / index.avg[f]);
    }
    if (tfw > 0) {
      matched += 1;
      score += idf(index, term) * (tfw / (K1 + tfw));
    }
  }
  return { score, matched };
}

/** Best-matching line of the body, trimmed around the first hit, with its section. */
export function snippetFor(page, terms, maxLen = 240) {
  const want = new Set(terms);
  let best = null;
  let section = '';
  let fence = '';
  const lines = String(page.body).split('\n');
  for (const line of lines) {
    const t = line.trim();
    const f = t.match(/^(```|~~~)/);
    if (f) { if (!fence) fence = f[1]; else if (fence === f[1]) fence = ''; continue; }
    if (fence || !t) continue;
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) { if (h[1].length <= 2) section = h[2].trim(); continue; }
    if (/^\|?\s*:?-{3,}/.test(t)) continue;
    const toks = tokenize(stripForIndex(t));
    const hits = new Set(toks.filter((x) => want.has(x))).size;
    if (!best || hits > best.hits) best = { hits, text: t, section, toks };
    if (best.hits === want.size && want.size) break;
  }
  if (!best) return '';
  let text = plain(best.text).replace(/^([-*+]|\d+[.)])\s+/, '').replace(/^\|\s*|\s*\|$/g, '').replace(/\s*\|\s*/g, ' · ');
  if (text.length > maxLen) {
    const folded = fold(text);
    let at = -1;
    for (const term of want) {
      const i = folded.indexOf(term);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    const start = Math.max(0, Math.min(at - 60, text.length - maxLen));
    text = (start > 0 ? '…' : '') + text.slice(start, start + maxLen).trim() + (start + maxLen < text.length ? '…' : '');
  }
  return best.section ? `§${best.section}: ${text}` : text;
}

/**
 * @param {object} index  from buildIndex
 * @param {string} query
 * @param {object} [options]
 * @returns {{ terms: string[], results: Array, answered: boolean }}
 */
export function search(index, query, { limit = 8, minScore = 0.2, minCoverage = 0.5, type, tier, tags } = {}) {
  const terms = [...new Set(tokenize(query))];
  const q = normalizePhrase(query);
  const phraseHits = new Map();   // id → { rank, kind }
  if (q) {
    const padded = ` ${q} `;
    for (const p of index.phrases) {
      let rank = 0;
      if (p.phrase === q) rank = 3;
      else if (p.kind === 'alias' && p.phrase.length >= 2 && padded.includes(` ${p.phrase} `)) rank = 2;
      if (!rank) continue;
      const prev = phraseHits.get(p.id);
      if (!prev || rank > prev.rank || (rank === prev.rank && p.kind === 'alias' && prev.kind !== 'alias')) phraseHits.set(p.id, { rank, kind: p.kind });
    }
  }

  const scored = [];
  for (const doc of index.docs) {
    const page = doc.page;
    if (type && page.type !== type) continue;
    if (tier && page.tier !== tier) continue;
    if (tags?.length && !tags.every((t) => page.tags.includes(t))) continue;
    const { score, matched } = bm25f(index, doc, terms);
    const phrase = phraseHits.get(page.id);
    if (!score && !phrase) continue;
    const coverage = terms.length ? matched / terms.length : phrase ? 1 : 0;
    scored.push({
      page,
      score,
      coverage,
      match: phrase ? (phrase.rank === 3 ? `exact-${phrase.kind}` : 'alias') : 'text',
      phraseRank: phrase?.rank || 0,
    });
  }
  scored.sort((a, b) => b.phraseRank - a.phraseRank || b.score - a.score || a.page.title.localeCompare(b.page.title));

  const results = scored.slice(0, limit).map((s, i) => ({
    slug: s.page.id,
    title: s.page.title,
    type: s.page.type,
    tier: s.page.tier,
    confidence: s.page.confidence,
    origin: s.page.origin,
    score: Math.round(s.score * 1000) / 1000,
    coverage: Math.round(s.coverage * 100) / 100,
    match: s.match,
    rank: i + 1,
    snippet: snippetFor(s.page, terms),
  }));

  const top = scored[0];
  const answered = Boolean(top && (top.phraseRank > 0 || (top.score >= minScore && top.coverage >= minCoverage)));
  return { terms, results, answered };
}

/** Rough token count for packing — 4 chars a token is close enough for a budget. */
export function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

/** Score a section of text against query terms: Σ idf × (1 + ln tf). */
export function scoreText(index, text, terms) {
  const tf = termFreq(tokenize(stripForIndex(text)));
  let score = 0;
  for (const t of terms) {
    const n = tf.get(t);
    if (n) score += idf(index, t) * (1 + Math.log(n));
  }
  return score;
}
