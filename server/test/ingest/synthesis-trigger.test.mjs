/**
 * When a synthesize job is queued, and what bounds it. Every route goes
 * through synthesis.request(), so each bound is tested there, and the routes
 * (a merge, a cron tick, the CLI) are tested on top of it.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { commands } from '../../src/ingest/index.mjs';
import { createSynthesis, STATE_KEY, STATE_NS } from '../../src/ingest/synthesis.mjs';
import { cleanup, setup } from './_setup.mjs';
import { claimPage, commitOnMain, seedFiles, sourcePage } from './_synthesis.mjs';

after(cleanup);

/** A brain with four source pages on main and no worker running: queued jobs stay queued. */
async function brain(synthesis = {}) {
  const t = await setup({ files: seedFiles(), overrides: { synthesis } });
  await t.app.start({ http: false, background: false });
  t.synthesis = t.ctx.ingest.synthesis;
  return t;
}

const jobs = (t) => t.ctx.store.jobs.list({ kind: 'synthesize' });
const addSource = (t, slug, n = 1) => commitOnMain(t, { [`brain/wiki/${slug}.md`]: sourcePage({ title: `Page ${slug}`, sourceId: 'beta-pdf', body: `Fact ${n}.` }) }, `add ${slug}`);

describe('synthesis: when a job is queued', () => {
  it('waits for min_changed_pages source pages, then queues one', async () => {
    const t = await brain();
    const first = await t.synthesis.request({ via: 'manual' });
    assert.equal(first.queued, false);
    assert.equal(first.code, 'below-threshold');
    assert.equal(first.changed, 4, 'alpha, beta, delta and epsilon; the two claim pages do not count');
    assert.deepEqual(await jobs(t), []);

    addSource(t, 'zeta');
    const out = await t.synthesis.request({ via: 'manual' });
    assert.equal(out.queued, true, out.reason);
    assert.equal(out.changed, 5);
    assert.equal(out.job.kind, 'synthesize');
    assert.equal(out.job.trigger, 'synthesis');
    assert.equal(out.job.source, null);
    assert.equal(out.job.status, 'queued');
    const state = await t.ctx.store.kv.get(STATE_NS, STATE_KEY);
    assert.equal(state.mainSha, t.git('rev-parse', 'main').trim(), 'the main sha of this run is remembered');
    assert.equal(state.jobId, out.job.id);
  });

  it('counts only what changed since the last run', async () => {
    const t = await brain({ min_changed_pages: 2, max_runs_per_day: 9 });
    const first = await t.synthesis.request();
    assert.equal(first.queued, true);
    await t.ctx.ingest.cancel(first.job.id);

    addSource(t, 'zeta');
    const one = await t.synthesis.request();
    assert.equal(one.code, 'below-threshold');
    assert.equal(one.changed, 1);

    commitOnMain(t, { 'brain/wiki/delta.md': sourcePage({ title: 'Delta Service', sourceId: 'beta-pdf', body: 'Changed.', modified: '2026-03-01' }) });
    const two = await t.synthesis.request();
    assert.equal(two.queued, true, two.reason);
    assert.equal(two.changed, 2, 'one new page and one changed page');
  });

  it('does not count a page that was removed, a claim page, or a template page', async () => {
    const t = await brain({ min_changed_pages: 1, max_runs_per_day: 9 });
    const first = await t.synthesis.request({ force: true });
    await t.ctx.ingest.cancel(first.job.id);
    commitOnMain(t, {
      'brain/wiki/new-claim.md': claimPage({ title: 'Delta and Epsilon again', basis: ['delta', 'epsilon'] }),
      'brain/wiki/_template.md': sourcePage({ title: 'Template', sourceId: 'beta-pdf' }),
    });
    t.git('rm', '-q', 'brain/wiki/epsilon.md');
    t.git('commit', '-q', '-m', 'remove a page');
    assert.deepEqual(await t.synthesis.changedSourcePages(first.job && (await t.ctx.store.kv.get(STATE_NS, STATE_KEY)).mainSha, t.git('rev-parse', 'main').trim()), []);
  });

  it('a merged learnings proposal does not count toward the next threshold and starts nothing', async () => {
    const t = await brain({ min_changed_pages: 1, max_runs_per_day: 9 });
    const first = await t.synthesis.request({ force: true });
    await t.ctx.ingest.cancel(first.job.id);

    // What merging a learnings proposal does to main: a claim page, its index row, a log line.
    commitOnMain(t, { 'brain/wiki/learned.md': claimPage({ title: 'Delta and Epsilon retry differently again', basis: ['delta', 'epsilon'] }) }, 'merge learnings');
    const out = await t.synthesis.request();
    assert.equal(out.code, 'below-threshold');
    assert.equal(out.changed, 0);

    const skipped = await t.synthesis.onMerged({ proposal: { id: 'prp_l', kind: 'learnings' } });
    assert.equal(skipped, null, 'the merge of a learnings proposal is not even checked');
    assert.equal((await jobs(t)).filter((j) => j.status === 'queued').length, 0);
  });

  it('after a merge, queues a job once the threshold is reached', async () => {
    const t = await brain();
    t.synthesis.start();
    t.ctx.bus.emit('proposal.merged', { proposal: { id: 'prp_1' } });
    await t.ctx.bus.drain();
    assert.equal((await jobs(t)).length, 0, 'four pages: below the threshold');

    addSource(t, 'zeta');
    t.ctx.bus.emit('proposal.merged', { proposal: { id: 'prp_2' } });
    await t.ctx.bus.drain();
    const queued = await jobs(t);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].trigger, 'synthesis');
    t.synthesis.stop();
  });

  it('a manual request with force skips the threshold and nothing else', async () => {
    const t = await brain();
    const out = await t.synthesis.request({ force: true });
    assert.equal(out.queued, true, out.reason);
  });
});

