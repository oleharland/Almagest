/**
 * connectors — WS2. Spec: docs/v2/spec.md → Connectors; guide: docs/v2/connectors.md.
 *
 * Any MCP server as an input. For each configured connector the service
 * connects as an MCP client, lists items through a recipe, fetches and renders
 * each one to a text snapshot with locator markers, fingerprints the snapshot
 * (sha256 of its bytes — the service fingerprints, never the agent), compares
 * it with the manifest **on main**, and hands back a SourceRef for every item
 * that is new or changed. It never writes to git: snapshots are staged under
 * `.almagest/connector-snapshots/`, and the ingest runner copies one into its
 * job worktree with `materialize()`.
 *
 *   ctx.connectors.list()                      → [{ id, mcp, recipe, schedule, lastSync, live, about, repo, … }]
 *   ctx.connectors.sync(id, { since?, full?, dryRun? }) → [SourceRef]   (refuses a connector whose recipe is `live`)
 *   ctx.connectors.syncDetailed(id, opts)      → { refs, unchanged, missing, errors, … }
 *   ctx.connectors.search(id, { terms, limit }) → [{ ref, title, version, mime }]   live lookup; needs `lookup: true` + a recipe `search` block
 *   ctx.connectors.fetchOne(id, item)          → { ref: SourceRef (via: 'lookup'), text, sha256, title, truncated, reused }
 *                                                 a `live` recipe: { live: true, fetchedAt, server, text, sha256, title, truncated }, nothing written, no SourceRef
 *   ctx.connectors.snapshotPath(ref)           → 'brain/raw/extracted/<connector>/<slug>.txt'
 *   ctx.connectors.stagedPath(ref)             → abs path of the staged snapshot
 *   ctx.connectors.materialize(ref, worktree)  → copies the staged snapshot in, sha-checked
 *   ctx.connectors.stop()
 *
 * Store namespaces:  connector-cursor (id) · connector-item (<id>:<ref>) · connector-lookup (<id>:<ref>,
 *                     { at, title, failures, checkedAt } — refs fetched by live lookup; the sync re-checks them by ref) ·
 *                     connector-oauth (server, sealed)
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadManifest } from '../../../tools/lib/config.mjs';
import { newId, nowIso } from '../core/schemas.mjs';
import { DEFAULT_MAX_ITEMS, DEFAULT_SEARCH_LIMIT, fetchItem, listItems, resolveVars, searchItems } from './execute.mjs';
import { draftRecipe } from './init.mjs';
import { createPool, DEFAULT_TIMEOUT_MS, NeedsLoginError, readMcpJson, resolveServer } from './mcp-client.mjs';
import { createOAuthProvider, hasLogin, login as oauthLogin } from './oauth.mjs';
import { recipeFor, RECIPES_DIR } from './recipes.mjs';
import { flattenField } from './render.mjs';
import { buildSnapshot, DEFAULT_MAX_BYTES, sha256, snapshotRelPath, stagingAbsPath } from './snapshot-file.mjs';

export const CURSOR_NS = 'connector-cursor';
export const ITEM_NS = 'connector-item';
export const LOOKUP_NS = 'connector-lookup';
// Raw titles of search hits that flattening changed, kept until the hit is fetched, so a restart does not lose them.
const TITLE_NS = 'connector-lookup-title';
export const MAX_SEARCH_TERMS = 8;
export const MAX_TERM_CHARS = 64;
export const MAX_QUERY_CHARS = 200;
export const MAX_TITLE_CHARS = 200;
/** A document that failed this many re-checks in a row, on complete syncs, is reported missing. */
export const LOOKUP_MAX_FAILURES = 3;
const MAX_SEARCH_LIMIT = 50;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Terms come from a chat, so they are untrusted. Keep only letters, digits
 * (any script), spaces, hyphens, underscores and dots, so a term cannot close a
 * quote or add an operator in a provider's query syntax. Everything else is
 * dropped, whitespace collapses, empty terms go, and the number of terms and
 * the total length are capped.
 */
export function sanitiseTerms(terms) {
  const list = Array.isArray(terms) ? terms : terms == null ? [] : [terms];
  const out = [];
  let total = 0;
  for (const t of list) {
    if (out.length >= MAX_SEARCH_TERMS) break;
    if (typeof t !== 'string' && typeof t !== 'number') continue;
    let s = String(t).normalize('NFKC')
      .replace(/\s+/gu, ' ')
      .replace(/[^\p{L}\p{N} _.-]/gu, '')
      // A word that starts with `-` or `.` could act as a negation or operator in a
      // provider's full-text syntax; one with no letter or digit is only operators.
      .split(' ')
      .map((w) => w.replace(/^[.-]+/, ''))
      .filter((w) => /[\p{L}\p{N}]/u.test(w))
      .join(' ')
      .slice(0, MAX_TERM_CHARS)
      .trim();
    if (!s) continue;
    if (total + s.length + (out.length ? 1 : 0) > MAX_QUERY_CHARS) {
      s = s.slice(0, Math.max(0, MAX_QUERY_CHARS - total - (out.length ? 1 : 0))).trim();
      if (!s) break;
    }
    total += s.length + (out.length ? 1 : 0);
    out.push(s);
  }
  return out;
}

