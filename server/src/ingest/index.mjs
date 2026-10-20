/**
 * ingest — WS1. Spec: docs/v2/spec.md → Background ingest.
 *
 * Builds ctx.ingest:
 *
 *   enqueue({ kind, source, trigger, requestedBy, proposalId?, instructions?, slug? }) → Job
 *   get(id) · list(filter) · start() · stop() · cancel(id)
 *   considerFile(abs, { trigger }) · scan()      the watch path, exposed for tests and the API
 *
 * and wires the three triggers (watch, schedule, spool) and the HTTP API
 * (`/api/jobs`). `commands` adds `almagest hook`, `almagest ingest` and
 * `almagest jobs`.
 *
 * Talks to other modules only through ctx: connectors (sync, snapshotPath),
 * governance (getProposal, createFromJob), snapshot (main's manifest), store,
 * bus, git.
 */
import os from 'node:os';
import path from 'node:path';

import { loadManifest } from '../../../tools/lib/config.mjs';
import { createDriver } from './drivers/index.mjs';
import { hookCommand } from './hooks.mjs';
import { createQueue, EnqueueError } from './queue.mjs';
import { createRunner } from './runner.mjs';
import { createScheduler } from './scheduler.mjs';
import { localSource, realish } from './source.mjs';
import { drainSpool } from './spool.mjs';
import { createWatcher, listCandidates } from './watcher.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'blocked', 'cancelled']);
const API_TRIGGERS = new Set(['manual', 'hook', 'mcp']);