describe('synthesis: the bounds', () => {
  it('nothing runs when synthesis.enabled is false, force or not', async () => {
    const t = await brain({ enabled: false, min_changed_pages: 0 });
    for (const force of [false, true]) {
      const out = await t.synthesis.request({ force });
      assert.equal(out.queued, false);
      assert.equal(out.code, 'disabled');
    }
    assert.equal((await jobs(t)).length, 0);
  });

  it('is on by default', async () => {
    const t = await brain();
    assert.equal(t.ctx.config.synthesis.enabled, true);
    assert.equal(t.synthesis.settings.enabled, true);
  });

  it('at most one synthesize job queued or running', async () => {
    const t = await brain({ min_changed_pages: 0, max_runs_per_day: 9 });
    const a = await t.synthesis.request();
    assert.equal(a.queued, true);
    const b = await t.synthesis.request({ force: true });
    assert.equal(b.queued, false);
    assert.equal(b.code, 'active');
    assert.equal((await jobs(t)).length, 1);

    await t.ctx.store.jobs.update(a.job.id, { status: 'running' });
    assert.equal((await t.synthesis.request()).code, 'active', 'a running job counts too');
    await t.ctx.store.jobs.update(a.job.id, { status: 'succeeded' });
    assert.equal((await t.synthesis.request()).queued, true, 'a finished job does not');
  });

  it('two requests at once queue one job', async () => {
    const t = await brain({ min_changed_pages: 0, max_runs_per_day: 9 });
    const [a, b] = await Promise.all([t.synthesis.request(), t.synthesis.request()]);
    assert.deepEqual([a.queued, b.queued].sort(), [false, true]);
    assert.equal((await jobs(t)).length, 1);
  });

  it('the queue itself refuses a second synthesize job', async () => {
    const t = await brain();
    const a = await t.ctx.ingest.enqueue({ kind: 'synthesize', trigger: 'synthesis', requestedBy: 'svc:synthesis' });
    const b = await t.ctx.ingest.enqueue({ kind: 'synthesize', trigger: 'synthesis', requestedBy: 'svc:synthesis' });
    assert.equal(b.id, a.id);
    assert.equal(b.deduplicated, true);
  });

  it('no new run while a learnings proposal is open', async () => {
    const t = await brain({ min_changed_pages: 0, max_runs_per_day: 9 });
    for (const status of ['open', 'changes_requested', 'approved', 'conflicted']) {
      t.governance.proposals.set('prp_l', { id: 'prp_l', kind: 'learnings', status });
      const out = await t.synthesis.request({ force: true });
      assert.equal(out.code, 'open-proposal', status);
      assert.match(out.reason, /prp_l/);
    }
    for (const status of ['merged', 'rejected', 'superseded']) {
      t.governance.proposals.set('prp_l', { id: 'prp_l', kind: 'learnings', status });
      const out = await t.synthesis.request();
      assert.equal(out.queued, true, `${status}: ${out.reason}`);
      await t.ctx.ingest.cancel(out.job.id);
      await t.ctx.store.jobs.delete?.(out.job.id);
    }
  });

  it('an open proposal of another kind does not block', async () => {
    const t = await brain({ min_changed_pages: 0 });
    t.governance.proposals.set('prp_i', { id: 'prp_i', status: 'open' });
    t.governance.proposals.set('prp_t', { id: 'prp_t', kind: 'tier', status: 'open' });
    assert.equal((await t.synthesis.request()).queued, true);
  });

  it('at most max_runs_per_day runs per day, counted from the store by date', async () => {
    const t = await brain({ min_changed_pages: 0, max_runs_per_day: 1 });
    const a = await t.synthesis.request();
    assert.equal(a.queued, true);
    await t.ctx.store.jobs.update(a.job.id, { status: 'succeeded' });
    const b = await t.synthesis.request({ force: true });
    assert.equal(b.queued, false);
    assert.equal(b.code, 'daily-cap');
    assert.match(b.reason, /1 run already today.*max_runs_per_day is 1/);

    // The next day the same brain may run again.
    const tomorrow = createSynthesis(t.ctx, { enqueue: (j) => t.ctx.ingest.enqueue(j), now: () => new Date(Date.now() + 36 * 3600 * 1000) });
    const c = await tomorrow.request();
    assert.equal(c.queued, true, c.reason);
  });

  it('max_runs_per_day of 2 allows a second run the same day', async () => {
    const t = await brain({ min_changed_pages: 0, max_runs_per_day: 2 });
    const a = await t.synthesis.request();
    await t.ctx.store.jobs.update(a.job.id, { status: 'succeeded' });
    const b = await t.synthesis.request();
    assert.equal(b.queued, true, b.reason);
    await t.ctx.store.jobs.update(b.job.id, { status: 'succeeded' });
    assert.equal((await t.synthesis.request()).code, 'daily-cap');
  });

  it('a failed enqueue is logged and never breaks the merge that triggered it', async () => {
    const t = await brain({ min_changed_pages: 0 });
    const broken = createSynthesis(t.ctx, { enqueue: async () => { throw new Error('queue is down'); } });
    const out = await broken.onMerged({ proposal: { id: 'prp_1' } });
    assert.equal(out.queued, false);
    assert.equal(out.code, 'enqueue-failed');
    assert.ok(t.app.log.lines.some((l) => l.level === 'error' && /could not queue/.test(l.msg) && /queue is down/.test(l.error)));
    assert.equal(await t.ctx.store.kv.get(STATE_NS, STATE_KEY), null, 'the last-run marker did not move');

    // Even a failure inside the check itself stays inside the handler.
    const worse = createSynthesis({ ...t.ctx, git: { ...t.ctx.git, revParse: async () => { throw new Error('git is gone'); } } }, { enqueue: async () => null });
    assert.equal(await worse.onMerged({ proposal: { id: 'prp_2' } }), null);
    assert.ok(t.app.log.lines.some((l) => /check after a merge failed/.test(l.msg)));
  });

  it('through a bus merge, a failing enqueue leaves the emitter untouched', async () => {
    const t = await brain({ min_changed_pages: 0 });
    const broken = createSynthesis(t.ctx, { enqueue: async () => { throw new Error('queue is down'); } });
    broken.start();
    assert.doesNotThrow(() => t.ctx.bus.emit('proposal.merged', { proposal: { id: 'prp_1' } }));
    await t.ctx.bus.drain();
    broken.stop();
  });
});

