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
 *   ctx.connectors.list()                      → [{ id, mcp, recipe, schedule, lastSync, … }]
 *   ctx.connectors.sync(id, { since?, full?, dryRun? }) → [SourceRef]
 *   ctx.connectors.syncDetailed(id, opts)      → { refs, unchanged, missing, errors, … }
 *   ctx.connectors.snapshotPath(ref)           → 'brain/raw/extracted/<connector>/<slug>.txt'
 *   ctx.connectors.stagedPath(ref)             → abs path of the staged snapshot
 *   ctx.connectors.materialize(ref, worktree)  → copies the staged snapshot in, sha-checked
 *   ctx.connectors.stop()
 *
 * Store namespaces:  connector-cursor (id) · connector-item (<id>:<ref>) · connector-oauth (server, sealed)
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadManifest } from '../../../tools/lib/config.mjs';
import { newId, nowIso } from '../core/schemas.mjs';
import { fetchItem, listItems, resolveVars } from './execute.mjs';
import { draftRecipe } from './init.mjs';
import { createPool, DEFAULT_TIMEOUT_MS, NeedsLoginError, readMcpJson, resolveServer } from './mcp-client.mjs';
import { createOAuthProvider, hasLogin, login as oauthLogin } from './oauth.mjs';
import { recipeFor, RECIPES_DIR } from './recipes.mjs';
import { buildSnapshot, DEFAULT_MAX_BYTES, sha256, snapshotRelPath, stagingAbsPath } from './snapshot-file.mjs';

export const CURSOR_NS = 'connector-cursor';
export const ITEM_NS = 'connector-item';
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

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
      out.push({
        id: c.id,
        mcp: typeof c.mcp === 'string' ? c.mcp : c.mcp?.url || c.mcp?.command || 'inline',
        recipe: c.recipe || 'mcp-resources',
        schedule: c.schedule || '',
        label: c.label || '',
        tier: c.tier || 'evidence',
        snapshot: c.snapshot || 'commit',
        fromV1Remote: Boolean(c.fromV1Remote),
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

    await mapLimit(items, Number(c.concurrency) > 0 ? Number(c.concurrency) : 4, async (item) => {
      const key = `${id}:${item.ref}`;
      try {
        const relPath = snapshotRelPath(brainDir, id, item.ref);
        const stage = stagingAbsPath(stateDir, id, item.ref);
        const prior = await store.kv.get(ITEM_NS, key);

        // `version` only ever saves a fetch. It is trusted exactly as far as
        // the staged bytes still hash to what was fingerprinted last time.
        let snap = null;
        if (item.version && prior?.version === item.version && fs.existsSync(stage)) {
          const text = fs.readFileSync(stage, 'utf-8');
          const digest = sha256(text);
          if (digest === prior.sha256) { snap = { text, sha256: digest, bytes: Buffer.byteLength(text), truncated: Boolean(prior.truncated), title: prior.title }; reused++; }
        }
        if (!snap) {
          const out = await fetchItem(client, recipe, item, vars, { timeoutMs });
          fetched++;
          snap = { ...buildSnapshot({ connector: id, server: spec.label, ref: item.ref, title: out.title, body: out.body, maxBytes }), title: out.title };
        }

        const { entry, previous } = findEntry(manifest, c, key, relPath, item);
        const expected = entry ? entry.extractedSha256 || entry.sha256 : '';
        const change = !entry ? (previous ? 'changed' : 'new')
          : expected !== snap.sha256 ? 'changed'
            : entry.status === 'missing' ? 'reappeared'
              : 'unchanged';

        if (!opts.dryRun) {
          if (!fs.existsSync(stage) || sha256(fs.readFileSync(stage)) !== snap.sha256) {
            fs.mkdirSync(path.dirname(stage), { recursive: true });
            fs.writeFileSync(stage, snap.text);
          }
          await store.kv.set(ITEM_NS, key, { version: item.version, sha256: snap.sha256, title: snap.title, truncated: snap.truncated, path: relPath, syncedAt: startedAt });
        }

        if (change === 'unchanged') { unchanged.push(key); return; }
        refs.push({
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
        });
      } catch (err) {
        errors.push({ id: key, ref: item.ref, error: err.message });
        log?.warn('connector item failed', { connector: id, ref: item.ref, error: err.message });
      }
    });

    // Disappeared upstream: only a complete listing can say so. Nothing is
    // deleted — the next ingest marks the manifest entry `status: missing`.
    const listed = new Set(items.map((i) => i.ref));
    const missing = complete
      ? manifest.entries
        .filter((e) => e.kind === 'connector' && e.connector === id && e.status !== 'missing' && e.ref && !listed.has(e.ref))
        .map((e) => ({ id: e.id, ref: e.ref, path: e.extracted || e.path, pages: e.pages }))
      : [];

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
    list, sync, syncDetailed, snapshotPath, stagedPath, materialize, test, inspect, login, stop,
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
          // workers pick the jobs up from the shared store. Dedup makes a repeat
          // `sync --ingest` of the same bytes a no-op.
          for (const ref of s.refs) {
            const job = await env.ctx.ingest.enqueue({ kind: 'ingest', source: ref, trigger: 'manual', requestedBy: 'svc:cli' });
            print(`  queued     ${job.id}  ${ref.title}`);
          }
          print('Jobs are picked up by `almagest serve`; follow them with `almagest jobs`.');
        }
        return s.errors.length ? 1 : 0;
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
  connectors: { summary: 'list · sync · test · init · login — MCP servers as sources', needsApp: true, run },
};
