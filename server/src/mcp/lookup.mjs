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
import { sanitiseTerms } from '../connectors/index.mjs';
import { parseSnapshotHeader, snapshotRelPath } from '../connectors/snapshot-file.mjs';

import { verifyPathFor } from './citations.mjs';
import { LOOKUP_BUDGET_SPLIT } from './config.mjs';
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
/** Share of the token budget canonical sections may take (the split lives in config.mjs, next to the weak-match share). */
export const CANONICAL_SHARE = LOOKUP_BUDGET_SPLIT.canonical;
export const CANONICAL_PAGES = 3;

const STEPS = ['sources', 'staged', 'connectors'];
/** A source file or snapshot bigger than this is not read. */
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
/** The sources step reads at most this much text in all; the rest of the manifest is left out. */
export const MAX_SOURCE_INDEX_BYTES = 64 * 1024 * 1024;
/** Entries kept in the negative cache and in the rate limiter, each; the oldest go first. */
export const MAX_CACHE_ENTRIES = 1000;
const MINUTE = 60_000;
/** Same list as `TEXT_EXT` in citations.mjs: what counts as a text original. */
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|html?|xml|rst|adoc|org|vtt|srt)$/i;
const CLOSED_PROPOSAL = new Set(['merged', 'rejected', 'superseded']);