describe('synthesis: the schedule', () => {
  it('is empty by default, so a tick does nothing', async () => {
    const t = await brain({ min_changed_pages: 0 });
    assert.equal(t.ctx.config.synthesis.schedule, '');
    assert.equal(await t.synthesis.tick(new Date(2026, 11, 1, 10, 10)), null);
    assert.equal((await jobs(t)).length, 0);
  });

  it('runs the same check when its cron expression matches, once per minute', async () => {
    const t = await brain({ schedule: '*/10 * * * *', min_changed_pages: 0 });
    const s = createSynthesis(t.ctx, { enqueue: (j) => t.ctx.ingest.enqueue(j) });
    s.start();
    assert.equal(await s.tick(new Date(2026, 11, 1, 10, 11)), null, 'minute 11 does not match');
    const out = await s.tick(new Date(2026, 11, 1, 10, 10));
    assert.equal(out.queued, true, out.reason);
    assert.equal(await s.tick(new Date(2026, 11, 1, 10, 10, 30)), null, 'the same minute fires once');
    s.stop();
    assert.equal((await jobs(t)).length, 1);
  });

  it('a scheduled check meets every bound, the threshold included', async () => {
    const t = await brain({ schedule: '* * * * *' });
    const s = createSynthesis(t.ctx, { enqueue: (j) => t.ctx.ingest.enqueue(j) });
    s.start();
    const out = await s.tick(new Date(2026, 11, 1, 10, 10));
    assert.equal(out.queued, false);
    assert.equal(out.code, 'below-threshold');
    s.stop();
  });

  it('a bad expression is logged and the schedule is not used', async () => {
    const t = await brain({ schedule: 'every tuesday', min_changed_pages: 0 });
    const s = createSynthesis(t.ctx, { enqueue: (j) => t.ctx.ingest.enqueue(j) });
    s.start();
    assert.equal(await s.tick(new Date(2026, 11, 1, 10, 10)), null);
    assert.ok(t.app.log.lines.some((l) => l.level === 'error' && /bad schedule/.test(l.msg)));
    s.stop();
  });
});

