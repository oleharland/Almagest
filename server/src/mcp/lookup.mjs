/**
 * lookup.mjs — live lookup: when no reviewed page answers a question, look in
 * the cheapest place first. Design: docs/v2/live-lookup.md.
 *
 *   createLookup(ctx, cfg, brain).find({ question, keywords, human, transport, budget })
 *
 * The ladder, stopping at the first step whose passage search is `answered`:
 *   sources     committed source text on main (manifest entries, read from the snapshot)
 *   staged      connector snapshots fetched earlier and not yet on main
 *   connectors  search the connected MCP servers, fetch at most `max_fetch` documents
 *
 * What stands between a caller and each step: the caller's role, the
 * anonymization switch, `send_query`, the transport, a negative cache, rate
 * limits, one overall deadline and a list of rejected sha256s. Every one of
 * them narrows the lookup; none widens what `ask` returns. `find` never throws:
 * on any failure it returns what it has.
 *
 * Nothing here writes to the wiki, to main or to a git ref. The only writes are
 * `ctx.ingest.enqueue` (an ordinary ingest job, which ends as a proposal a
 * person reviews) and two small counters in `ctx.store.kv`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

import { serviceActor } from '../core/auth.mjs';
import { ROLES, sha256 } from '../core/schemas.mjs';
import { parseSnapshotHeader } from '../connectors/snapshot-file.mjs';

import { verifyPathFor } from './citations.mjs';
import { buildPassageIndex, packPassages, searchPassages } from './passages.mjs';
import { tokenize } from './search.mjs';
import { packSections } from './tools.mjs';

/** kv namespace: sha256 of a connector document whose proposal was rejected → { at, proposalId, connector }. */
export const REJECTED_NS = 'lookup-rejected';
/** kv namespace: UTC day → { n } ingest jobs queued by lookup that day. */
export const INGEST_COUNT_NS = 'lookup-ingest-count';

/** The canonical pass is looser than a normal answer: it is a guardrail, so a near miss is worth showing. */
export const CANONICAL_MIN_SCORE = 0.1;
export const CANONICAL_MIN_COVERAGE = 0.25;
/** Share of the token budget canonical sections may take; the passages get the rest. */
export const CANONICAL_SHARE = 0.4;
export const CANONICAL_PAGES = 3;

const STEPS = ['sources', 'staged', 'connectors'];
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MINUTE = 60_000;

class Timeout extends Error {}

const inLookup = new AsyncLocalStorage();

/** Role standing, from the one ordering the codebase has (`ROLES`, lowest first). -1 when none. */
export function roleRank(human) {
  if (!human || human.anonymous) return -1;
  return Math.max(-1, ...(human.roles || []).map((r) => ROLES.indexOf(r)));
}

/** Terms to send to a provider: the chat's keywords as given, else the question's words that survive the stopword filter. */
export function queryTerms(question, keywords) {
  const given = (Array.isArray(keywords) ? keywords : []).map((k) => String(k).trim()).filter(Boolean);
  if (given.length) return given;
  return String(question || '').split(/[^\p{L}\p{N}_-]+/u).filter((w) => w && tokenize(w).length);
}

/** A sliding one-minute window per key, in memory. `hit` says whether one more call is allowed, and counts it if so. */
function createLimiter() {
  const seen = new Map();
  return {
    hit(key, limit, now = Date.now()) {
      if (!(limit > 0)) return true;
      const recent = (seen.get(key) || []).filter((t) => now - t < MINUTE);
      if (recent.length >= limit) { seen.set(key, recent); return false; }
      recent.push(now);
      seen.set(key, recent);
      return true;
    },
  };
}