export async function create(ctx) {
  const { config, store, log: rootLog, bus, git, repoRoot } = ctx;
  const log = rootLog.child ? rootLog.child({ module: 'ingest' }) : rootLog;
  // A view of ctx with this module's logger. Prototype, not a copy: modules
  // built after this one (governance, mcp) must still be visible at run time.
  const mctx = Object.assign(Object.create(ctx), { log });
  const logsDir = path.join(config.paths.state, 'logs');
  const stagingDir = path.join(config.paths.state, 'staging');
  const localRoot = path.resolve(repoRoot, config.sources.localPath);
  const extraRoots = [path.join(config.paths.state, 'submissions')];   // MCP submit_source (WS4)

  let driver = null;
  const driverProxy = {
    get name() { return config.ingest.driver; },
    run(args) {
      // Built on first use, so `almagest jobs` and the hooks never probe for a CLI.
      driver ||= createDriver(config.ingest.driver, ctx);
      return driver.run(args);
    },
  };

  const runner = createRunner(mctx, { driver: driverProxy, logsDir });

  /** Fingerprint and stage a local SourceRef that arrived without one; pass connector refs through. */
  async function prepareSource(source) {
    if (!source || typeof source !== 'object') throw new EnqueueError('source must be a SourceRef object');
    if (source.kind === 'local') {
      if (!source.path) throw new EnqueueError('a local source needs a path');
      const computed = await localSource({ repoRoot, localPath: config.sources.localPath, stagingDir, extraRoots }, source.path)
        .catch((err) => { throw new EnqueueError(err.message); });
      if (source.sha256 && source.sha256 !== computed.sha256) {
        throw new EnqueueError(`fingerprint mismatch for ${source.path}: given ${source.sha256.slice(0, 7)}…, file is ${computed.sha256.slice(0, 7)}…`);
      }
      return { ...computed, ...(source.id ? { id: source.id } : {}), ...(source.title ? { title: source.title } : {}) };
    }
    // Connector refs arrive fingerprinted by ctx.connectors (spec: the service
    // hashes the snapshot); the runner re-checks the bytes when it places them.
    if (!source.id) throw new EnqueueError('a source needs an id');
    return { ...source };
  }

  const queue = createQueue(mctx, { runner, prepareSource, logsDir });

  // ── watch trigger: is this file new? ──────────────────────────────────────

  let manifestCache = { sha: '', shas: new Set() };
  async function knownOnMain(sha256) {
    try {
      const snap = await ctx.snapshot.load();
      if (manifestCache.sha !== snap.sha) {
        const m = loadManifest(snap.dir, config.v1.manifestPath);
        manifestCache = { sha: snap.sha, shas: new Set(m.entries.flatMap((e) => [e.sha256, e.extractedSha256]).filter(Boolean)) };
      }
      return manifestCache.shas.has(sha256);
    } catch (err) {
      log.warn('could not read main\'s manifest — treating file as new', { error: err.message });
      return false;
    }
  }

  /**
   * The watch / hook / spool path: fingerprint, then skip what main's manifest
   * already records (unchanged, rule 5) and what already has a job — a
   * previous run that failed is not retried by re-noticing the same bytes;
   * `almagest ingest <path>` does that on purpose.
   */
  async function considerFile(file, { trigger = 'watch', requestedBy = 'svc:ingest' } = {}) {
    let described;
    try {
      described = await localSource({ repoRoot, localPath: config.sources.localPath, stagingDir }, file, { stage: false });
    } catch (err) {
      return { action: 'skipped', reason: err.message };
    }
    if (await knownOnMain(described.sha256)) {
      log.debug('unchanged — manifest on main already has this sha256', { file: described.path });
      return { action: 'skipped', reason: 'unchanged', source: described };
    }
    const prior = (await store.jobs.list({ kind: 'ingest' }))
      .find((j) => j.source?.sha256 === described.sha256 && j.status !== 'cancelled');
    if (prior) return { action: 'skipped', reason: `already ${prior.status} as ${prior.id}`, job: prior, source: described };
    const job = await queue.enqueue({ kind: 'ingest', source: described, trigger, requestedBy });
    return { action: 'enqueued', job, source: described };
  }

  const watcher = createWatcher({
    root: localRoot, log,
    debounceMs: Number(config.ingest.watch_debounce_ms ?? 750),
    stableMs: Number(config.ingest.watch_stable_ms ?? 1000),
    onCandidate: (abs) => considerFile(abs, { trigger: 'watch' }),
  });

  async function scan() {
    const results = [];
    for (const abs of listCandidates(localRoot)) results.push({ file: abs, ...(await considerFile(abs, { trigger: 'watch' })) });
    return results;
  }

  // ── spool ─────────────────────────────────────────────────────────────────

  async function handleSpoolEntry(entry) {
    if (entry.source) return queue.enqueue({ kind: 'ingest', source: entry.source, trigger: API_TRIGGERS.has(entry.trigger) ? entry.trigger : 'hook', requestedBy: entry.requestedBy || 'svc:ingest' });
    if (!entry.path) throw new Error('spool entry has neither path nor source');
    const r = await considerFile(path.resolve(repoRoot, entry.path), { trigger: 'hook', requestedBy: entry.requestedBy || 'svc:ingest' });
    if (r.action === 'skipped' && !/unchanged|already/.test(r.reason)) throw new Error(r.reason);
    return r;
  }
  const drain = () => drainSpool(config.paths.spool, handleSpoolEntry, { log }).catch((err) => log.error('spool drain failed', { error: err.message }));

  const scheduler = createScheduler(mctx, { enqueue: (j) => queue.enqueue(j) });

  // ── worktree lifecycle follows the proposal ───────────────────────────────

  async function releaseWorktree({ proposal }) {
    if (!proposal?.branch) return;
    const wt = await git.worktreeFor(proposal.branch).catch(() => null);
    if (!wt || !realish(wt.path).startsWith(realish(config.paths.worktrees))) return;
    await git.worktreeRemove(wt.path, { force: true }).catch((err) => log.warn('could not remove worktree', { branch: proposal.branch, error: err.message }));
  }
  bus.on('proposal.merged', releaseWorktree);
  bus.on('proposal.rejected', releaseWorktree);
  bus.on('proposal.updated', (p) => (p?.proposal?.status === 'superseded' ? releaseWorktree(p) : undefined));

  // ── HTTP ──────────────────────────────────────────────────────────────────

  ctx.http.route('POST', '/api/jobs', async (_req, _res, { body, actor }) => {
    const trigger = API_TRIGGERS.has(body?.trigger) ? body.trigger : 'manual';
    // The API enqueues ingests only. `revise` and `drop-page` carry
    // instructions the agent is told to trust, so they come from governance
    // through ctx, never from a request body.
    if (body?.path) {
      if (trigger === 'hook') {
        const r = await considerFile(path.resolve(repoRoot, String(body.path)), { trigger, requestedBy: actor });
        if (r.action === 'skipped' && !r.job && r.reason !== 'unchanged') throw Object.assign(new Error(r.reason), { status: 400 });
        return r.job ? { ...r.job, skipped: r.action === 'skipped' ? r.reason : undefined } : { skipped: r.reason };
      }
      return queue.enqueue({ kind: 'ingest', source: { kind: 'local', path: String(body.path) }, trigger, requestedBy: actor });
    }
    if (body?.source) return queue.enqueue({ kind: 'ingest', source: body.source, trigger, requestedBy: actor });
    throw Object.assign(new Error('body needs `path` (a file under the drop folder) or `source` (a SourceRef)'), { status: 400 });
  }, { auth: 'any' });

  ctx.http.route('GET', '/api/jobs', async (_req, _res, { query }) => {
    const filter = { order: 'desc', limit: Math.min(500, Number(query.limit) || 50) };
    for (const k of ['status', 'kind', 'trigger', 'proposalId']) if (query[k]) filter[k] = query[k].includes(',') ? query[k].split(',') : query[k];
    return store.jobs.list(filter);
  }, { auth: 'any' });

  ctx.http.route('GET', '/api/jobs/:id', async (_req, _res, { params }) => {
    const job = await store.jobs.get(params.id);
    if (!job) throw Object.assign(new Error(`job ${params.id} not found`), { status: 404 });
    return job;
  }, { auth: 'any' });

  // ── lifecycle ─────────────────────────────────────────────────────────────

  let spoolTimer = null;
  let scanning = null;
  let started = false;

  return {
    enqueue: (input) => queue.enqueue(input),
    get: (id) => store.jobs.get(id),
    list: (filter = {}) => store.jobs.list({ order: 'desc', ...filter }),
    cancel: (id) => queue.cancel(id),
    considerFile,
    scan,
    drainSpool: drain,
    scheduler,
    get driver() { return driverProxy; },

    /** `triggers: false` runs workers only — `almagest ingest --wait` uses it. */
    async start({ workers = true, triggers = true } = {}) {
      if (started) return;
      started = true;
      if (workers) await queue.start();
      if (!triggers) return;
      if (config.ingest.watch_raw) {
        watcher.start();
        scanning = scan().catch((err) => log.error('start-up scan failed', { error: err.message }));
      }
      await scheduler.start();
      await drain();
      const every = Number(config.ingest.spool_interval_seconds ?? 15) * 1000;
      if (every > 0) {
        spoolTimer = setInterval(drain, every);
        spoolTimer.unref?.();
      }
    },

    async stop() {
      if (!started) return;
      started = false;
      watcher.stop();
      scheduler.stop();
      clearInterval(spoolTimer);
      await scanning;
      await queue.stop();
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function cliActor() {
  const name = (() => { try { return os.userInfo().username; } catch { return process.env.USER || 'cli'; } })();
  return { id: `usr_${name}`, kind: 'human', display: name };
}

async function waitFor(ctx, ids, timeoutMs = 24 * 3600 * 1000) {
  const deadline = Date.now() + timeoutMs;
  const done = new Map();
  while (done.size < ids.length && Date.now() < deadline) {
    for (const id of ids) {
      if (done.has(id)) continue;
      const j = await ctx.store.jobs.get(id);
      if (j && TERMINAL.has(j.status)) done.set(id, j);
    }
    if (done.size < ids.length) await new Promise((r) => setTimeout(r, 500));
  }
  return ids.map((id) => done.get(id) || null);
}

function line(j) {
  return [j.id, j.status.padEnd(9), j.kind.padEnd(9), (j.source?.id || j.proposalId || '').padEnd(28), j.branch || '', j.proposalId && j.kind === 'ingest' ? `→ ${j.proposalId}` : '', j.error ? `— ${j.error}` : '']
    .filter(Boolean).join('  ');
}

export const commands = {
  hook: hookCommand,

  ingest: {
    summary: 'Queue a file in the drop folder for background ingest [--wait]',
    needsApp: true,
    async run(argv, { ctx, repoRoot }) {
      const wait = argv.includes('--wait');
      const files = argv.filter((a) => !a.startsWith('--'));
      if (files.length === 0) {
        process.stderr.write('usage: almagest ingest <file under brain/raw/>… [--wait]\n');
        return 1;
      }
      const ids = [];
      for (const f of files) {
        const rel = path.relative(repoRoot, path.resolve(process.cwd(), f));
        try {
          const job = await ctx.ingest.enqueue({ kind: 'ingest', source: { kind: 'local', path: rel }, trigger: 'manual', requestedBy: cliActor() });
          process.stdout.write(`${line(job)}\n`);
          ids.push(job.id);
        } catch (err) {
          process.stderr.write(`almagest ingest: ${f}: ${err.message}\n`);
          return 1;
        }
      }
      if (!wait) return 0;
      await ctx.ingest.start({ triggers: false });
      const results = await waitFor(ctx, ids);
      for (const j of results) if (j) process.stdout.write(`${line(j)}\n`);
      return results.every((j) => j && (j.status === 'succeeded' || j.status === 'blocked')) ? 0 : 1;
    },
  },

  jobs: {
    summary: 'List ingest jobs [<id>] [--status s] [--limit n]',
    needsApp: true,
    async run(argv, { ctx }) {
      const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
      const id = argv.find((a, i) => !a.startsWith('--') && !['--status', '--limit'].includes(argv[i - 1]));
      if (id) {
        const job = await ctx.ingest.get(id);
        if (!job) { process.stderr.write(`no job ${id}\n`); return 1; }
        process.stdout.write(`${JSON.stringify(job, null, 2)}\n`);
        return 0;
      }
      const status = flag('--status');
      const jobs = await ctx.ingest.list({ ...(status ? { status: status.split(',') } : {}), limit: Number(flag('--limit')) || 30 });
      if (jobs.length === 0) process.stdout.write('no jobs\n');
      for (const j of jobs) process.stdout.write(`${line(j)}\n`);
      return 0;
    },
  },
};
