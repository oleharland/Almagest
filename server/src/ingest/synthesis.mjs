/**
 * synthesis.mjs — when the brain looks across its own pages for conclusions.
 *
 * A `synthesize` job reads the wiki on main and proposes `claim` pages
 * (docs/v2/curation-design.md, Part 2). This module decides when to queue one.
 * It is the only place that does, and every route in goes through `request`:
 *
 *   - after a proposal is merged, once enough source pages changed on main
 *   - on a cron expression (`synthesis.schedule`), which checks the same way
 *   - by hand, `almagest synthesize`, which may skip the threshold with --force
 *
 * Bounds, checked in this order, none of them skippable except the threshold:
 *
 *   synthesis.enabled is false           nothing runs
 *   a synthesize job is queued or running  at most one at a time
 *   a learnings proposal is open          no new run until a person has dealt with it
 *   synthesis.max_runs_per_day            counted from the jobs in the store, by UTC date, and
 *                                         claimed in the store before queueing (see `claim`)
 *   synthesis.min_changed_pages           source pages added or changed since the last run
 *
 * What the job may write is the runner's business (runner.mjs → guardLearnings).
 * The loop guard is how this module bounds itself, the way telemetry bounds
 * autoReverify: a merged learnings proposal adds claim pages, which are not
 * `origin: source`, and a learnings merge is skipped outright, so it cannot
 * start the next run by itself.
 */
import { parseCron } from './cron.mjs';
import { readPage, synthesisSettings } from '../governance/learnings.mjs';
import { LIVE } from '../governance/policy.mjs';

