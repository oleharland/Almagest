/**
 * queue.mjs — the job lifecycle: enqueue with dedup, `ingest.concurrency`
 * worker loops over `store.jobs.claim`, retries, timeouts, shutdown.
 *
 *   queued ──claim──▶ running ──▶ succeeded | blocked | failed | cancelled
 *     ▲                  │
 *     └── retryable failure, attempts < maxAttempts
 *     └── service shutdown (the attempt is not counted)
 *
 * The store's `claim` is the only thing that moves a job to `running`, and it
 * is atomic, so two service processes on one sqlite file never run the same
 * job. Everything else here is single-process bookkeeping.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JOB_KINDS, JOB_TRIGGERS, newId, nowIso } from '../core/schemas.mjs';
import { JobError } from './runner.mjs';

const ACTIVE = ['queued', 'running'];
const AUTOMATIC = new Set(['watch', 'schedule', 'hook', 'mcp']);
const CLOSED_PROPOSAL = new Set(['merged', 'rejected', 'superseded']);
const SHUTDOWN = Symbol('shutdown');
const CANCEL = Symbol('cancel');

export class EnqueueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnqueueError';
    this.status = 400;
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function requesterOf(requestedBy) {
  if (requestedBy && typeof requestedBy === 'object') {
    const { id, kind, display, email } = requestedBy;
    return { id: String(id), kind, display, email };
  }
  return { id: String(requestedBy || 'svc:ingest') };
}

export function createQueue(ctx, { runner, prepareSource, logsDir }) {
  const { store, bus, log, config } = ctx;
  const host = os.hostname();
  const boot = Math.random().toString(36).slice(2, 8);
  const active = new Map();          // jobId → AbortController
  let running = false;
  let loops = [];
  let waiters = [];
  let chain = Promise.resolve();     // serialises enqueue so dedup cannot race itself

  const pollMs = Number(config.ingest.poll_ms || 2000);

  function wake() {
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  }

  function idle(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      waiters.push(done);
    });
  }

  function serial(fn) {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  }

  async function findDuplicate(job) {
    const same = await store.jobs.list({ kind: job.kind, status: ACTIVE });
    if (job.kind === 'drop-page') {
      return same.find((j) => j.proposalId === job.proposalId && j.slug === job.slug) || null;
    }
    if (job.kind === 'revise') return null;   // handled by coalescing below
    const sameSource = (j) => (j.source?.id ?? null) === (job.source?.id ?? null)
      && (j.source?.sha256 ?? null) === (job.source?.sha256 ?? null)
      && (j.source ? true : j.slug === job.slug);
    const live = same.find(sameSource);
    if (live || job.kind !== 'ingest' || !job.source || !AUTOMATIC.has(job.trigger)) return live || null;

    // An automatic trigger (a connector schedule re-listing an item, a hook,
    // a chat resubmitting) must not re-run bytes that already produced a
    // proposal still under review, or that a run already found unchanged —
    // a 15-minute schedule would otherwise spawn a job per tick. `manual`
    // skips this on purpose: `almagest ingest` is how a person forces a re-run.
    const done = (await store.jobs.list({ kind: 'ingest', status: ['succeeded', 'blocked'], order: 'desc' })).filter(sameSource);
    for (const j of done) {
      if (!j.proposalId) return j;
      let p = null;
      try { p = await ctx.governance.getProposal(j.proposalId); } catch { p = { status: 'open' }; }
      if (p && !CLOSED_PROPOSAL.has(p.status)) return j;
    }
    return null;
  }

  /**
   * Spec dedup: an ingest/reverify whose (kind, source.id, source.sha256)
   * matches a queued or running job returns that job. Two refinements the
   * spec's key would get wrong: a `revise` carries instructions, and two
   * decisions resolved in a row must not collapse into one — so a revise
   * still QUEUED for the same proposal absorbs the new instructions instead.
   * A `drop-page` dedups on (proposal, slug).
   */
  async function enqueue(input = {}) {
    const kind = input.kind || 'ingest';
    const trigger = input.trigger || 'manual';
    if (!JOB_KINDS.includes(kind)) throw new EnqueueError(`kind must be one of ${JOB_KINDS.join(' | ')}`);
    if (!JOB_TRIGGERS.includes(trigger)) throw new EnqueueError(`trigger must be one of ${JOB_TRIGGERS.join(' | ')}`);
    if ((kind === 'revise' || kind === 'drop-page') && !input.proposalId) throw new EnqueueError(`${kind} needs a proposalId`);
    if (kind === 'ingest' && !input.source && !input.proposalId) throw new EnqueueError('ingest needs a source');
    if (kind === 'reverify' && !input.source && !input.slug && !(input.slugs || []).length && !input.proposalId) throw new EnqueueError('reverify needs a source, a slug or a proposalId');
    if (kind === 'drop-page' && !input.slug && !(input.slugs || []).length) throw new EnqueueError('drop-page needs a slug');

    const source = input.source ? await prepareSource(input.source) : null;
    const requester = requesterOf(input.requestedBy);

    return serial(async () => {
      const job = {
        id: newId('job'),
        kind,
        source,
        trigger,
        requestedBy: requester.id,
        requester,
        // An agent acting for a person (MCP submit_source): the person is
        // recorded too, and becomes the commit's co-author.
        ...(input.onBehalfOf ? { onBehalfOf: String(typeof input.onBehalfOf === 'object' ? input.onBehalfOf.id : input.onBehalfOf) } : {}),
        ...(input.proposalId ? { proposalId: input.proposalId } : {}),
        ...(input.decisionId ? { decisionId: String(input.decisionId) } : {}),   // governance: which decision this revise resolves
        ...(input.instructions ? { instructions: String(input.instructions) } : {}),
        ...(input.slug ? { slug: String(input.slug) } : {}),
        ...(input.slugs ? { slugs: input.slugs.map(String) } : {}),
        status: 'queued',
        attempts: 0,
        maxAttempts: Math.max(1, Number(config.ingest.max_attempts) || 1),
        createdAt: nowIso(),
      };

      if (kind === 'revise') {
        const queued = (await store.jobs.list({ kind: 'revise', status: 'queued', proposalId: job.proposalId }))[0];
        if (queued) {
          const merged = [queued.instructions, job.instructions].filter(Boolean).join('\n\n---\n\n');
          log.info('revise coalesced into queued job', { job: queued.id, proposal: job.proposalId });
          return store.jobs.update(queued.id, { instructions: merged });
        }
      } else {
        const dup = await findDuplicate(job);
        if (dup) {
          log.debug('enqueue deduplicated', { job: dup.id, source: source?.id });
          return dup;
        }
      }

      await store.jobs.enqueue(job);
      log.info('job queued', { job: job.id, kind, trigger, source: source?.id, sha: source?.sha256?.slice(0, 7) });
      bus.emit('job.queued', { job });
      wake();
      return job;
    });
  }

  function jobLog(jobId) {
    fs.mkdirSync(logsDir, { recursive: true });
    const stream = fs.createWriteStream(path.join(logsDir, `${jobId}.log`), { flags: 'a' });
    const write = (line) => stream.write(`[${nowIso()}] ${line}\n`);
    write.stream = stream;
    write.end = () => new Promise((r) => stream.end(r));
    return write;
  }

  async function execute(job) {
    const controller = new AbortController();
    active.set(job.id, controller);
    const write = jobLog(job.id);
    const timeoutMs = Math.max(1, Number(config.ingest.timeout_minutes || 30) * 60_000);
    write(`attempt ${job.attempts}/${job.maxAttempts} — ${job.kind} ${job.source?.id || job.proposalId || ''} (trigger ${job.trigger})`);
    bus.emit('job.started', { job });

    let current = job;
    const patchJob = async (patch) => { current = await store.jobs.update(job.id, patch); return current; };
    let final;
    try {
      const result = await runner.run(current, { signal: controller.signal, write, timeoutMs, patchJob });
      const { note, ...rest } = result;
      final = await store.jobs.update(job.id, { ...rest, ...(note ? { note } : {}), error: null, finishedAt: nowIso() });
      write(`done: ${final.status}${note ? ` (${note})` : ''}`);
    } catch (err) {
      const reason = controller.signal.reason;
      if (reason === SHUTDOWN) {
        write('service stopping — job returned to the queue');
        await store.jobs.update(job.id, { status: 'queued', attempts: Math.max(0, job.attempts - 1), workerId: null, startedAt: null });
        return;
      }
      if (reason === CANCEL) {
        final = await store.jobs.update(job.id, { status: 'cancelled', error: 'cancelled', finishedAt: nowIso() });
        write('cancelled');
      } else {
        const message = err instanceof JobError ? err.message : `${err.name || 'Error'}: ${err.message}`;
        const retry = (err instanceof JobError ? err.retryable : true) && job.attempts < job.maxAttempts;
        const patch = err instanceof JobError ? err.patch : {};
        write(`${retry ? 'failed, will retry' : 'failed'}: ${message}`);
        if (!(err instanceof JobError)) write(err.stack || '');
        if (retry) {
          await store.jobs.update(job.id, { ...patch, status: 'queued', lastError: message, workerId: null });
          log.warn('job failed — retrying', { job: job.id, attempt: job.attempts, error: message });
          wake();
          return;
        }
        final = await store.jobs.update(job.id, { ...patch, status: 'failed', error: message, finishedAt: nowIso() });
        log.error('job failed', { job: job.id, error: message });
      }
    } finally {
      active.delete(job.id);
      await write.end();
    }
    bus.emit('job.finished', { job: final });
  }

  async function loop(n) {
    const workerId = `${host}:${process.pid}:${boot}:${n}`;
    while (running) {
      let job = null;
      try { job = await store.jobs.claim(workerId); }
      catch (err) { log.error('claim failed', { error: err.message }); }
      if (!running) {
        // Claimed during shutdown: give it straight back.
        if (job) await store.jobs.update(job.id, { status: 'queued', attempts: Math.max(0, job.attempts - 1), workerId: null });
        break;
      }
      if (!job) { await idle(pollMs); continue; }
      try { await execute(job); }
      catch (err) { log.error('worker crashed on job', { job: job.id, error: err.stack || err.message }); }
    }
  }

  /** Running jobs whose worker process on this host is gone go back to the queue. */
  async function recoverStale() {
    for (const j of await store.jobs.list({ status: 'running' })) {
      const [h, pid, b] = String(j.workerId || '').split(':');
      const dead = h === host && (Number(pid) !== process.pid ? !pidAlive(Number(pid)) : b !== boot);
      if (!j.workerId || dead) {
        await store.jobs.update(j.id, { status: 'queued', attempts: Math.max(0, (j.attempts || 1) - 1), workerId: null });
        log.warn('recovered a job left running by a dead worker', { job: j.id, worker: j.workerId });
      }
    }
  }

  return {
    enqueue,
    wake,
    async start() {
      if (running) return;
      await recoverStale();
      running = true;
      const n = Math.max(1, Number(config.ingest.concurrency) || 1);
      loops = Array.from({ length: n }, (_, i) => loop(i));
    },
    async stop() {
      if (!running) return;
      running = false;
      for (const c of active.values()) c.abort(SHUTDOWN);
      wake();
      await Promise.allSettled(loops);
      loops = [];
    },
    async cancel(id) {
      const job = await store.jobs.get(id);
      if (!job) return null;
      if (job.status === 'queued') {
        const done = await store.jobs.update(id, { status: 'cancelled', finishedAt: nowIso() });
        bus.emit('job.finished', { job: done });
        return done;
      }
      active.get(id)?.abort(CANCEL);
      return job;
    },
    get running() { return running; },
    get active() { return [...active.keys()]; },
  };
}
