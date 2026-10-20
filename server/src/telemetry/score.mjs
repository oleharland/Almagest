/**
 * score.mjs — the demand score. Pure functions, no I/O, no clock: every input
 * is an argument, so every number the service reports can be recomputed by
 * hand from the events it names (docs/v2/telemetry.md → The formula).
 *
 *   score(slug) = max(0, Σ  weight(evt, slug) × 0.5^(age_days / half_life_days))
 *
 *   weight      get_page / resource read 1.0 · ask hit 0.6 × d(rank) ·
 *               search top-3 hit 0.3 × d(rank) · feedback +2 helpful / −1 unhelpful
 *   d(rank)     1 / log2(rank + 1)          — 1, 0.63, 0.5, … (the DCG discount)
 *   dedupe      one session touching one page counts once per 10-minute window:
 *               the strongest implicit signal in the window is kept, the rest are
 *               recorded as deduped. Feedback dedupes separately; the latest wins.
 *
 * This is deliberately not machine learning. It is a decayed, weighted count,
 * and `explain()` shows the events that produced it.
 */
export const DAY_MS = 86_400_000;

export const DEFAULT_WEIGHTS = Object.freeze({
  get_page: 1.0,
  resource: 1.0,          // MCP resource read — almagest://page/{slug}
  read_resource: 1.0,     // alias, whichever name the MCP layer records
  ask: 0.6,
  search: 0.3,
  feedback_helpful: 2,
  feedback_unhelpful: -1,
});

export const DEFAULT_DEMAND = Object.freeze({
  half_life_days: 14,
  hot_percentile: 90,
  min_score: 3,
  dedupe_minutes: 10,
  search_top: 3,
});

/** Tools whose score is a ranked hit, and the one whose score is explicit. Everything else with a weight is a read. */
const RANKED = new Set(['ask', 'search']);
const FEEDBACK = 'feedback';

export function decay(ageDays, halfLifeDays) {
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

export function rankDiscount(rank) {
  const r = Number(rank) >= 1 ? Number(rank) : 1;
  return 1 / Math.log2(r + 1);
}

export const round = (n, places = 3) => {
  const f = 10 ** places;
  return Math.round((n + Number.EPSILON) * f) / f;
};

/** Resolved demand options: config values over defaults. */
export function demandOptions(telemetryDemand = {}) {
  const d = { ...DEFAULT_DEMAND, ...telemetryDemand };
  const half = Number(d.half_life_days);
  if (!(half > 0)) throw new Error(`telemetry.demand.half_life_days must be > 0 (got ${d.half_life_days})`);
  return {
    halfLifeDays: half,
    hotPercentile: Math.min(100, Math.max(0, Number(d.hot_percentile))),
    minScore: Number(d.min_score) || 0,
    dedupeMs: Math.max(0, Number(d.dedupe_minutes)) * 60_000,
    searchTop: Math.max(1, Number(d.search_top) | 0),
    weights: { ...DEFAULT_WEIGHTS, ...(d.weights || {}) },
  };
}

/**
 * What one event says about which pages, before decay and dedupe.
 * @returns {Array<{ slug, kind: 'read'|'ask'|'search'|'feedback', base, rank }>}
 */
export function contributions(evt, { weights = DEFAULT_WEIGHTS, searchTop = 3 } = {}) {
  const tool = evt?.tool;
  const results = Array.isArray(evt?.results) ? evt.results : [];
  const read = Array.isArray(evt?.pagesRead) ? evt.pagesRead : [];
  const out = [];

  if (tool === FEEDBACK) {
    if (typeof evt.helpful !== 'boolean') return out;
    const base = evt.helpful ? weights.feedback_helpful : weights.feedback_unhelpful;
    const slugs = new Set([...read, ...results.map((r) => r.slug)]);
    for (const slug of slugs) out.push({ slug, kind: 'feedback', base, rank: null });
    return out;
  }

  const w = Number(weights[tool]);
  if (!Number.isFinite(w) || w === 0) return out;

  if (RANKED.has(tool)) {
    const seen = new Set();
    for (const r of results) {
      if (seen.has(r.slug)) continue;
      seen.add(r.slug);
      if (tool === 'search' && r.rank > searchTop) continue;
      out.push({ slug: r.slug, kind: tool, base: w * rankDiscount(r.rank), rank: r.rank });
    }
    // An ask that names a page it packaged but did not rank still used it — as rank 1.
    for (const slug of read) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ slug, kind: tool, base: w, rank: 1 });
    }
    return out;
  }

  // A read: get_page, a resource read, or any tool given a weight in config.
  const slugs = read.length ? read : results.slice(0, 1).map((r) => r.slug);
  for (const slug of new Set(slugs)) out.push({ slug, kind: 'read', base: w, rank: null });
  return out;
}

