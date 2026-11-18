/**
 * A synthesize job that fails before the agent runs must not use up the day.
 * The claim is released once per UTC day; a job that ran (a run report or a
 * cost) keeps its claim, as does a second early failure the same day.
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
  t.synthesis = t.ctx.ingest.synthesis;
  t.synthesis.start();   // subscribes to job.finished, as the service does at boot
  return t;
}

/** Simulates the queue ending a synthesize job: the store record, then the bus event the queue emits. */
async function finish(t, job, patch) {
  const done = await t.ctx.store.jobs.update(job.id, { status: 'failed', finishedAt: new Date().toISOString(), ...patch });
  t.ctx.bus.emit('job.finished', { job: done });
  await t.ctx.bus.drain();
  return done;
}

const claims = async (t) => (await t.ctx.store.kv.list(CLAIM_NS)).map((r) => r.key).sort();
const UNATTENDED = 'refusing to run unattended: this claude build lacks --tools, which the ingest sandbox depends on';

describe('synthesis: a run that failed before the agent started gives its claim back', () => {
  it('releases the claim after an early failure, so a new run can be queued that day', async () => {
    const t = await brain({ max_runs_per_day: 1, min_changed_pages: 1 });
    const first = await t.synthesis.request({ force: true });
    assert.equal(first.queued, true, first.reason);
    assert.equal((await claims(t)).length, 1);

    await finish(t, first.job, { error: UNATTENDED });
    assert.deepEqual(await claims(t), [`${today()}:released`], 'only the once-a-day marker is left');

    const again = await t.synthesis.request({ force: true });
    assert.equal(again.queued, true, again.reason);
  });

  it('does not release a second time the same day, so the cap still holds', async () => {
    const t = await brain({ max_runs_per_day: 1, min_changed_pages: 1 });
    const first = await t.synthesis.request({ force: true });
    await finish(t, first.job, { error: UNATTENDED });

    const second = await t.synthesis.request({ force: true });
    assert.equal(second.queued, true, second.reason);
    await finish(t, second.job, { error: UNATTENDED });

    const third = await t.synthesis.request({ force: true });
    assert.equal(third.queued, false);
    assert.equal(third.code, 'daily-cap');
    assert.ok((await claims(t)).includes(`${today()}:1`), 'the second claim is kept');
  });

  it('keeps the claim when the agent ran (a run report is on the job)', async () => {
    const t = await brain({ max_runs_per_day: 1, min_changed_pages: 1 });
    const first = await t.synthesis.request({ force: true });
    await finish(t, first.job, { error: 'agent reported failure: nothing to learn', runReport: { outcome: 'failed', pages: [], blocked: [] } });

    const next = await t.synthesis.request({ force: true });
    assert.equal(next.code, 'daily-cap');
    assert.deepEqual(await claims(t), [`${today()}:1`]);
  });

  it('keeps the claim when the agent ran and a cost was recorded', async () => {
    const t = await brain({ max_runs_per_day: 1, min_changed_pages: 1 });
    const first = await t.synthesis.request({ force: true });
    await finish(t, first.job, { error: 'run report is not valid JSON', costUsd: 0.42 });

    const next = await t.synthesis.request({ force: true });
    assert.equal(next.code, 'daily-cap');
    assert.deepEqual(await claims(t), [`${today()}:1`]);
  });

  it('keeps the claim of a job that succeeded', async () => {
    const t = await brain({ max_runs_per_day: 1, min_changed_pages: 1 });
    const first = await t.synthesis.request({ force: true });
    await finish(t, first.job, { status: 'succeeded', error: null });

    const next = await t.synthesis.request({ force: true });
    assert.equal(next.code, 'daily-cap');
    assert.deepEqual(await claims(t), [`${today()}:1`]);
  });

  it('logs one line saying why the claim was released', async () => {
    const t = await brain({ max_runs_per_day: 1, min_changed_pages: 1 });
    const lines = [];
    const spyLog = { info: (msg, fields) => lines.push([msg, fields]), debug() {}, warn() {}, error: (msg, fields) => lines.push([msg, fields]) };
    t.synthesis.stop();
    const own = createSynthesis(Object.assign(Object.create(t.ctx), { log: spyLog }), { enqueue: (j) => t.ctx.ingest.enqueue(j) });
    own.start();
    const first = await own.request({ force: true });
    await finish(t, first.job, { error: UNATTENDED });
    own.stop();
    const released = lines.filter(([m]) => /released/.test(m));
    assert.equal(released.length, 1, JSON.stringify(lines.map(([m]) => m)));
    assert.match(released[0][0], /before the agent ran/);
  });
});

function today() {
  return new Date().toISOString().slice(0, 10);
}