export async function create(ctx) {
  return createConnectors(ctx);
}

/**
 * @param {object} ctx
 * @param {object} [options]
 * @param {(spec, extra) => Promise<{client, close}>} [options.connect]  replace the transport layer (tests)
 * @param {object} [options.env]     environment for `${VAR}` expansion
 * @param {string} [options.recipesDir]
 */
export function createConnectors(ctx, options = {}) {
  const { config, store, bus, log, repoRoot } = ctx;
  const env = options.env || process.env;
  const recipesDir = options.recipesDir || RECIPES_DIR;
  const brainDir = config.v1?.brainDir || 'brain';
  const stateDir = config.paths.state;

  const configured = config.sources.connectors || [];
  const byId = new Map();
  for (const c of configured) {
    if (!c?.id || !ID_RE.test(String(c.id))) throw new Error(`connector id "${c?.id}" must be kebab-case (it becomes a directory name)`);
    if (byId.has(c.id)) throw new Error(`connector id "${c.id}" is defined twice`);
    byId.set(c.id, c);
  }

  const pool = createPool({
    connect: options.connect,
    log,
    authProviderFor: (spec, extra = {}) => {
      const oauth = extra.oauth && typeof extra.oauth === 'object' ? extra.oauth : {};
      return createOAuthProvider({
        store,
        serverKey: spec.key,
        scope: oauth.scope,
        staticClient: oauth.client_id ? { client_id: oauth.client_id, ...(oauth.client_secret ? { client_secret: oauth.client_secret } : {}) } : undefined,
      });
    },
  });

  function connector(id) {
    const c = byId.get(id);
    if (!c) throw new Error(`no connector "${id}" (configured: ${[...byId.keys()].join(', ') || 'none'})`);
    return c;
  }

  function serverSpec(mcp) {
    const spec = resolveServer(mcp, { mcpServers: readMcpJson(config.paths.mcpJson), env, cwd: repoRoot });
    if (spec.missingEnv.length) log?.warn('MCP server config references unset variables', { server: spec.label, missing: spec.missingEnv });
    return spec;
  }

  const timeoutOf = (c) => Number(c.timeout_seconds) > 0 ? Number(c.timeout_seconds) * 1000 : DEFAULT_TIMEOUT_MS;

  async function clientFor(c) {
    const spec = serverSpec(c.mcp);
    try {
      return { spec, client: await pool.get(spec, { oauth: c.oauth }) };
    } catch (err) {
      if (err?.code === 'NEEDS_LOGIN') throw new NeedsLoginError(c.id);
      throw err;
    }
  }

  function snapshotPath(ref) {
    if (ref?.path && ref.kind === 'connector') return ref.path;
    return snapshotRelPath(brainDir, ref.connector, ref.ref);
  }

  function stagedPath(ref) {
    return stagingAbsPath(stateDir, ref.connector, ref.ref);
  }

  /**
   * Copy a staged snapshot into a job worktree at its sidecar path. Refuses
   * when the staged bytes no longer hash to the SourceRef's sha256 — a later
   * sync replaced them — because the job would otherwise ingest content
   * nobody fingerprinted for it.
   */
  async function materialize(ref, worktreeDir) {
    const src = stagedPath(ref);
    if (!fs.existsSync(src)) throw new Error(`no staged snapshot for ${ref.id} — run the connector sync again`);
    const bytes = fs.readFileSync(src);
    const actual = sha256(bytes);
    if (ref.sha256 && actual !== ref.sha256) {
      throw new Error(`staged snapshot for ${ref.id} is ${actual.slice(0, 8)}, the job expects ${String(ref.sha256).slice(0, 8)} — re-sync`);
    }
    const rel = snapshotPath(ref);
    const dst = path.join(worktreeDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (!fs.existsSync(dst) || sha256(fs.readFileSync(dst)) !== actual) fs.writeFileSync(dst, bytes);
    return rel;
  }

  async function list() {
    const out = [];
    for (const c of byId.values()) {
      const cursor = (await store.kv.get(CURSOR_NS, c.id)) || {};
      let searchable = false;
      let live = false;
      let about = [];
      try {
        const recipe = recipeFor(c, { repoRoot, dir: recipesDir });
        searchable = Boolean(recipe.search);
        live = recipe.live === true;
        about = Array.isArray(recipe.about) ? recipe.about.map(String) : [];
      } catch { searchable = false; }
      out.push({
        id: c.id,
        mcp: typeof c.mcp === 'string' ? c.mcp : c.mcp?.url || c.mcp?.command || 'inline',
        recipe: c.recipe || 'mcp-resources',
        schedule: c.schedule || '',
        label: c.label || '',
        tier: c.tier || 'evidence',
        snapshot: c.snapshot || 'commit',
        fromV1Remote: Boolean(c.fromV1Remote),
        lookup: c.lookup === true,
        searchable,
        // A live recipe describes current state: lookup answers from it, and a sync refuses it.
        live,
        // What a question may mention to point at this connector (live lookup's pre-check): the recipe's own words
        // and the repository `lookup` would search.
        about,
        repo: String((c.lookup_select || c.select)?.repo || ''),
        since: cursor.since || '',
        lastSync: cursor.lastSync || null,
      });
    }
    return out;
  }

  /** Main's manifest — never the checkout's, which may be on an ingest branch. */
  async function mainManifest() {
    const snap = await ctx.snapshot.load();
    return loadManifest(snap.dir, config.v1.manifestPath);
  }

  function findEntry(manifest, c, key, relPath, item) {
    const direct = manifest.byId.get(key) || manifest.byPath.get(relPath);
    if (direct) return { entry: direct, previous: null };
    // A v1 `sources.remote` file ingested before connectors existed: same
    // source, older record. The ref names it so the agent supersedes the old
    // entry instead of creating a second one.
    if (c.fromV1Remote) {
      const old = manifest.entries.find((e) => e.kind === 'remote' && e.path === item.ref && (!e.repo || e.repo === c.select?.repo));
      if (old) return { entry: null, previous: old };
    }
    return { entry: null, previous: null };
  }

  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return results;
  }

  /** A recipe whose `fetch` makes a call can fetch an item from its ref alone. */
  const canFetchByRef = (recipe) => recipe.fetch?.tool !== undefined || recipe.fetch?.method !== undefined;

  /**
   * The one place an item becomes a snapshot: reuse the staged bytes when the
   * version still matches, else fetch; build the snapshot; compare it with the
   * manifest on main; stage it; record it in `connector-item`. Used by the sync
   * and by live lookup, so both produce the same SourceRef.
   *
   * @param {object} run  { c, id, recipe, vars, client, spec, timeoutMs, maxBytes, manifest, startedAt }
   * @returns {{ snap, ref, reused: boolean, fetched: boolean }}  `ref.change` is new | changed | unchanged | reappeared
   */
  async function stageItem(run, item, { dryRun = false, via = '' } = {}) {
    const { c, id, recipe, vars, client, spec, timeoutMs, maxBytes, manifest, startedAt } = run;
    const key = `${id}:${item.ref}`;
    const relPath = snapshotRelPath(brainDir, id, item.ref);
    const stage = stagingAbsPath(stateDir, id, item.ref);
    const prior = await store.kv.get(ITEM_NS, key);

    // `version` only ever saves a fetch. It is trusted exactly as far as
    // the staged bytes still hash to what was fingerprinted last time.
    let snap = null;
    let reused = false;
    let fetched = false;
    if (item.version && prior?.version === item.version && fs.existsSync(stage)) {
      const text = fs.readFileSync(stage, 'utf-8');
      const digest = sha256(text);
      if (digest === prior.sha256) { snap = { text, sha256: digest, bytes: Buffer.byteLength(text), truncated: Boolean(prior.truncated), title: prior.title }; reused = true; }
    }
    if (!snap) {
      const out = await fetchItem(client, recipe, item, vars, { timeoutMs });
      fetched = true;
      snap = { ...buildSnapshot({ connector: id, server: spec.label, ref: item.ref, title: out.title, body: out.body, maxBytes }), title: out.title };
    }

    const { entry, previous } = findEntry(manifest, c, key, relPath, item);
    const expected = entry ? entry.extractedSha256 || entry.sha256 : '';
    const change = !entry ? (previous ? 'changed' : 'new')
      : expected !== snap.sha256 ? 'changed'
        : entry.status === 'missing' ? 'reappeared'
          : 'unchanged';

    if (!dryRun) {
      if (!fs.existsSync(stage) || sha256(fs.readFileSync(stage)) !== snap.sha256) {
        fs.mkdirSync(path.dirname(stage), { recursive: true });
        fs.writeFileSync(stage, snap.text);
      }
      // `via` says who owns the record: absent when a sync listing wrote it (so also for records
      // from before this field), 'lookup' when only live lookup has ever fetched it. A lookup
      // fetch keeps the owner a sync record already has.
      const owner = via === 'lookup' && (!prior || prior.via === 'lookup') ? { via: 'lookup' } : {};
      await store.kv.set(ITEM_NS, key, { version: item.version, sha256: snap.sha256, title: snap.title, truncated: snap.truncated, path: relPath, syncedAt: startedAt, ...owner });
    }

    const ref = {
      kind: 'connector',
      id: key,
      connector: id,
      ref: item.ref,
      server: spec.label,
      path: relPath,
      version: item.version || '',
      ...(item.commit ? { commit: item.commit } : {}),
      sha256: snap.sha256,
      bytes: snap.bytes,
      truncated: snap.truncated,
      title: snap.title || item.title,
      label: c.label || '',
      tier: c.tier || 'evidence',
      snapshot: c.snapshot || 'commit',
      change,
      ...(previous ? { supersedes: previous.id } : {}),
      fetchedAt: startedAt,
    };
    return { snap, ref, reused, fetched };
  }

  /**
   * The whole sync, with everything it learned. `sync()` returns just `.refs`.
   *
   * @param {string} id
   * @param {object} [opts]
   * @param {string} [opts.since]   override the stored cursor ('' = full listing)
   * @param {boolean} [opts.full]   same as since: ''
   * @param {boolean} [opts.dryRun] fetch and fingerprint, write nothing, emit nothing
   */
  async function syncDetailed(id, opts = {}) {
    const c = connector(id);
    const recipe = recipeFor(c, { repoRoot, dir: recipesDir });
    if (recipe.live === true) {
      throw new Error(`connector "${id}": recipe "${recipe.name}" is live, so it is answered from and never ingested. Live sources describe current state; a sync would put a list into the wiki that is out of date once it is reviewed`);
    }
    const timeoutMs = timeoutOf(c);
    const maxBytes = Number(c.max_bytes) > 0 ? Number(c.max_bytes) : DEFAULT_MAX_BYTES;
    const startedAt = nowIso();
    const cursorState = (await store.kv.get(CURSOR_NS, id)) || {};
    const since = opts.full ? '' : opts.since !== undefined ? String(opts.since) : String(cursorState.since || '');

    const { spec, client } = await clientFor(c);
    let vars = { since, select: c.select || {}, connector: { id, label: c.label || '' } };
    vars = await resolveVars(client, recipe, vars, { timeoutMs });
    const { items, complete } = await listItems(client, recipe, vars, {
      timeoutMs,
      maxItems: Number(c.max_items) > 0 ? Number(c.max_items) : undefined,
    });
    const manifest = await mainManifest();

    const refs = [];
    const unchanged = [];
    const errors = [];
    let fetched = 0;
    let reused = 0;

    const run = { c, id, recipe, vars, client, spec, timeoutMs, maxBytes, manifest, startedAt };
    const stage = async (item) => {
      const key = `${id}:${item.ref}`;
      const done = await stageItem(run, item, { dryRun: opts.dryRun });
      if (done.reused) reused++;
      if (done.fetched) fetched++;
      if (done.ref.change === 'unchanged') unchanged.push(key);
      else refs.push(done.ref);
    };
    const handle = async (item) => {
      try {
        await stage(item);
      } catch (err) {
        errors.push({ id: `${id}:${item.ref}`, ref: item.ref, error: err.message });
        log?.warn('connector item failed', { connector: id, ref: item.ref, error: err.message });
      }
    };

    await mapLimit(items, Number(c.concurrency) > 0 ? Number(c.concurrency) : 4, handle);

    // Disappeared upstream: only a complete listing can say so. Nothing is
    // deleted — the next ingest marks the manifest entry `status: missing`.
    // A ref that came in through live lookup may sit outside `select`, so not
    // being listed says nothing about it: it is fetched again by ref instead.
    // A ref the listing does include is the sync's own, so its mark is cleared.
    const listed = new Set(items.map((i) => i.ref));
    const missing = [];
    const lookedUp = [];
    if (complete) {
      const marks = new Map((await store.kv.list(LOOKUP_NS)).filter((r) => r.key.startsWith(`${id}:`)).map((r) => [r.key, r.value]));
      for (const ref of listed) {
        if (marks.has(`${id}:${ref}`) && !opts.dryRun) await store.kv.delete(LOOKUP_NS, `${id}:${ref}`);
      }
      for (const e of manifest.entries) {
        if (e.kind !== 'connector' || e.connector !== id || e.status === 'missing' || !e.ref || listed.has(e.ref)) continue;
        const mark = marks.get(`${id}:${e.ref}`);
        if (mark) lookedUp.push({ e, mark });
        else missing.push({ id: e.id, ref: e.ref, path: e.extracted || e.path, pages: e.pages });
      }
    }
    if (lookedUp.length && canFetchByRef(recipe)) {
      const cap = Number(c.max_items) > 0 ? Number(c.max_items) : DEFAULT_MAX_ITEMS;
      // Oldest check first, so a bound smaller than the number of marks still reaches every one.
      lookedUp.sort((x, y) => String(x.mark.checkedAt || '').localeCompare(String(y.mark.checkedAt || '')));
      await mapLimit(lookedUp.slice(0, cap), Number(c.concurrency) > 0 ? Number(c.concurrency) : 4, async ({ e, mark }) => {
        const key = `${id}:${e.ref}`;
        // The title is the one the search gave: it is part of the snapshot header, so
        // fetching with another would make an untouched document look changed.
        const item = { ref: e.ref, version: '', title: mark.title || e.ref, commit: '', mime: '' };
        let failures = 0;
        try {
          await stage(item);
        } catch (err) {
          failures = (Number(mark.failures) || 0) + 1;
          if (failures >= LOOKUP_MAX_FAILURES) {
            // Gone for good: report it like any disappeared item and stop fetching it.
            missing.push({ id: e.id, ref: e.ref, path: e.extracted || e.path, pages: e.pages });
            if (!opts.dryRun) await store.kv.delete(LOOKUP_NS, key);
            log?.warn('connector lookup ref gone', { connector: id, ref: e.ref, error: err.message });
            return;
          }
          errors.push({ id: key, ref: e.ref, error: err.message });
          log?.warn('connector item failed', { connector: id, ref: e.ref, error: err.message });
        }
        if (!opts.dryRun) await store.kv.set(LOOKUP_NS, key, { ...mark, failures, checkedAt: nowIso() });
      });
    }

    refs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const summary = {
      connectorId: id,
      at: startedAt,
      finishedAt: nowIso(),
      since,
      listed: items.length,
      complete,
      fetched,
      reused,
      refs,
      unchanged: unchanged.sort(),
      missing,
      errors,
      dryRun: Boolean(opts.dryRun),
    };

    if (!opts.dryRun) {
      const lastSync = { at: startedAt, finishedAt: summary.finishedAt, listed: items.length, changed: refs.length, unchanged: unchanged.length, missing: missing.length, errors: errors.length, complete };
      // The cursor only advances on a clean run, so a failed item is listed again next time.
      await store.kv.set(CURSOR_NS, id, { since: errors.length ? cursorState.since || '' : startedAt, lastSync });
      bus.emit('connector.synced', { connectorId: id, items: refs, missing, errors });
      log?.info('connector synced', { connector: id, listed: items.length, changed: refs.length, unchanged: unchanged.length, missing: missing.length, errors: errors.length });
    }
    return summary;
  }

  async function sync(id, opts = {}) {
    return (await syncDetailed(id, opts)).refs;
  }

  function requireLookup(c) {
    if (c.lookup !== true) throw new Error(`connector "${c.id}" is not enabled for live lookup (set \`lookup: true\` on it in brain.config.yaml)`);
  }

  // Returned strings are flattened, but the snapshot header is built from the title as the
  // provider gave it, as in a sync; so fetchOne looks the raw title of a hit up here.
  const rawTitles = new Map();
  const flattenRef = (ref) => flattenField(ref, 500);

  const lookupVars = (c) => ({ since: '', select: c.lookup_select || c.select || {}, connector: { id: c.id, label: c.label || '' } });

  /**
   * Live lookup: search the connector for a question. First page only.
   * Terms are sanitised here; with none left the server is not called.
   *
   * @returns {Promise<Array<{ ref: string, title: string, version: string, mime: string }>>}
   */
  async function search(id, { terms, limit } = {}) {
    const c = connector(id);
    requireLookup(c);
    const recipe = recipeFor(c, { repoRoot, dir: recipesDir });
    if (!recipe.search) throw new Error(`connector "${id}": recipe "${recipe.name}" has no \`search\` block, so it cannot be searched`);
    const clean = sanitiseTerms(terms);
    if (!clean.length) return [];
    const cap = Math.min(Number(limit) > 0 ? Math.floor(Number(limit)) : DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const timeoutMs = timeoutOf(c);
    const { client } = await clientFor(c);
    const vars = await resolveVars(client, recipe, lookupVars(c), { timeoutMs });
    const { items } = await searchItems(client, recipe, { ...vars, terms: clean }, { timeoutMs, limit: cap });
    const out = [];
    for (const i of items) {
      // A ref is handed back to fetchOne, so it cannot be rewritten: one that
      // flattening would change (control characters, newlines, over 500 characters)
      // is not offered.
      if (flattenRef(i.ref) !== i.ref) continue;
      // A live document is never staged, so nothing needs its raw title later.
      if (recipe.live !== true) {
        rawTitles.set(`${id}:${i.ref}`, i.title);
        // Flattening can change a title (newlines, a leading #, the length cap), and the snapshot
        // header carries the raw one. Keep those across a restart.
        if (flattenField(i.title, MAX_TITLE_CHARS) !== i.title) await store.kv.set(TITLE_NS, `${id}:${i.ref}`, { title: String(i.title) });
        if (rawTitles.size > 500) rawTitles.delete(rawTitles.keys().next().value);
      }
      out.push({ ref: i.ref, title: flattenField(i.title, MAX_TITLE_CHARS), version: flattenField(i.version), mime: flattenField(i.mime) });
    }
    return out;
  }

  /**
   * A live recipe's document: the search block is run again for the item with this ref (its text comes from the
   * search result, as `fetch` without a call reads the list item), rendered and wrapped in the snapshot header,
   * neutralised and capped like any other fetched text, and handed back. Nothing is written: no staged file, no
   * `connector-item` or `connector-lookup` record, no title record, and no SourceRef that could be queued.
   */
  async function fetchLive(c, recipe, item) {
    const timeoutMs = timeoutOf(c);
    const maxBytes = Number(c.max_bytes) > 0 ? Number(c.max_bytes) : DEFAULT_MAX_BYTES;
    const { spec, client } = await clientFor(c);
    const vars = await resolveVars(client, recipe, lookupVars(c), { timeoutMs });
    const { items } = await searchItems(client, recipe, { ...vars, terms: sanitiseTerms(item.terms) }, { timeoutMs, limit: MAX_SEARCH_LIMIT });
    const hit = items.find((i) => i.ref === String(item.ref));
    if (!hit) throw new Error(`connector "${c.id}": the live document "${flattenField(item.ref, 80)}" is not in the search result any more`);
    const out = await fetchItem(client, recipe, hit, vars, { timeoutMs });
    const fetchedAt = nowIso();
    const snap = buildSnapshot({ connector: c.id, server: spec.label, ref: hit.ref, title: out.title, body: out.body, maxBytes });
    return {
      live: true,
      fetchedAt,
      server: spec.label,
      text: snap.text,
      sha256: snap.sha256,
      title: flattenField(out.title, MAX_TITLE_CHARS),
      truncated: Boolean(snap.truncated),
    };
  }

  /**
   * Live lookup: fetch one document a `search` returned, through the same
   * fetch-and-stage the sync uses, and remember it in `connector-lookup`.
   *
   * @param {string} id
   * @param {{ ref: string, title?: string, version?: string, mime?: string }} item  one entry of `search`
   * @returns {Promise<{ ref: object, text: string, sha256: string, title: string, truncated: boolean, reused: boolean }>}
   */
  async function fetchOne(id, item) {
    const c = connector(id);
    requireLookup(c);
    if (!item || item.ref === undefined || item.ref === null || item.ref === '') throw new Error('fetchOne needs an item from search() with a ref');
    const recipe = recipeFor(c, { repoRoot, dir: recipesDir });
    if (recipe.live === true) return fetchLive(c, recipe, item);
    if (!canFetchByRef(recipe)) throw new Error(`connector "${id}": recipe "${recipe.name}" has no fetch call, so a document cannot be fetched by ref`);
    const timeoutMs = timeoutOf(c);
    const maxBytes = Number(c.max_bytes) > 0 ? Number(c.max_bytes) : DEFAULT_MAX_BYTES;
    const startedAt = nowIso();
    const { spec, client } = await clientFor(c);
    const vars = await resolveVars(client, recipe, lookupVars(c), { timeoutMs });
    const manifest = await mainManifest();
    const key = `${id}:${String(item.ref)}`;
    const kept = rawTitles.has(key) ? null : await store.kv.get(TITLE_NS, key);
    const rawTitle = rawTitles.get(key) ?? kept?.title ?? (item.title ? String(item.title) : String(item.ref));
    const it = { ref: String(item.ref), version: item.version ? String(item.version) : '', title: rawTitle, commit: '', mime: item.mime ? String(item.mime) : '' };
    // The rule: a lookup fetch leaves a mark unless the sync is already responsible for the
    // document. The sync is responsible when its listing wrote the record and main has no
    // entry yet (the next listing will include it), or when main has an entry and the store
    // holds no record at all. A record that only lookups wrote never counts, and neither does
    // a sync record once main has the entry: the document may have left `select` since, and
    // it has just been fetched, so it exists. A complete listing that includes it clears the
    // mark, so marking a document the sync does list costs nothing.
    // Read before staging: stageItem rewrites the record.
    const before = await store.kv.get(ITEM_NS, key);
    const inManifest = Boolean(manifest.byId.get(key) || manifest.byPath.get(snapshotRelPath(brainDir, id, it.ref)));
    const syncOwns = before ? before.via !== 'lookup' && !inManifest : inManifest;
    const done = await stageItem({ c, id, recipe, vars, client, spec, timeoutMs, maxBytes, manifest, startedAt }, it, { via: 'lookup' });
    if (!syncOwns && !(await store.kv.get(LOOKUP_NS, key))) {
      await store.kv.set(LOOKUP_NS, key, { at: startedAt, title: done.snap.title || it.title, failures: 0, checkedAt: startedAt });
    }
    await store.kv.delete(TITLE_NS, key);
    const title = done.snap.title || it.title;
    return {
      ref: { ...done.ref, title: flattenField(done.ref.title, MAX_TITLE_CHARS), version: flattenField(done.ref.version), via: 'lookup' },
      text: done.snap.text,
      sha256: done.snap.sha256,
      title: flattenField(title, MAX_TITLE_CHARS),
      truncated: Boolean(done.snap.truncated),
      reused: done.reused,
    };
  }

  /** Connect + first page of the listing, mapped. With `fetch: true`, also the first item rendered. */
  async function test(id, { fetch = false } = {}) {
    const c = connector(id);
    const recipe = recipeFor(c, { repoRoot, dir: recipesDir });
    const timeoutMs = timeoutOf(c);
    const { spec, client } = await clientFor(c);
    let vars = { since: '', select: c.select || {}, connector: { id, label: c.label || '' } };
    vars = await resolveVars(client, recipe, vars, { timeoutMs });
    const { items } = await listItems(client, recipe, vars, { timeoutMs, firstPageOnly: true });
    let snapshot = null;
    if (fetch && items[0]) {
      const out = await fetchItem(client, recipe, items[0], vars, { timeoutMs });
      snapshot = buildSnapshot({ connector: id, server: spec.label, ref: items[0].ref, title: out.title, body: out.body, maxBytes: Number(c.max_bytes) || DEFAULT_MAX_BYTES });
    }
    return { server: spec.label, transport: spec.type, recipe: recipe.name, vars: vars.vars || {}, items: items.map(({ raw, ...rest }) => rest), snapshot };
  }

  /** tools/list + resources/list of a server, for `connectors init`. Calls no tool. */
  async function inspect(mcp) {
    const spec = serverSpec(mcp);
    const client = await pool.get(spec, {});
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...(page.tools || []));
      cursor = page.nextCursor;
    } while (cursor && tools.length < 2000);
    let resources = [];
    if (client.getServerCapabilities?.()?.resources) {
      try { resources = (await client.listResources({})).resources || []; } catch { resources = []; }
    }
    return { spec, tools, resources };
  }

  /** Interactive OAuth for the connector's server (CLI). */
  async function login(idOrServer, { onUrl, fetchFn, timeoutMs, actorId = 'cli' } = {}) {
    const c = byId.get(idOrServer);
    const spec = serverSpec(c ? c.mcp : idOrServer);
    await pool.drop(spec.key);
    const result = await oauthLogin({ store, spec, onUrl, oauth: (c && typeof c.oauth === 'object' && c.oauth) || {}, fetchFn, timeoutMs });
    await store.audit.append({ id: newId('aud'), ts: nowIso(), actorId, action: 'connector.login', target: c ? c.id : spec.label, channel: 'cli', detail: { server: spec.label } });
    return { server: spec.label, result };
  }

  async function stop() {
    await pool.closeAll();
  }

  return {
    list, sync, syncDetailed, search, fetchOne, snapshotPath, stagedPath, materialize, test, inspect, login, stop,
    hasLogin: (server) => hasLogin(store, server),
    get(id) { return connector(id); },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const HELP = `Usage: almagest connectors <command>

  list                          configured connectors and their last sync
  sync <id> [--dry-run] [--full] [--json] [--ingest]
                                fetch, snapshot and fingerprint; print new/changed items
                                (--ingest: also queue an ingest job per item for the service —
                                the path for connectors with no schedule)
  search <id> <query…> [--limit N] [--json]
                                search a connector with \`lookup: true\` for the words; print the
                                candidates (ref, version, title). Fetches nothing, queues nothing —
                                it checks a recipe's \`search\` block against the real server
  test <id> [--fetch]           connect, list the first page, print the mapping
                                (--fetch: also render the first item's snapshot)
  init <mcp> [--name <n>] [--stdout]
                                inspect a server's tools/resources and draft a recipe
                                to server/src/connectors/recipes/<n>.draft.yaml
  login <id|mcp>                OAuth browser login for an HTTP server; tokens sealed in the store
`;

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') out.name = argv[++i];
    else if (a === '--limit') out.limit = argv[++i];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
    else out._.push(a);
  }
  return out;
}