/** What goes in a log line about a failure: its class or code, never its message, which may echo the query. */
const errName = (err) => String(err?.code || err?.name || 'Error').slice(0, 60);

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
      seen.delete(key);                        // re-insert last, so the map stays oldest-first
      if (recent.length >= limit) { seen.set(key, recent); trim(); return false; }
      recent.push(now);
      seen.set(key, recent);
      trim();
      return true;
    },
    size: () => seen.size,
  };
  function trim() {
    while (seen.size > MAX_CACHE_ENTRIES) seen.delete(seen.keys().next().value);
  }
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
  const negative = new Map();            // `${connector}|${sorted sanitised terms}` → expiry ms, oldest first
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
    catch (err) { log.warn('live lookup: could not read the rejected list', { error: errName(err) }); return new Set(); }
  }

  // ── step 1: committed source text ─────────────────────────────────────────

  let sourceCache = { sha: '', index: null, docs: 0 };

  function sourceIndex(b) {
    if (sourceCache.sha === b.sha && sourceCache.index) return sourceCache.index;
    let root;
    try { root = fs.realpathSync(path.resolve(b.snap.dir)); } catch { root = path.resolve(b.snap.dir); }
    const docs = [];
    const seenPaths = new Set();
    let total = 0;
    let capped = false;
    for (const e of b.manifest.entries) {
      if (e.status === 'missing') continue;
      // Connector snapshots are committed byte for byte, never anonymized; with anonymization on they stay out.
      if (anonymize && e.kind === 'connector') continue;
      const rel = verifyPathFor({ id: e.id, path: e.path }, b.manifest);
      if (!rel || seenPaths.has(rel)) continue;
      // Only text: the extracted sidecar, or an original with a text extension. Never a committed binary.
      const isSidecar = Boolean(e.extracted) && e.extracted !== 'none' && rel === e.extracted;
      if (!isSidecar && !TEXT_EXT.test(rel)) continue;
      const abs = path.resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) continue;
      let text;
      try {
        const real = fs.realpathSync(abs);                     // follows symlinks: where the bytes really are
        if (real !== root && !real.startsWith(root + path.sep)) continue;
        const st = fs.statSync(real);
        if (!st.isFile()) continue;
        if (st.size > MAX_SOURCE_BYTES) { capped = true; continue; }
        if (total + st.size > MAX_SOURCE_INDEX_BYTES) { capped = true; continue; }
        text = fs.readFileSync(real, 'utf-8');
        total += st.size;
      } catch { continue; }                 // no sidecar, or an ephemeral snapshot: nothing to search
      seenPaths.add(rel);
      docs.push({ key: e.id || rel, title: b.sourceTitles.get(e.id) || path.basename(rel), kind: 'source', text, meta: { sourceId: e.id, path: rel } });
    }
    if (capped) log.warn('live lookup: the sources step left out files over its size caps', { per_file_bytes: MAX_SOURCE_BYTES, total_bytes: MAX_SOURCE_INDEX_BYTES });
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
        meta: { connector, server: header.server || '', ref: header.ref || '', sha256: sha256(text), bytes: Buffer.byteLength(text), fetchedAt: new Date(stat.mtimeMs).toISOString(), via: 'staged' },
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

  /** Fixed text. The question is never in it: the ingest agent is told to follow instructions, and a chat wrote the question. */
  const INSTRUCTIONS = 'Fetched by live lookup to answer a question asked in a chat.';

  /** The question, for the proposal page only, and only when queries are stored plain. A separate job field, not shown to the agent as instructions. */
  const questionField = (question) => (storeQueries === 'plain'
    ? { lookupQuestion: String(question).replace(/\s+/g, ' ').trim().slice(0, 500) }
    : {});

  /**
   * Queue each ref as an ingest job, under the daily cap and the queue's dedup.
   * Results go into `sink`, which stops taking them once the answer has been
   * sent (`sink.closed`), so a late enqueue never changes a result already returned.
   */
  async function queueRefs(refs, { question, human, sink }) {
    if (lc.ingest !== 'auto' || !ctx.ingest?.enqueue) return;
    for (const ref of refs) {
      await serial(async () => {
        try {
          const day = new Date().toISOString().slice(0, 10);
          const used = (await ctx.store.kv.get(INGEST_COUNT_NS, day))?.n || 0;
          if (used >= lc.max_ingest_per_day) {
            if (!sink.closed) sink.skipped.push({ step: 'ingest', reason: 'the daily limit on documents queued for review is reached' });
            return;
          }
          const job = await ctx.ingest.enqueue({
            kind: 'ingest', trigger: 'lookup', source: ref, requestedBy: svc.id, onBehalfOf: human.id,
            instructions: INSTRUCTIONS, ...questionField(question),
          });
          if (!job?.id) return;
          // A job that dedup returned already existed: it was counted when it was made.
          if (job.deduplicated !== true) await ctx.store.kv.set(INGEST_COUNT_NS, day, { n: used + 1 });
          if (!sink.closed) sink.queued.push({ jobId: job.id, connector: ref.connector, ref: ref.ref });
        } catch (err) {
          log.warn('live lookup: could not queue a fetched document for review', { connector: ref.connector, error: errName(err) });
        }
      });
    }
  }

  /** Is there a live ingest job, or an open proposal, for this staged document? */
  async function reviewExists(doc) {
    try {
      const jobs = (await ctx.ingest?.list?.({ kind: 'ingest' })) || [];
      for (const j of jobs) {
        if (j.source?.connector !== doc.meta.connector || j.source?.sha256 !== doc.meta.sha256) continue;
        if (j.status === 'queued' || j.status === 'running') return true;
        if (j.status !== 'succeeded' && j.status !== 'blocked') continue;     // failed or cancelled: nothing is waiting
        if (!j.proposalId) return true;
        let p;
        try { p = await ctx.governance.getProposal(j.proposalId); } catch { p = { status: 'open' }; }
        if (p && !CLOSED_PROPOSAL.has(p.status)) return true;
      }
    } catch (err) { log.warn('live lookup: could not list ingest jobs', { error: errName(err) }); }
    return false;
  }

  /** A SourceRef for a snapshot fetched earlier, as `ctx.connectors` would have made it. */
  function stagedRef(doc, b, connectors) {
    const m = doc.meta;
    if (!m.ref) return null;
    const c = connectors.find((x) => x.id === m.connector) || {};
    const id = `${m.connector}:${m.ref}`;
    return {
      kind: 'connector', id, connector: m.connector, ref: m.ref, server: m.server || c.label || '',
      path: snapshotRelPath(ctx.config.v1?.brainDir || 'brain', m.connector, m.ref),
      version: '', sha256: m.sha256, bytes: m.bytes || 0, truncated: false, title: doc.title,
      label: c.label || '', tier: c.tier || 'evidence', snapshot: c.snapshot || 'commit',
      change: b.manifest.byId?.has(id) ? 'changed' : 'new', fetchedAt: m.fetchedAt, via: 'lookup',
    };
  }

  // ── step 3: connectors ────────────────────────────────────────────────────

  async function connectorDocs({ connectors, raw, human, rejected, deadline, out, docs }) {
    const termKey = sanitiseTerms(raw).map((t) => t.toLowerCase()).sort().join(' ');
    if (!termKey) return;                                  // nothing a provider would be asked
    let fetchBudget = Math.max(0, Number(lc.max_fetch) || 0);
    let charged = false;
    for (const c of connectors) {
      if (!c.lookup || !c.searchable || fetchBudget <= 0) continue;
      const key = `${c.id}|${termKey}`;
      const until = negative.get(key);
      if (until !== undefined) {
        if (until > Date.now()) { out.stats.cacheHits += 1; continue; }
        negative.delete(key);                              // expired
      }
      // The per-caller limit protects the providers, so it is charged only when a call is about to go out.
      if (!charged) {
        if (!limiter.hit(`caller:${human.id}`, lc.rate.per_caller_per_minute)) { out.skipped.push({ step: 'all', reason: 'rate limit for this caller' }); return; }
        charged = true;
      }
      if (!limiter.hit(`connector:${c.id}`, lc.rate.per_connector_per_minute)) { out.skipped.push({ step: 'connectors', reason: `rate limit for connector ${c.id}` }); continue; }
      out.stats.connectorsAsked += 1;
      out.stats.connectors.push(c.id);
      let items;
      try { items = await deadline.within(ctx.connectors.search(c.id, { terms: raw, limit: Math.max(lc.max_fetch * 2, 5) })); }
      catch (err) {
        if (err instanceof Timeout) throw err;
        log.warn('live lookup: connector search failed', { connector: c.id, error: errName(err) });
        continue;
      }
      if (!items?.length) {
        negative.delete(key);
        negative.set(key, Date.now() + lc.negative_ttl_minutes * MINUTE);
        while (negative.size > MAX_CACHE_ENTRIES) negative.delete(negative.keys().next().value);
        continue;
      }
      for (const item of items) {
        if (fetchBudget <= 0) break;
        if (!limiter.hit(`connector:${c.id}`, lc.rate.per_connector_per_minute)) { out.skipped.push({ step: 'connectors', reason: `rate limit for connector ${c.id}` }); break; }
        fetchBudget -= 1;
        let got;
        try { got = await deadline.within(ctx.connectors.fetchOne(c.id, item)); }
        catch (err) {
          if (err instanceof Timeout) throw err;
          log.warn('live lookup: fetching a document failed', { connector: c.id, error: errName(err) });
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
      stats: { steps: [], connectorsAsked: 0, connectors: [], fetched: 0, cacheHits: 0, latencyMs: 0 },
    };
  }

  async function run({ question, keywords, human, transport, budget }, out) {
    const deadline = createDeadline(lc.timeout_ms);
    const raw = queryTerms(question, keywords);
    const terms = [...new Set(tokenize(raw.join(' ')))];
    if (!terms.length) return;

    const b = await brain.current();
    const opts = { terms, limit: cfg.search.limit, minScore: cfg.search.min_score, minCoverage: cfg.search.min_coverage };
    const privileged = !anonymize && minRank >= 0 && roleRank(human) >= minRank;
    let found = null;
    let fetchedDocs = [];
    let connectors = [];

    try {
      if (steps.includes('sources')) {
        out.stats.steps.push('sources');
        const r = searchPassages(sourceIndex(b), question, opts);
        if (r.answered) found = { step: 'sources', kind: 'source', results: r.results };
      }

      const needsConnectorList = privileged && (steps.includes('staged') || (steps.includes('connectors') && lc.send_query && transport !== 'stdio'));
      let rejected = new Set();
      if (!found && needsConnectorList) {
        try { connectors = (await ctx.connectors.list()) || []; } catch (err) { log.warn('live lookup: could not list connectors', { error: errName(err) }); }
        rejected = await rejectedShas();
      }

      if (!found && privileged && steps.includes('staged') && deadline.left() > 0) {
        out.stats.steps.push('staged');
        const r = searchPassages(await stagedIndex(b, connectors, rejected), question, opts);
        if (r.answered) found = { step: 'staged', kind: 'unreviewed', results: r.results };
      }

      if (!found && privileged && steps.includes('connectors') && lc.send_query && transport !== 'stdio') {
        out.stats.steps.push('connectors');
        try { await connectorDocs({ connectors, raw, human, rejected, deadline, out, docs: fetchedDocs }); }
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
    // The weak page matches `ask` prints keep their share; the passages get the rest.
    const room = Math.max(0, Math.floor(budget * (1 - LOOKUP_BUDGET_SPLIT.weak)) - canonical.tokens);
    const packed = packPassages(found.results, room);
    if (!packed.items.length) return;

    let items = packed.items;
    let toQueue = [];
    if (found.step === 'connectors') {
      toQueue = items.map((i) => i.doc.meta?.sourceRef).filter((r) => r && r.change !== 'unchanged');
    } else if (found.step === 'staged') {
      // A staged snapshot may have no job at all (the cap was reached, the queue failed, the deadline passed).
      // Say "waiting for review" only when one exists; otherwise queue it now.
      items = [];
      for (const item of packed.items) {
        const exists = await reviewExists(item.doc);
        items.push({ ...item, doc: { ...item.doc, meta: { ...item.doc.meta, review: exists ? 'waiting' : 'none' } } });
        const ref = exists ? null : stagedRef(item.doc, b, connectors);
        if (ref) toQueue.push(ref);
      }
    }

    // Queue in the background: the answer waits for it only until the deadline.
    const sink = { closed: false, queued: [], skipped: [] };
    if (toQueue.length) {
      const work = queueRefs(toQueue, { question, human, sink });
      try { await deadline.within(work); }
      catch (err) {
        if (!(err instanceof Timeout)) throw err;
        sink.closed = true;
        // A lookup already marked incomplete says so; otherwise say that the job may still appear.
        if (!out.incomplete) sink.skipped.push({ step: 'ingest', reason: 'queueing for review took too long and finishes in the background' });
      }
      sink.closed = true;
      if (found.step === 'staged') {
        const done = new Set(sink.queued.map((q) => `${q.connector}\n${q.ref}`));
        for (const item of items) if (done.has(`${item.doc.meta.connector}\n${item.doc.meta.ref}`)) item.doc.meta.review = 'waiting';
      }
    }

    out.step = found.step;
    out.kind = found.kind;
    out.canonical = canonical;
    out.items = items;
    out.tokens = canonical.tokens + packed.tokens;
    out.truncated = canonical.truncated || packed.truncated;
    out.queued = sink.queued;
    out.skipped.push(...sink.skipped);
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
      log.warn('live lookup failed', { error: errName(err) });
    }
    out.stats.latencyMs = Math.round(performance.now() - t0);
    return out;
  }

  /** Entries held in memory, for tests and for a look at how full the caps are. */
  const sizes = () => ({ negative: negative.size, limiter: limiter.size() });

  return { find, sizes };
}
