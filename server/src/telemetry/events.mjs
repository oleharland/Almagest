/**
 * events.mjs — turning a caller's partial event into the stored Event, with the
 * privacy settings applied before anything reaches the store.
 *
 * Privacy is decided here and only here. Nothing downstream ever sees a field
 * the configuration said not to keep, so a scoring bug cannot leak a query the
 * operator chose to hash, and a GDPR review has one function to read.
 *
 *   telemetry.store_queries  plain | hashed | none   the query text
 *   telemetry.store_tokens   plain | hashed          the normalised token set (gap clustering)
 *   telemetry.store_actor    plain | hashed | none   actorId; sessionId is hashed unless plain
 *
 * Spec: docs/v2/spec.md → Entities → Event, and docs/v2/telemetry.md → Privacy.
 */
import { newId, pseudonymize } from '../core/schemas.mjs';

export const MAX_RESULTS = 10;
export const QUERY_MODES = ['plain', 'hashed', 'none'];
export const TOKEN_MODES = ['plain', 'hashed'];
export const ACTOR_MODES = ['plain', 'hashed', 'none'];
export const CHANNELS = ['mcp', 'web', 'site', 'cli'];

/**
 * Words that carry no topic. Small and English on purpose: the token set exists
 * to tell "grid connection fee" from "grid connection fees?" from "what is the
 * fee for a grid connection", not to do linguistics.
 */
const STOPWORDS = new Set(`
a an and are as at be been but by can could did do does for from had has have how i if in into is it its
me my no not of on or our please should so than that the their them then there these they this to was
we were what when where which who whom why will with would you your about any some tell show give find
`.split(/\s+/).filter(Boolean));

/** One token: lowercase, accents stripped, a trailing plural `s` dropped (fees → fee, not glass → glas). */
function stem(token) {
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us') && !token.endsWith('is')) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * The normalised token set of a query: sorted, unique, stopwords dropped. Order
 * and repetition are thrown away deliberately — two phrasings of one question
 * should produce the same set.
 */
export function tokenize(text) {
  if (text == null) return [];
  const words = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
    .map(stem);
  return [...new Set(words)].sort();
}

/** Whitespace-collapsed lowercase text — what `queryHash` is taken over, so "Fee?" and "fee ?" hash alike. */
export function normalizeQuery(text) {
  return tokenize(text).join(' ');
}

function cleanResults(results) {
  if (!Array.isArray(results)) return [];
  const out = [];
  for (const [i, r] of results.entries()) {
    const slug = typeof r === 'string' ? r : r?.slug;
    if (typeof slug !== 'string' || !slug) continue;
    const rank = Number.isFinite(Number(r?.rank)) && Number(r.rank) > 0 ? Number(r.rank) : i + 1;
    const score = Number.isFinite(Number(r?.score)) ? Number(r.score) : null;
    out.push({ slug, rank, score });
  }
  out.sort((a, b) => a.rank - b.rank);
  return out.slice(0, MAX_RESULTS);
}

function cleanSlugs(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((s) => typeof s === 'string' && s))];
}

function validTs(ts) {
  if (typeof ts !== 'string') return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

const LOOKUP_STEPS = ['sources', 'staged', 'connectors'];
const strings = (v, max = 50) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x).map((x) => x.slice(0, 120)))].slice(0, max) : []);
const count = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);

/**
 * The compact summary `ask` attaches when live lookup ran: counts, step names
 * and job ids only. Anything else is dropped, so a caller cannot smuggle
 * passage text or a document title into the event log.
 */
function cleanLookup(l) {
  if (!l || typeof l !== 'object') return null;
  const out = {
    step: LOOKUP_STEPS.includes(l.step) ? l.step : null,
    steps: strings(l.steps).filter((s) => LOOKUP_STEPS.includes(s)),
    connectorsAsked: Array.isArray(l.connectorsAsked) ? strings(l.connectorsAsked) : count(l.connectorsAsked),
    connectors: strings(l.connectors),
    fetched: count(l.fetched),
    cacheHits: count(l.cacheHits),
    latencyMs: count(l.latencyMs),
    incomplete: l.incomplete === true,
    skipped: strings(l.skipped),
    queued: strings((l.queued || []).map?.((q) => (typeof q === 'string' ? q : q?.jobId))),
  };
  return out;
}