/** The key one chat is deduped under. An event with neither session nor actor is its own session. */
function sessionKey(evt) {
  return evt.sessionId ? `s:${evt.sessionId}` : evt.actorId ? `a:${evt.actorId}` : '';
}

/**
 * Every contribution of every event, decayed, with dedupe decided.
 * @returns {Array<{ eventId, ts, tool, slug, kind, base, rank, session, decay, value, deduped }>}
 */
export function traceEvents(events, { now, halfLifeDays, dedupeMs, weights, searchTop }) {
  const all = [];
  for (const evt of events || []) {
    const tsMs = new Date(evt.ts).getTime();
    if (Number.isNaN(tsMs)) continue;
    const session = sessionKey(evt);
    for (const c of contributions(evt, { weights, searchTop })) {
      all.push({ eventId: evt.id, ts: evt.ts, tsMs, tool: evt.tool, ...c, session, deduped: false });
    }
  }
  all.sort((a, b) => a.tsMs - b.tsMs || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));

  // Tumbling windows anchored at the first touch: t0, t0+5m are one window,
  // t0+11m opens the next. Deterministic, and easy to say out loud.
  const open = new Map();
  const windows = [];
  for (const c of all) {
    if (!c.session || dedupeMs <= 0) continue;
    const key = `${c.session}\0${c.slug}\0${c.kind === 'feedback' ? 'f' : 'i'}`;
    let w = open.get(key);
    if (!w || c.tsMs - w.start >= dedupeMs) {
      w = { start: c.tsMs, feedback: c.kind === 'feedback', members: [] };
      open.set(key, w);
      windows.push(w);
    }
    w.members.push(c);
  }
  for (const w of windows) {
    if (w.members.length < 2) continue;
    // Implicit signals: the strongest wins (a search hit then a full read counts as the read).
    // Feedback: the latest wins — the user changed their mind.
    const keep = w.feedback
      ? w.members[w.members.length - 1]
      : w.members.reduce((best, c) => (c.base > best.base ? c : best), w.members[0]);
    for (const c of w.members) if (c !== keep) c.deduped = true;
  }

  for (const c of all) {
    c.decay = decay((now - c.tsMs) / DAY_MS, halfLifeDays);
    c.value = c.deduped ? 0 : c.base * c.decay;
  }
  return all;
}

/**
 * Per-slug aggregates.
 * @returns {Map<slug, { score, positive, negative, distinctSessions, counts: {tool:n}, deduped }>}
 */
export function scoreEvents(events, options) {
  const trace = traceEvents(events, options);
  const bySlug = new Map();
  for (const c of trace) {
    let s = bySlug.get(c.slug);
    if (!s) {
      s = { slug: c.slug, positive: 0, negative: 0, sessions: new Set(), counts: {}, deduped: 0 };
      bySlug.set(c.slug, s);
    }
    if (c.deduped) { s.deduped++; continue; }
    s.counts[c.tool] = (s.counts[c.tool] || 0) + 1;
    if (c.value >= 0) s.positive += c.value;
    else s.negative += c.value;
    if (c.base > 0) s.sessions.add(c.session || `e:${c.eventId}`);
  }
  const out = new Map();
  for (const [slug, s] of bySlug) {
    out.set(slug, {
      score: round(Math.max(0, s.positive + s.negative)),
      positive: round(s.positive),
      negative: round(s.negative),
      distinctSessions: s.sessions.size,
      counts: s.counts,
      deduped: s.deduped,
    });
  }
  return out;
}