function createDeadline(ms) {
  const end = Date.now() + ms;
  const left = () => end - Date.now();
  /** Await `promise`, or throw Timeout when the deadline passes first. */
  async function within(promise) {
    const p = Promise.resolve(promise);
    p.catch(() => {});
    const room = left();
    if (room <= 0) throw new Timeout('lookup deadline passed');
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Timeout('lookup deadline passed')), room); });
    try { return await Promise.race([p, late]); } finally { clearTimeout(timer); }
  }
  return { left, within };
}

export function createLookup(ctx, cfg, brain) {
  const lc = cfg.lookup;
  const log = ctx.log;
  const limiter = createLimiter();
  const negative = new Map();            // `${connector}|${sorted terms}` → expiry ms
  const svc = serviceActor('lookup');
  const steps = (lc.steps || []).filter((s) => STEPS.includes(s));
  const minRank = ROLES.indexOf(lc.min_role);
  const anonymize = ctx.config.v1?.raw?.anonymization?.enabled === true;
  const storeQueries = ctx.config.telemetry?.store_queries ?? 'plain';

  if (lc.enabled && anonymize && steps.some((s) => s !== 'sources')) {
    log.info('live lookup: staged and connectors steps are off because anonymization.enabled is true (fetched text cannot be anonymized mechanically)');
  }
  if (lc.enabled && minRank < 0) log.warn('live lookup: mcp.lookup.min_role is not a known role, so staged and connectors steps are off', { min_role: lc.min_role });

  // ── rejected sources ──────────────────────────────────────────────────────

  if (ctx.bus?.on) {
    ctx.bus.on('proposal.rejected', async ({ proposal } = {}) => {
      const s = proposal?.source;
      if (s?.kind !== 'connector' || !s.sha256) return;
      await ctx.store.kv.set(REJECTED_NS, String(s.sha256).toLowerCase(), { at: new Date().toISOString(), proposalId: proposal.id || '', connector: s.connector || '' });
    });
  }

  async function rejectedShas() {
    try { return new Set((await ctx.store.kv.list(REJECTED_NS)).map((r) => r.key)); }
    catch (err) { log.warn('live lookup: could not read the rejected list', { error: err.message }); return new Set(); }
  }

  // ── step 1: committed source text ─────────────────────────────────────────

  let sourceCache = { sha: '', index: null, docs: 0 };

  function sourceIndex(b) {
    if (sourceCache.sha === b.sha && sourceCache.index) return sourceCache.index;
    const root = path.resolve(b.snap.dir);
    const docs = [];
    const seenPaths = new Set();
    for (const e of b.manifest.entries) {
      if (e.status === 'missing') continue;
      const rel = verifyPathFor({ id: e.id, path: e.path }, b.manifest);
      if (!rel || seenPaths.has(rel)) continue;
      const abs = path.resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) continue;
      let text;
      try {
        if (fs.statSync(abs).size > MAX_SOURCE_BYTES) continue;
        text = fs.readFileSync(abs, 'utf-8');
      } catch { continue; }                 // binary original with no sidecar, or an ephemeral snapshot: nothing to search
      seenPaths.add(rel);
      docs.push({ key: e.id || rel, title: b.sourceTitles.get(e.id) || path.basename(rel), kind: 'source', text, meta: { sourceId: e.id, path: rel } });
    }
    sourceCache = { sha: b.sha, index: buildPassageIndex(docs), docs: docs.length };
    return sourceCache.index;
  }

  // ── step 2: staged snapshots ──────────────────────────────────────────────

  const fileCache = new Map();           // abs → { mtimeMs, size, doc }
  let stagedCache = { signature: '', index: null };

  function readStaged(abs, connector, stat) {
    const hit = fileCache.get(abs);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.doc;
    let doc = null;
    try {
      const text = fs.readFileSync(abs, 'utf-8');
      const header = parseSnapshotHeader(text) || {};
      doc = {
        key: `${connector}:${header.ref || path.basename(abs)}`,
        title: header.title || path.basename(abs, '.txt'),
        kind: 'unreviewed',
        text,
        meta: { connector, server: header.server || '', ref: header.ref || '', sha256: sha256(text), fetchedAt: new Date(stat.mtimeMs).toISOString(), via: 'staged' },
      };
    } catch { doc = null; }
    fileCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, doc });
    return doc;
  }

  async function stagedIndex(b, connectors, rejected) {
    const root = path.join(ctx.config.paths.state, 'connector-snapshots');
    const allowed = new Set(connectors.filter((c) => c.lookup).map((c) => c.id));
    const onMain = new Set();
    for (const e of b.manifest.entries) { if (e.sha256) onMain.add(e.sha256); if (e.extractedSha256) onMain.add(e.extractedSha256); }
    const docs = [];
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && allowed.has(d.name)); } catch { dirs = []; }
    for (const d of dirs) {
      let files = [];
      try { files = fs.readdirSync(path.join(root, d.name)).filter((f) => f.endsWith('.txt')).sort(); } catch { continue; }
      for (const f of files) {
        const abs = path.join(root, d.name, f);
        let stat;
        try { stat = fs.statSync(abs); } catch { continue; }
        if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) continue;
        const doc = readStaged(abs, d.name, stat);
        if (!doc || onMain.has(doc.meta.sha256) || rejected.has(doc.meta.sha256)) continue;
        docs.push(doc);
      }
    }
    const signature = docs.map((x) => `${x.key}:${x.meta.sha256}`).join('|');
    if (stagedCache.signature !== signature || !stagedCache.index) stagedCache = { signature, index: buildPassageIndex(docs) };
    return stagedCache.index;
  }

  // ── canonical pass ────────────────────────────────────────────────────────

  async function canonicalPass(question, terms, budget) {
    const r = await brain.search([question, ...terms].join(' '), {
      tier: 'canonical', limit: CANONICAL_PAGES, minScore: CANONICAL_MIN_SCORE, minCoverage: CANONICAL_MIN_COVERAGE,
    });
    const results = r.results.filter((x) => x.match !== 'text' || (x.score >= CANONICAL_MIN_SCORE && x.coverage >= CANONICAL_MIN_COVERAGE));
    if (!results.length) return { pages: [], tokens: 0, truncated: false };
    return packSections(await brain.current(), { terms: r.terms, results }, Math.floor(budget * CANONICAL_SHARE));
  }

  // ── enrichment ────────────────────────────────────────────────────────────

  let ingestChain = Promise.resolve();
  const serial = (fn) => { const next = ingestChain.then(fn, fn); ingestChain = next.catch(() => {}); return next; };

  function instructionsFor(question) {
    if (storeQueries === 'plain') return `Asked: "${String(question).replace(/\s+/g, ' ').slice(0, 500)}". Fetched by live lookup.`;
    return 'Fetched by live lookup to answer a question asked in a chat.';
  }

  async function enrich(refs, { question, human, out }) {
    if (lc.ingest !== 'auto' || !ctx.ingest?.enqueue) return;
    for (const ref of refs) {
      await serial(async () => {
        try {
          const day = new Date().toISOString().slice(0, 10);
          const used = (await ctx.store.kv.get(INGEST_COUNT_NS, day))?.n || 0;
          if (used >= lc.max_ingest_per_day) { out.skipped.push({ step: 'ingest', reason: 'the daily limit on documents queued for review is reached' }); return; }
          const job = await ctx.ingest.enqueue({
            kind: 'ingest', trigger: 'lookup', source: ref, requestedBy: svc.id, onBehalfOf: human.id, instructions: instructionsFor(question),
          });
          if (job?.id) {
            out.queued.push({ jobId: job.id, connector: ref.connector, ref: ref.ref });
            await ctx.store.kv.set(INGEST_COUNT_NS, day, { n: used + 1 });
          }
        } catch (err) {
          log.warn('live lookup: could not queue a fetched document for review', { connector: ref.connector, error: err.message });
        }
      });
    }
  }

  // ── step 3: connectors ────────────────────────────────────────────────────

  async function connectorDocs({ connectors, raw, rejected, deadline, out, docs }) {
    const termKey = raw.map((t) => t.toLowerCase()).sort().join(' ');
    let fetchBudget = Math.max(0, Number(lc.max_fetch) || 0);
    for (const c of connectors) {
      if (!c.lookup || !c.searchable || fetchBudget <= 0) continue;
      const key = `${c.id}|${termKey}`;
      if ((negative.get(key) || 0) > Date.now()) { out.stats.cacheHits += 1; continue; }
      if (!limiter.hit(`connector:${c.id}`, lc.rate.per_connector_per_minute)) { out.skipped.push({ step: 'connectors', reason: `rate limit for connector ${c.id}` }); continue; }
      out.stats.connectorsAsked += 1;
      let items;
      try { items = await deadline.within(ctx.connectors.search(c.id, { terms: raw, limit: Math.max(lc.max_fetch * 2, 5) })); }
      catch (err) {
        if (err instanceof Timeout) throw err;
        log.warn('live lookup: connector search failed', { connector: c.id, error: err.message });
        continue;
      }
      if (!items?.length) { negative.set(key, Date.now() + lc.negative_ttl_minutes * MINUTE); continue; }
      for (const item of items) {
        if (fetchBudget <= 0) break;
        if (!limiter.hit(`connector:${c.id}`, lc.rate.per_connector_per_minute)) { out.skipped.push({ step: 'connectors', reason: `rate limit for connector ${c.id}` }); break; }
        fetchBudget -= 1;
        let got;
        try { got = await deadline.within(ctx.connectors.fetchOne(c.id, item)); }
        catch (err) {
          if (err instanceof Timeout) throw err;
          log.warn('live lookup: fetching a document failed', { connector: c.id, error: err.message });
          continue;
        }
        out.stats.fetched += 1;
        if (!got?.text || rejected.has(String(got.sha256 || '').toLowerCase())) continue;
        docs.push({
          key: `${c.id}:${got.ref?.ref ?? item.ref}`,
          title: got.title || item.title || String(item.ref),
          kind: 'unreviewed',
          text: got.text,
          meta: { connector: c.id, server: got.ref?.server || '', ref: String(got.ref?.ref ?? item.ref), sha256: got.sha256, fetchedAt: got.ref?.fetchedAt || new Date().toISOString(), via: 'connector', sourceRef: got.ref },
        });
      }
    }
  }

  // ── the ladder ────────────────────────────────────────────────────────────

  function emptyResult() {
    return {
      step: null, kind: null,
      canonical: { pages: [], tokens: 0, truncated: false },
      items: [], tokens: 0, truncated: false, incomplete: false,
      skipped: [], queued: [],
      stats: { steps: [], connectorsAsked: 0, fetched: 0, cacheHits: 0, latencyMs: 0 },
    };
  }

  async function run({ question, keywords, human, transport, budget }, out) {
    const deadline = createDeadline(lc.timeout_ms);
    const raw = queryTerms(question, keywords);
    const terms = [...new Set(tokenize(raw.join(' ')))];
    if (!terms.length) return;
    if (!limiter.hit(`caller:${human.id}`, lc.rate.per_caller_per_minute)) {
      out.skipped.push({ step: 'all', reason: 'rate limit for this caller' });
      return;
    }

    const b = await brain.current();
    const opts = { terms, limit: cfg.search.limit, minScore: cfg.search.min_score, minCoverage: cfg.search.min_coverage };
    const privileged = !anonymize && minRank >= 0 && roleRank(human) >= minRank;
    let found = null;
    let fetchedDocs = [];

    try {
      if (steps.includes('sources')) {
        out.stats.steps.push('sources');
        const r = searchPassages(sourceIndex(b), question, opts);
        if (r.answered) found = { step: 'sources', kind: 'source', results: r.results };
      }

      const needsConnectorList = privileged && (steps.includes('staged') || (steps.includes('connectors') && lc.send_query && transport !== 'stdio'));
      let connectors = [];
      let rejected = new Set();
      if (!found && needsConnectorList) {
        try { connectors = (await ctx.connectors.list()) || []; } catch (err) { log.warn('live lookup: could not list connectors', { error: err.message }); }
        rejected = await rejectedShas();
      }

      if (!found && privileged && steps.includes('staged') && deadline.left() > 0) {
        out.stats.steps.push('staged');
        const r = searchPassages(await stagedIndex(b, connectors, rejected), question, opts);
        if (r.answered) found = { step: 'staged', kind: 'unreviewed', results: r.results };
      }

      if (!found && privileged && steps.includes('connectors') && lc.send_query && transport !== 'stdio') {
        out.stats.steps.push('connectors');
        try { await connectorDocs({ connectors, raw, rejected, deadline, out, docs: fetchedDocs }); }
        catch (err) { if (!(err instanceof Timeout)) throw err; out.incomplete = true; }
        // A deadline that passes mid-way still ranks whatever was fetched before it.
        const r = searchPassages(buildPassageIndex(fetchedDocs), question, opts);
        if (r.answered) found = { step: 'connectors', kind: 'unreviewed', results: r.results };
      }
    } catch (err) {
      if (err instanceof Timeout) out.incomplete = true;
      else throw err;
    }

    if (!found) return;

    const canonical = await canonicalPass(question, raw, budget);
    const packed = packPassages(found.results, Math.max(0, budget - canonical.tokens));
    if (!packed.items.length) return;

    out.step = found.step;
    out.kind = found.kind;
    out.canonical = canonical;
    out.items = packed.items;
    out.tokens = canonical.tokens + packed.tokens;
    out.truncated = canonical.truncated || packed.truncated;

    if (found.step === 'connectors') {
      const refs = packed.items.map((i) => i.doc.meta?.sourceRef).filter((r) => r && r.change !== 'unchanged');
      await enrich(refs, { question, human, out });
    }
  }

  /**
   * @param {object} q
   * @param {string} q.question
   * @param {string[]} [q.keywords]  from the chat; replaces the question's own words
   * @param {object} q.human         the human the connection acts for
   * @param {string} [q.transport]   'stdio' | 'http' | 'memory'
   * @param {number} q.budget        tokens, shared by canonical sections and passages
   * @returns {Promise<{
   *   step: 'sources'|'staged'|'connectors'|null, kind: 'source'|'unreviewed'|null,
   *   canonical: { pages: Array<{ page: object, sections: Array<{ name: string, text: string }> }>, tokens: number, truncated: boolean },
   *   items: Array<{ doc: { key: string, title: string, kind: string, meta: object }, passages: Array<{ marker: string, locator: string, text: string, part: number }> }>,
   *   tokens: number, truncated: boolean, incomplete: boolean,
   *   skipped: Array<{ step: string, reason: string }>, queued: Array<{ jobId: string, connector: string, ref: string }>,
   *   stats: { steps: string[], connectorsAsked: number, fetched: number, cacheHits: number, latencyMs: number }
   * }>}
   *   `step` is null when nothing answered; then every other field is empty or a note about a limit.
   */
  async function find({ question, keywords, human, transport = 'memory', budget }) {
    const out = emptyResult();
    if (inLookup.getStore()) {                // a lookup never starts another lookup
      out.skipped.push({ step: 'all', reason: 'nested lookup' });
      return out;
    }
    const t0 = performance.now();
    try {
      await inLookup.run(true, () => run({ question, keywords, human, transport, budget }, out));
    } catch (err) {
      log.warn('live lookup failed', { error: err.stack || err.message });
    }
    out.stats.latencyMs = Math.round(performance.now() - t0);
    return out;
  }

  return { find };
}