/** The privacy settings, resolved with defaults. Throws on an unknown mode — a typo must not mean "plain". */
export function privacyOf(telemetry = {}) {
  const queries = telemetry.store_queries ?? 'plain';
  const tokens = telemetry.store_tokens ?? 'plain';
  const actor = telemetry.store_actor ?? 'hashed';
  if (!QUERY_MODES.includes(queries)) throw new Error(`telemetry.store_queries must be ${QUERY_MODES.join(' | ')} (got "${queries}")`);
  if (!TOKEN_MODES.includes(tokens)) throw new Error(`telemetry.store_tokens must be ${TOKEN_MODES.join(' | ')} (got "${tokens}")`);
  if (!ACTOR_MODES.includes(actor)) throw new Error(`telemetry.store_actor must be ${ACTOR_MODES.join(' | ')} (got "${actor}")`);
  return { queries, tokens, actor };
}

/**
 * @param {object} partial   what the caller knows: { channel, tool, actorId?, actor?, client?, sessionId?,
 *                           query?, results?, pagesRead?, answered?, latencyMs?, helpful?, ts? }
 * @param {object} options
 * @param {{queries,tokens,actor}} options.privacy  from privacyOf()
 * @param {number} [options.now]   epoch ms
 * @param {string} [options.secret]  pseudonymisation key (defaults to ALMAGEST_SECRET_KEY via pseudonymize)
 * @returns {object} a complete Event
 */
export function buildEvent(partial, { privacy, now = Date.now(), secret } = {}) {
  if (!partial || typeof partial !== 'object') throw new Error('telemetry event must be an object');
  if (typeof partial.tool !== 'string' || !partial.tool) throw new Error('telemetry event needs a tool');
  const hash = (v) => (secret === undefined ? pseudonymize(v) : pseudonymize(v, secret));

  const ts = validTs(partial.ts) || new Date(now).toISOString();
  const evt = {
    id: newId('evt', new Date(ts).getTime()),
    ts,
    channel: CHANNELS.includes(partial.channel) ? partial.channel : (partial.channel ? String(partial.channel) : 'mcp'),
    tool: partial.tool,
  };

  const actorId = partial.actorId ?? partial.actor?.onBehalfOf?.id ?? partial.actor?.id;
  if (actorId && privacy.actor !== 'none') evt.actorId = privacy.actor === 'plain' ? String(actorId) : hash(actorId);
  if (partial.client) evt.client = String(partial.client);
  // A session id identifies one chat, not a person — but it is still linkable,
  // so it follows the actor setting except that it is never dropped: the
  // demand score's session dedupe needs equality, not identity.
  if (partial.sessionId) evt.sessionId = privacy.actor === 'plain' ? String(partial.sessionId) : hash(partial.sessionId);

  const text = typeof partial.query === 'string' ? partial.query.trim() : '';
  if (text && privacy.queries !== 'none') {
    const normalized = normalizeQuery(text) || text.toLowerCase();
    // `query` is the text itself (plain) or a keyed hash of it (hashed);
    // `queryHash` is always over the normalised form, so phrasings group.
    evt.query = privacy.queries === 'plain' ? text : hash(text);
    if (privacy.queries === 'hashed') evt.queryHashed = true;
    evt.queryHash = hash(normalized);
    const tokens = tokenize(text);
    evt.queryTokens = privacy.tokens === 'plain' ? tokens : tokens.map((t) => hash(t));
    if (privacy.tokens === 'hashed') evt.tokensHashed = true;
  }

  evt.results = cleanResults(partial.results);
  evt.pagesRead = cleanSlugs(partial.pagesRead);
  evt.answered = partial.answered === true ? true : partial.answered === false ? false : null;
  evt.latencyMs = Number.isFinite(Number(partial.latencyMs)) ? Math.max(0, Math.round(Number(partial.latencyMs))) : null;
  if (typeof partial.helpful === 'boolean') evt.helpful = partial.helpful;
  // `ask` passes its summary of a live lookup either as `lookup` (the MCP
  // recorder spreads `telemetry.extra`) or already nested as `extra.lookup`.
  const lookup = cleanLookup(partial.lookup ?? partial.extra?.lookup);
  if (lookup) evt.extra = { lookup };
  return evt;
}