export const STATE_NS = 'synthesis';
export const STATE_KEY = 'last-run';
/** Where the daily run slots are claimed: key `<UTC date>:<n>`, one per allowed run. */
export const CLAIM_NS = 'synthesis.claims';
/** Which claim a queued synthesize job holds: key = job id, value = `{ claim }`. Read when the job ends. */
export const JOB_NS = 'synthesis.jobs';
const REQUESTER = 'svc:synthesis';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function createSynthesis(ctx, { enqueue, now = () => new Date() }) {
  const { config, store, git, bus, log } = ctx;
  const settings = () => synthesisSettings(config);
  const wikiDir = `${config.v1.brainDir.replace(/\/+$/, '')}/wiki`;
  let chain = Promise.resolve();   // requests run one at a time, so two merges cannot both pass the bounds
  let timer = null;
  let cron = null;
  let lastMinute = -1;
  let unsubscribe = null;
  let unsubscribeFinished = null;

  const serial = (fn) => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  /**
   * `origin: source` pages added or changed on main since `sinceSha`, without
   * the template pages. Claim pages never count, so a learning that merges
   * cannot add to the next run's count. An unknown `sinceSha` counts from the start.
   */
  async function changedSourcePages(sinceSha, mainSha) {
    let changes = null;
    if (sinceSha) {
      try { changes = await git.diffNames(sinceSha, mainSha, [wikiDir]); } catch { changes = null; }
    }
    if (!changes) {   // no run yet, or a commit that is gone: every page counts
      const all = await git.run(['ls-tree', '-r', '--name-only', mainSha, '--', `${wikiDir}/`]);
      changes = all.split('\n').filter(Boolean).map((path) => ({ status: 'A', path }));
    }
    const slugs = [];
    for (const c of changes) {
      if (c.status === 'D' || !c.path.endsWith('.md')) continue;
      const slug = c.path.slice(wikiDir.length + 1, -3);
      if (!slug || slug.includes('/') || slug.startsWith('_')) continue;
      const text = await git.show(mainSha, c.path);
      let page;
      try { page = typeof text === 'string' ? readPage(text) : null; } catch { page = null; }
      if (page?.origin === 'source') slugs.push(slug);
    }
    return slugs;
  }

  const today = (at) => at.toISOString().slice(0, 10);

  async function runsToday(at) {
    const jobs = await store.jobs.list({ kind: 'synthesize' });
    return jobs.filter((j) => !j.claimReleased && String(j.createdAt || '').slice(0, 10) === today(at)).length;
  }

  async function openLearnings() {
    const open = await ctx.governance.listProposals({ status: LIVE });
    return (open || []).filter((p) => p?.kind === 'learnings' && LIVE.includes(p.status));
  }

  /**
   * Take one of today's run slots, atomically in the shared store, so that
   * `almagest synthesize` in one process and a merge in the service cannot both
   * pass the cap: the chain above only orders requests inside one process.
   * Slots are numbered 1..max_runs_per_day under `<UTC date>:<n>`; the first
   * free one is ours. Slots of earlier days are dropped. Returns the key, or
   * null when every slot is taken.
   */
  async function claim(at, max) {
    const day = today(at);
    for (const { key } of await store.kv.list(CLAIM_NS)) {
      if (!key.startsWith(`${day}:`)) await store.kv.delete(CLAIM_NS, key);
    }
    for (let slot = 1; slot <= max; slot++) {
      const key = `${day}:${slot}`;
      if (await store.kv.setIfAbsent(CLAIM_NS, key, { at: at.toISOString(), pid: process.pid })) return key;
    }
    return null;
  }

  const stop = (code, reason, extra = {}) => ({ queued: false, code, reason, ...extra });

  /**
   * Queue a synthesize job if every bound allows it.
   * @param {object} [o]
   * @param {boolean} [o.force]       skip the changed-pages threshold, nothing else
   * @param {string}  [o.via]         'merge' | 'schedule' | 'manual', for the log and the reason text
   * @param {object|string} [o.requestedBy]
   * @returns {Promise<{ queued: boolean, code: string, reason?: string, job?: object, changed?: number }>}
   */
  function request({ force = false, via = 'manual', requestedBy = REQUESTER } = {}) {
    return serial(async () => {
      const s = settings();
      if (!s.enabled) return stop('disabled', 'Synthesis is turned off (synthesis.enabled is false).');

      const active = await store.jobs.list({ kind: 'synthesize', status: ['queued', 'running'] });
      if (active.length) return stop('active', `A synthesize job is already ${active[0].status} (${active[0].id}). At most one runs at a time.`, { job: active[0] });

      let open = [];
      try { open = await openLearnings(); }
      catch (err) { return stop('unknown', `Could not check for an open learnings proposal (${err.message}), so nothing was queued.`); }
      if (open.length) return stop('open-proposal', `A learnings proposal is still open (${open[0].id}). Approve or turn it down first.`, { proposal: open[0] });

      const at = now();
      const runs = await runsToday(at);
      if (runs >= s.maxRunsPerDay) {
        return stop('daily-cap', `${plural(runs, 'run')} already today, and synthesis.max_runs_per_day is ${s.maxRunsPerDay}. Try again tomorrow.`);
      }

      const mainSha = await git.revParse(config.service.git.main);
      const last = await store.kv.get(STATE_NS, STATE_KEY);
      const changed = await changedSourcePages(last?.mainSha || '', mainSha);
      if (!force && changed.length < s.minChangedPages) {
        return stop('below-threshold', `${plural(changed.length, 'source page')} changed since the last run, and synthesis.min_changed_pages is ${s.minChangedPages}.${via === 'manual' ? ' Use --force to run anyway.' : ''}`, { changed: changed.length });
      }

      const slot = await claim(at, s.maxRunsPerDay);
      if (!slot) return stop('daily-cap', `synthesis.max_runs_per_day is ${s.maxRunsPerDay} and today's runs are already taken (another process may have just queued one). Try again tomorrow.`);
      const release = () => store.kv.delete(CLAIM_NS, slot).catch((err) => log.warn('synthesis: could not release a run slot', { slot, error: err.message }));

      let job;
      try {
        job = await enqueue({ kind: 'synthesize', source: null, trigger: 'synthesis', requestedBy });
      } catch (err) {
        await release();
        log.error('synthesis: could not queue a job', { via, error: err.message });
        return stop('enqueue-failed', `The job could not be queued: ${err.message}`);
      }
      if (job?.deduplicated) await release();
      if (job?.deduplicated) return stop('active', `A synthesize job is already ${job.status} (${job.id}). At most one runs at a time.`, { job });
      await store.kv.set(STATE_NS, STATE_KEY, { mainSha, at: at.toISOString(), jobId: job.id, changed: changed.length });
      await store.kv.set(JOB_NS, job.id, { claim: slot });
      // The worker may have ended the job before the link above was written.
      const fresh = await store.jobs.get(job.id).catch(() => null);
      if (fresh && fresh.status !== 'queued' && fresh.status !== 'running') await onJobFinished({ job: fresh });
      log.info('synthesis: queued', { job: job.id, via, changed: changed.length, force });
      return { queued: true, code: 'queued', job, changed: changed.length };
    });
  }

  /**
   * The queue ended a job (`job.finished`). A synthesize job that failed before
   * the agent produced anything (no run report and no recorded cost) gives its
   * claim back, at most once per UTC day. The day's `<day>:released` marker is
   * taken with setIfAbsent first, so a second early failure the same day keeps
   * its claim. Never throws: it is a bus handler.
   */
  async function onJobFinished({ job } = {}) {
    try {
      if (job?.kind !== 'synthesize') return;
      const link = await store.kv.get(JOB_NS, job.id);
      if (!link?.claim) return;
      await store.kv.delete(JOB_NS, job.id);
      if (job.status !== 'failed' || job.runReport || job.costUsd != null) return;   // the agent ran, or the job did not fail

      const day = link.claim.split(':')[0];
      const marker = `${day}:released`;
      const first = await store.kv.setIfAbsent(CLAIM_NS, marker, { at: now().toISOString(), job: job.id });
      if (!first) {
        log.debug('synthesis: kept the run claim: a claim was already released today', { job: job.id, claim: link.claim });
        return;
      }
      await store.kv.delete(CLAIM_NS, link.claim);
      // runsToday counts the jobs, so the job must stop counting too.
      await store.jobs.update(job.id, { claimReleased: true });
      log.info('synthesis: released the run claim: the job failed before the agent ran, so the day is not used up', { job: job.id, claim: link.claim, error: job.error });
    } catch (err) {
      log.error('synthesis: could not check a finished synthesize job', { job: job?.id, error: err.message });
    }
  }

  /** After a merge: never throws, so it can never break the merge that triggered it. */
  async function onMerged({ proposal } = {}) {
    try {
      if (proposal?.kind === 'learnings') return null;   // the loop guard: a learning's own merge starts nothing
      const out = await request({ via: 'merge' });
      if (!out.queued) log.debug('synthesis: not queued after a merge', { code: out.code, reason: out.reason });
      return out;
    } catch (err) {
      log.error('synthesis: check after a merge failed — the merge itself is unaffected', { proposal: proposal?.id, error: err.message });
      return null;
    }
  }

  // ── cron ──────────────────────────────────────────────────────────────────

  /** One cron check at `at`. Exposed for tests; the timer calls it every minute. */
  async function tick(at = now()) {
    if (!cron) return null;
    const minute = Math.floor(at.getTime() / 60000);
    if (!cron.matches(at) || lastMinute === minute) return null;
    lastMinute = minute;
    try { return await request({ via: 'schedule' }); }
    catch (err) {
      log.error('synthesis: scheduled check failed', { error: err.message });
      return null;
    }
  }

  function arm() {
    const at = now();
    const delay = 60000 - (at.getSeconds() * 1000 + at.getMilliseconds()) + 50;
    timer = setTimeout(async () => {
      try { await tick(); } finally { if (timer) arm(); }
    }, delay);
    timer.unref?.();
  }

  return {
    request,
    onMerged,
    tick,
    changedSourcePages,
    get settings() { return settings(); },

    start() {
      if (unsubscribe) return;
      unsubscribe = bus.on('proposal.merged', onMerged);
      unsubscribeFinished = bus.on('job.finished', onJobFinished);
      const { schedule } = settings();
      if (schedule) {
        try { cron = parseCron(schedule); arm(); log.info('synthesis: scheduled', { schedule: cron.expr }); }
        catch (err) { log.error('synthesis: bad schedule — it will not run on a schedule', { error: err.message }); }
      }
    },

    stop() {
      if (!unsubscribe) return;
      unsubscribe();
      unsubscribe = null;
      unsubscribeFinished?.();
      unsubscribeFinished = null;
      clearTimeout(timer);
      timer = null;
      cron = null;
    },
  };
}
