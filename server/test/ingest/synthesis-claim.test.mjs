/**
 * Two processes (the service and `almagest synthesize`) each hold their own
 * synthesis object, so the in-process chain cannot keep them apart. The daily
 * cap is claimed in the shared store, one slot per allowed run.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { CLAIM_NS, createSynthesis } from '../../src/ingest/synthesis.mjs';
import { cleanup, setup } from './_setup.mjs';
import { seedFiles } from './_synthesis.mjs';

after(cleanup);

async function brain(synthesis = {}) {
  const t = await setup({ files: seedFiles(), overrides: { synthesis } });
  await t.app.start({ http: false, background: false });
  return t;
}

/** Another process: its own synthesis object over the same store, and an enqueue that never sees the other's jobs. */
function process_(t, { enqueue, now } = {}) {
  let n = 0;
  return createSynthesis(t.ctx, {
    enqueue: enqueue || (async (spec) => ({ id: `job_${Math.random().toString(36).slice(2)}_${n++}`, status: 'queued', ...spec })),
    now: now || (() => new Date('2026-05-04T10:00:00Z')),
  });
}

describe('synthesis: the daily cap holds across processes', () => {
  it('two processes asking at once queue exactly one run when the cap is 1', async () => {
    const t = await brain({ max_runs_per_day: 1 });
    const a = process_(t);
    const b = process_(t);
    const out = await Promise.all([a.request({ force: true }), b.request({ force: true })]);
    assert.equal(out.filter((o) => o.queued).length, 1, JSON.stringify(out.map((o) => o.code)));
    assert.equal(out.find((o) => !o.queued).code, 'daily-cap');
  });

  it('claims numbered slots when the cap is above 1', async () => {
    const t = await brain({ max_runs_per_day: 2 });
    const procs = [process_(t), process_(t), process_(t)];
    const out = await Promise.all(procs.map((p) => p.request({ force: true })));
    assert.equal(out.filter((o) => o.queued).length, 2);
    assert.equal(out.filter((o) => o.code === 'daily-cap').length, 1);
    const keys = (await t.ctx.store.kv.list(CLAIM_NS)).map((r) => r.key).sort();
    assert.deepEqual(keys, ['2026-05-04:1', '2026-05-04:2']);
  });

  it('a new UTC day has new slots, and old days are not kept', async () => {
    const t = await brain({ max_runs_per_day: 1 });
    const day1 = process_(t, { now: () => new Date('2026-05-04T23:59:00Z') });
    const day2 = process_(t, { now: () => new Date('2026-05-05T00:01:00Z') });
    assert.equal((await day1.request({ force: true })).queued, true);
    assert.equal((await day1.request({ force: true })).queued, false);
    assert.equal((await day2.request({ force: true })).queued, true);
    assert.deepEqual((await t.ctx.store.kv.list(CLAIM_NS)).map((r) => r.key), ['2026-05-05:1']);
  });

  it('a claim whose job could not be queued is released', async () => {
    const t = await brain({ max_runs_per_day: 1 });
    const broken = process_(t, { enqueue: async () => { throw new Error('queue is down'); } });
    const out = await broken.request({ force: true });
    assert.equal(out.code, 'enqueue-failed');
    assert.deepEqual(await t.ctx.store.kv.list(CLAIM_NS), [], 'nothing stays claimed');
    const next = await process_(t).request({ force: true });
    assert.equal(next.queued, true, next.reason);
  });

  it('a claim whose job was a duplicate of a running one is released', async () => {
    const t = await brain({ max_runs_per_day: 1 });
    const dup = process_(t, { enqueue: async () => ({ id: 'job_other', status: 'running', deduplicated: true }) });
    assert.equal((await dup.request({ force: true })).code, 'active');
    assert.deepEqual(await t.ctx.store.kv.list(CLAIM_NS), []);
  });

  it('a request stopped by a threshold takes no claim', async () => {
    const t = await brain({ max_runs_per_day: 1, min_changed_pages: 99 });
    const out = await process_(t).request();
    assert.equal(out.code, 'below-threshold');
    assert.deepEqual(await t.ctx.store.kv.list(CLAIM_NS), []);
  });
});