describe('almagest synthesize', () => {
  async function cli(t, argv) {
    let out = '';
    let err = '';
    const o = process.stdout.write.bind(process.stdout);
    const e = process.stderr.write.bind(process.stderr);
    // The test runner reports through these streams too, as binary chunks; only the command's own text is kept.
    process.stdout.write = (s, ...rest) => (typeof s === 'string' ? ((out += s), true) : o(s, ...rest));
    process.stderr.write = (s, ...rest) => (typeof s === 'string' ? ((err += s), true) : e(s, ...rest));
    try {
      const code = await commands.synthesize.run(argv, { ctx: t.ctx, repoRoot: t.repo });
      return { code, out, err };
    } finally {
      process.stdout.write = o;
      process.stderr.write = e;
    }
  }

  it('says plainly that the threshold stopped it, and --force gets past it', async () => {
    const t = await brain();
    const stopped = await cli(t, []);
    assert.equal(stopped.code, 1);
    assert.match(stopped.out, /^Not queued\. 4 source pages changed since the last run, and synthesis\.min_changed_pages is 5\. Use --force to run anyway\./);
    assert.equal((await jobs(t)).length, 0);

    const forced = await cli(t, ['--force']);
    assert.equal(forced.code, 0);
    assert.match(forced.out, /Queued\. 4 source pages changed since the last run/);
    assert.equal((await jobs(t)).length, 1);
  });

  it('--force never skips the other bounds', async () => {
    const t = await brain({ min_changed_pages: 0 });
    const first = await cli(t, ['--force']);
    assert.equal(first.code, 0);
    const again = await cli(t, ['--force']);
    assert.equal(again.code, 1);
    assert.match(again.out, /^Not queued\. A synthesize job is already queued/);

    await t.ctx.store.jobs.update((await jobs(t))[0].id, { status: 'succeeded' });
    const capped = await cli(t, ['--force']);
    assert.match(capped.out, /max_runs_per_day is 1/);

    const off = await brain({ enabled: false });
    assert.match((await cli(off, ['--force'])).out, /turned off/);

    const open = await brain({ min_changed_pages: 0 });
    open.governance.proposals.set('prp_l', { id: 'prp_l', kind: 'learnings', status: 'open' });
    assert.match((await cli(open, ['--force'])).out, /learnings proposal is still open/);
  });

  it('refuses an argument it does not know', async () => {
    const t = await brain();
    const out = await cli(t, ['--everything']);
    assert.equal(out.code, 1);
    assert.match(out.err, /usage: almagest synthesize \[--force\]/);
  });

  it('is registered with the other ingest commands', () => {
    assert.equal(typeof commands.synthesize.run, 'function');
    assert.equal(commands.synthesize.needsApp, true);
    assert.match(commands.synthesize.summary, /--force/);
  });
});