/** How many of `n` ranked pages the top `hotPercentile` covers. Ceil, so a small wiki still has a hot page. */
export function hotCapacity(n, hotPercentile) {
  return Math.ceil((n * (100 - hotPercentile)) / 100);
}

/**
 * Rank every page. The population is the known pages plus anything scored —
 * a page nobody touched still occupies a rank, which is what makes "top 10%"
 * mean 10% of the wiki rather than 10% of whatever happened to be read.
 *
 * Order: score desc, then distinct sessions desc (ten readers beat one reader
 * ten times), then slug asc for determinism.
 *
 * @returns {{ entries: Array<{slug, score, rank, hot, distinctSessions, counts}>, hot: string[], population: number }}
 */
export function rankDemand(scores, { pages = [], hotPercentile, minScore }) {
  const population = new Set([...pages, ...scores.keys()]);
  const entries = [...population].map((slug) => {
    const s = scores.get(slug);
    return { slug, score: s?.score ?? 0, distinctSessions: s?.distinctSessions ?? 0, counts: s?.counts ?? {} };
  });
  entries.sort((a, b) => b.score - a.score || b.distinctSessions - a.distinctSessions || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const capacity = hotCapacity(entries.length, hotPercentile);
  entries.forEach((e, i) => {
    e.rank = i + 1;
    e.hot = e.rank <= capacity && e.score > 0 && e.score >= minScore;
  });
  return { entries, hot: entries.filter((e) => e.hot).map((e) => e.slug), population: entries.length };
}

/** scoreEvents + rankDemand, stamped. `now` is epoch ms. */
export function computeDemand(events, { now, pages = [], ...demand }) {
  const opts = { now, ...demand };
  const ranked = rankDemand(scoreEvents(events, opts), { pages, ...opts });
  return { computedAt: new Date(now).toISOString(), ...ranked };
}

/**
 * Why a page has the score it has: its contributions, the strongest first,
 * counts per tool, and the raw (undecayed) signal in the latest half-life
 * window against the one before it.
 */
export function explainSlug(events, slug, options, { top = 10 } = {}) {
  const trace = traceEvents(events, options).filter((c) => c.slug === slug);
  const counted = trace.filter((c) => !c.deduped);
  const byTool = {};
  for (const c of trace) {
    const t = (byTool[c.tool] ||= { counted: 0, deduped: 0, value: 0 });
    if (c.deduped) t.deduped++;
    else { t.counted++; t.value = round(t.value + c.value); }
  }
  const windowMs = options.halfLifeDays * DAY_MS;
  const inWindow = (from, to) => round(counted.filter((c) => c.tsMs > from && c.tsMs <= to).reduce((n, c) => n + c.base, 0));
  const current = inWindow(options.now - windowMs, options.now);
  const previous = inWindow(options.now - 2 * windowMs, options.now - windowMs);
  const delta = round(current - previous);
  const sum = counted.reduce((n, c) => n + c.value, 0);

  return {
    slug,
    score: round(Math.max(0, sum)),
    formula: `max(0, Σ weight × 0.5^(age_days / ${options.halfLifeDays}))`,
    halfLifeDays: options.halfLifeDays,
    events: new Set(trace.map((c) => c.eventId)).size,
    byTool,
    topContributors: [...counted]
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || b.tsMs - a.tsMs)
      .slice(0, top)
      .map((c) => ({
        eventId: c.eventId, ts: c.ts, tool: c.tool, kind: c.kind, rank: c.rank,
        weight: round(c.base), decay: round(c.decay), value: round(c.value),
      })),
    deduped: trace.length - counted.length,
    trend: {
      windowDays: options.halfLifeDays,
      current,
      previous,
      delta,
      direction: delta > 0 ? 'rising' : delta < 0 ? 'falling' : 'flat',
    },
  };
}
