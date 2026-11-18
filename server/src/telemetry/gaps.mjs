/**
 * gaps.mjs — what people ask that the brain cannot answer. Pure functions.
 *
 * A miss is a `search` / `ask` event with `answered: false` (or no results and
 * no verdict), or a `report_gap` event. Misses are clustered by Jaccard
 * similarity of their normalised token sets — the first miss of a cluster is
 * its anchor, every later miss joins the most similar cluster at or above the
 * threshold, or opens a new one. Greedy, single pass, oldest first: the same
 * events always give the same clusters.
 *
 * A gap closes itself. When a later `search` / `ask` with a similar token set
 * is answered, every miss in the cluster up to that moment is dropped; only
 * misses after the answer keep the cluster open.
 */
import { sha256 } from '../core/schemas.mjs';
import { DAY_MS } from './score.mjs';

const ASKING = new Set(['search', 'ask']);

export function isMiss(evt) {
  if (evt.tool === 'report_gap') return true;
  if (!ASKING.has(evt.tool)) return false;
  if (evt.answered === false) return true;
  return evt.answered == null && !(evt.results?.length > 0);
}

export function isHit(evt) {
  if (!ASKING.has(evt.tool)) return false;
  if (evt.answered === true) return true;
  return evt.answered == null && evt.results?.length > 0;
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** The token set an event clusters on. No tokens but a hash → the hash, so exact repeats still group. */
function tokensOf(evt) {
  if (Array.isArray(evt.queryTokens) && evt.queryTokens.length) return evt.queryTokens;
  if (evt.queryHash) return [`#${evt.queryHash}`];
  return null;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const STEP_WORDS = { sources: 'ingested sources', staged: 'staged documents', connectors: 'a connected source', live: 'a live source' };

/**
 * What live lookup did for the misses in one cluster, or null when none of
 * them carries an `extra.lookup` summary. `members` are oldest first.
 */
function lookupSummary(members) {
  const withLookup = members.filter((m) => m.extra?.lookup && typeof m.extra.lookup === 'object');
  if (!withLookup.length) return null;
  let served = 0;
  let lastStep = null;
  let connectorsAsked = 0;
  const connectors = new Set();
  const jobs = new Set();
  for (const m of withLookup) {
    const l = m.extra.lookup;
    // A live source can answer alone (no ladder step) or next to one.
    const live = Array.isArray(l.live) ? l.live : [];
    if (l.step) { served++; lastStep = l.step; }
    else if (live.length) { served++; lastStep = 'live'; }
    for (const c of live) connectors.add(c);
    if (Array.isArray(l.connectorsAsked)) for (const c of l.connectorsAsked) { connectors.add(c); connectorsAsked++; }
    else connectorsAsked += Number(l.connectorsAsked) || 0;
    for (const c of l.connectors || []) connectors.add(c);
    for (const j of l.queued || []) jobs.add(j);
  }
  return { served, lastStep, connectors: [...connectors].sort(), connectorsAsked, jobs: [...jobs].sort() };
}

/** Where lookup found its answer, in words. */
export function lookupSource(lookup) {
  if ((lookup.lastStep === 'connectors' || lookup.lastStep === 'live') && lookup.connectors.length) return lookup.connectors.join(', ');
  return STEP_WORDS[lookup.lastStep] || 'outside the wiki';
}

/**
 * @param {object[]} events   anything; misses and hits are picked out here
 * @param {object} options
 * @param {number} options.now          epoch ms
 * @param {number} [options.similarity] Jaccard threshold, default 0.5
 * @param {number} [options.limit]      default 20
 * @param {number} [options.minCount]   default 1
 * @param {boolean} [options.showQueries]  false hides query text even where it was stored plain
 */
export function clusterGaps(events, { now, similarity = 0.5, limit = 20, minCount = 1, showQueries = true } = {}) {
  const sorted = [...(events || [])]
    .filter((e) => !Number.isNaN(new Date(e.ts).getTime()))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));

  const clusters = [];
  for (const evt of sorted) {
    if (!isMiss(evt)) continue;
    const tokens = tokensOf(evt);
    if (!tokens) continue;                       // store_queries: none — nothing to cluster on
    let best = null;
    let bestSim = 0;
    for (const c of clusters) {
      const sim = jaccard(tokens, c.anchorSet);
      if (sim >= similarity && sim > bestSim) { best = c; bestSim = sim; }
    }
    if (!best) {
      best = { anchor: tokens, anchorSet: new Set(tokens), members: [], hidden: Boolean(evt.tokensHashed) || tokens[0].startsWith('#') };
      clusters.push(best);
    }
    best.members.push(evt);
  }

  // Decay-out: an answered, similar question closes everything before it.
  const hits = sorted.filter(isHit).map((e) => ({ ts: e.ts, tokens: tokensOf(e) })).filter((h) => h.tokens);
  const out = [];
  for (const c of clusters) {
    const answeredAt = hits.filter((h) => jaccard(h.tokens, c.anchorSet) >= similarity).map((h) => h.ts).sort().pop() || '';
    const open = answeredAt ? c.members.filter((m) => m.ts > answeredAt) : c.members;
    if (open.length < Math.max(1, minCount)) continue;
    out.push(describe(c, open, { now, showQueries, answeredAt }));
  }

  out.sort((a, b) => b.count - a.count || b.distinctSessions - a.distinctSessions || (a.lastSeen < b.lastSeen ? 1 : -1));
  return out.slice(0, limit);
}

function describe(cluster, members, { now, showQueries, answeredAt }) {
  const tools = {};
  const sessions = new Set();
  const texts = new Map();
  for (const m of members) {
    tools[m.tool] = (tools[m.tool] || 0) + 1;
    sessions.add(m.sessionId || m.actorId || m.id);
    if (showQueries && m.query && !m.queryHashed) texts.set(m.query, (texts.get(m.query) || 0) + 1);
  }
  const firstSeen = members[0].ts;
  const lastSeen = members[members.length - 1].ts;
  const queries = [...texts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 5)
    .map(([text, count]) => ({ text, count }));

  const tokens = cluster.hidden ? [] : cluster.anchor;
  const representative = queries[0]?.text || (tokens.length ? tokens.join(' ') : null);
  const days = Math.max(1, Math.ceil((now - new Date(firstSeen).getTime()) / DAY_MS));
  const what = representative
    ? `No page covers "${representative}"`
    : `An unanswered question (cluster of ${plural(cluster.anchor.length, 'hashed token')})`;
  const lookup = lookupSummary(members);
  const served = lookup?.served
    ? ` Served ${plural(lookup.served, 'time')} from ${lookupSource(lookup)}; ${lookup.jobs.length ? 'an ingest job is queued' : 'nothing is queued'}.`
    : '';
  const suggestion = `${what} — ${plural(members.length, 'request')} in ${plural(days, 'day')}` +
    `${sessions.size > 1 ? ` from ${sessions.size} sessions` : ''}; consider submitting a source.${served}`;

  return {
    cluster: `gap_${sha256(cluster.anchor.join(' ')).slice(0, 12)}`,
    representative,
    tokens,
    queries,
    count: members.length,
    distinctSessions: sessions.size,
    tools,
    firstSeen,
    lastSeen,
    ...(answeredAt ? { reopenedAfter: answeredAt } : {}),
    lookup,
    suggestion,
  };
}