const print = (s = '') => process.stdout.write(`${s}\n`);

async function run(argv, env) {
  const f = flags(argv);
  const [sub, target] = f._;
  const svc = env.ctx.connectors;
  try {
    switch (sub) {
      case 'list': {
        const rows = await svc.list();
        if (f.json) { print(JSON.stringify(rows, null, 2)); return 0; }
        if (!rows.length) { print('No connectors configured (brain.config.yaml → sources.connectors).'); return 0; }
        for (const r of rows) {
          const last = r.lastSync ? `last ${r.lastSync.at} · ${r.lastSync.changed} changed · ${r.lastSync.errors} errors` : 'never synced';
          print(`${r.id.padEnd(24)} ${String(r.recipe).padEnd(14)} ${String(r.mcp).padEnd(20)} ${r.schedule || 'manual'} · ${last}${r.fromV1Remote ? ' · from sources.remote' : ''}`);
        }
        return 0;
      }
      case 'sync': {
        if (!target) { process.stderr.write(HELP); return 2; }
        const s = await svc.syncDetailed(target, { dryRun: Boolean(f['dry-run']), full: Boolean(f.full) });
        if (f.json) { print(JSON.stringify(s, null, 2)); return s.errors.length ? 1 : 0; }
        print(`${s.dryRun ? '[dry run] ' : ''}${target}: listed ${s.listed}${s.complete ? '' : ' (incremental)'} · ${s.refs.length} new/changed · ${s.unchanged.length} unchanged · ${s.missing.length} missing upstream · ${s.errors.length} errors`);
        for (const r of s.refs) print(`  ${r.change.padEnd(10)} ${r.sha256.slice(0, 8)}  ${r.path}  ${r.title}`);
        for (const m of s.missing) print(`  missing    ${m.id} (pages: ${(m.pages || []).join(', ') || '—'})`);
        for (const e of s.errors) print(`  error      ${e.ref}: ${e.error}`);
        if (f.ingest && !s.dryRun && s.refs.length) {
          // Queued, not run: the CLI process exits now, and the running service's
          // workers pick the jobs up from the shared store. Enqueued as a
          // `schedule` trigger on purpose — this is a sync, and only automatic
          // triggers skip bytes whose proposal is still under review. As
          // `manual` (a person forcing a re-run) every repeat would pay for
          // another agent run and move the proposal under its reviewer.
          for (const ref of s.refs) {
            const job = await env.ctx.ingest.enqueue({ kind: 'ingest', source: ref, trigger: 'schedule', requestedBy: 'svc:cli' });
            print(`  queued     ${job.id}  ${ref.title}`);
          }
          print('Jobs are picked up by `almagest serve`; follow them with `almagest jobs`.');
        }
        return s.errors.length ? 1 : 0;
      }
      case 'search': {
        const words = f._.slice(2);
        if (!target || !words.length) { process.stderr.write(HELP); return 2; }
        const limit = f.limit === undefined ? undefined : Number(f.limit);
        if (limit !== undefined && !(limit > 0)) { process.stderr.write('--limit needs a positive number\n'); return 2; }
        const found = await svc.search(target, { terms: words, limit });
        if (f.json) { print(JSON.stringify(found, null, 2)); return 0; }
        print(`${target}: ${found.length} candidate(s) for "${words.join(' ')}"`);
        for (const i of found) print(`  ${i.ref}  ${i.version ? `[${i.version}] ` : ''}${i.title}`);
        return 0;
      }
      case 'test': {
        if (!target) { process.stderr.write(HELP); return 2; }
        const t = await svc.test(target, { fetch: Boolean(f.fetch) });
        print(`server ${t.server} (${t.transport}) · recipe ${t.recipe} · ${t.items.length} item(s) on the first page`);
        if (Object.keys(t.vars).length) print(`resolved: ${JSON.stringify(t.vars)}`);
        for (const i of t.items.slice(0, 25)) print(`  ${i.ref}  ${i.version ? `[${i.version}] ` : ''}${i.title}`);
        if (t.snapshot) { print(`\n--- first item snapshot (${t.snapshot.bytes} bytes, sha256 ${t.snapshot.sha256.slice(0, 12)}) ---`); print(t.snapshot.text); }
        return 0;
      }
      case 'init': {
        if (!target) { process.stderr.write(HELP); return 2; }
        const { spec, tools, resources } = await svc.inspect(target);
        const name = String(f.name || (typeof target === 'string' ? target : 'server')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server';
        const draft = draftRecipe({ name, server: spec.label, tools, resources });
        if (f.stdout) { process.stdout.write(draft.yaml); return 0; }
        const file = path.join(RECIPES_DIR, `${name}.draft.yaml`);
        fs.writeFileSync(file, draft.yaml);
        print(`Drafted ${path.relative(env.repoRoot, file)} (${draft.suggestion === 'mcp-resources' ? 'server exposes resources — mcp-resources needs no recipe' : `${tools.length} tools inspected`}).`);
        print('Review it, run `almagest connectors test <id>`, then rename it to drop `.draft`.');
        return 0;
      }
      case 'login': {
        if (!target) { process.stderr.write(HELP); return 2; }
        const r = await svc.login(target, {
          onUrl: (url) => { print('Open this URL in a browser to authorize Almagest:\n'); print(`  ${url}\n`); print('Waiting for the redirect…'); },
        });
        print(`Authorized ${r.server}. Tokens are sealed in the service store.`);
        return 0;
      }
      default:
        process.stdout.write(HELP);
        return sub && sub !== 'help' ? 2 : 0;
    }
  } finally {
    await svc.stop?.();
  }
}

export const commands = {
  connectors: { summary: 'list · sync · search · test · init · login — MCP servers as sources', needsApp: true, run },
};
