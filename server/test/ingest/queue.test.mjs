import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { cleanup, setup } from './_setup.mjs';

after(cleanup);

describe('queue: enqueue', () => {
  it('fingerprints and stages a local source, and dedups on (kind, source.id, source.sha256)', async () => {
    const t = await setup();
    const a = await t.drop('Q3 Notes.md', 'v1\n');
    assert.equal(a.status, 'queued');
    assert.equal(a.source.id, 'q3-notes-md');
    assert.match(a.source.sha256, /^[0-9a-f]{64}$/);
    assert.ok(a.source.staged.endsWith(a.source.sha256));
    assert.equal(a.maxAttempts, 2);
    assert.equal(a.requestedBy, 'usr_ada');

    const again = await t.ctx.ingest.enqueue({ kind: 'ingest', source: { kind: 'local', path: 'brain/raw/Q3 Notes.md' }, trigger: 'hook', requestedBy: 'svc:ingest' });
    assert.equal(again.id, a.id, 'same bytes while queued → the existing job');

    const changed = await t.drop('Q3 Notes.md', 'v2\n');
    assert.notEqual(changed.id, a.id, 'different bytes → a new job');
    assert.equal((await t.ctx.ingest.list({ status: 'queued' })).length, 2);
    await t.stop();
  });

  it('dedups connector refs the same way and rejects malformed jobs', async () => {
    const t = await setup();
    const ref = { kind: 'connector', id: 'drive-spec', connector: 'drive', ref: 'f1', sha256: 'a'.repeat(64) };
    const one = await t.ctx.ingest.enqueue({ kind: 'ingest', source: ref, trigger: 'schedule', requestedBy: 'svc:ingest' });
    const two = await t.ctx.ingest.enqueue({ kind: 'ingest', source: { ...ref }, trigger: 'schedule', requestedBy: 'svc:ingest' });
    assert.equal(two.id, one.id);
    await assert.rejects(() => t.ctx.ingest.enqueue({ kind: 'ingest', trigger: 'manual' }), /needs a source/);
    await assert.rejects(() => t.ctx.ingest.enqueue({ kind: 'revise', trigger: 'decision' }), /needs a proposalId/);
    await assert.rejects(() => t.ctx.ingest.enqueue({ kind: 'nope', source: ref }), /kind must be/);
    await assert.rejects(() => t.ctx.ingest.enqueue({ kind: 'ingest', source: ref, trigger: 'sometime' }), /trigger must be/);
    await assert.rejects(() => t.ctx.ingest.enqueue({ kind: 'ingest', source: { kind: 'local', path: '../../etc/passwd' } }), /not under brain\/raw/);
    await t.stop();
  });

  it('coalesces a queued revise for the same proposal; dedups drop-page on (proposal, slug)', async () => {
    const t = await setup();
    const r1 = await t.ctx.ingest.enqueue({ kind: 'revise', proposalId: 'prp_1', instructions: 'Replace the claim.', trigger: 'decision' });
    const r2 = await t.ctx.ingest.enqueue({ kind: 'revise', proposalId: 'prp_1', instructions: 'Also fix the title.', trigger: 'feedback' });
    assert.equal(r2.id, r1.id);
    assert.match(r2.instructions, /Replace the claim\.[\s\S]*Also fix the title\./);
    const other = await t.ctx.ingest.enqueue({ kind: 'revise', proposalId: 'prp_2', instructions: 'x', trigger: 'decision' });
    assert.notEqual(other.id, r1.id);

    const d1 = await t.ctx.ingest.enqueue({ kind: 'drop-page', proposalId: 'prp_1', slug: 'alpha', trigger: 'feedback' });
    const d2 = await t.ctx.ingest.enqueue({ kind: 'drop-page', proposalId: 'prp_1', slug: 'alpha', trigger: 'feedback' });
    const d3 = await t.ctx.ingest.enqueue({ kind: 'drop-page', proposalId: 'prp_1', slug: 'beta', trigger: 'feedback' });
    assert.equal(d2.id, d1.id);
    assert.notEqual(d3.id, d1.id);
    await t.stop();
  });

  it('emits job.queued', async () => {
    const t = await setup();
    const seen = t.ctx.bus.waitFor('job.queued');
    const job = await t.drop('evt.md');
    assert.equal((await seen).job.id, job.id);
    await t.stop();
  });
});

describe('queue: workers', () => {
  it('claims, emits started/finished, and retries a retryable failure', async () => {
    const t = await setup({ mode: 'crash-once' });
    const started = [];
    t.ctx.bus.on('job.started', ({ job }) => started.push(job.attempts));
    await t.app.start({ http: false });
    const done = await t.finished(await t.drop('flaky.md'));
    assert.equal(done.status, 'succeeded', done.error);
    assert.equal(done.attempts, 2);
    assert.deepEqual(started, [1, 2]);
    assert.match(done.lastError, /simulated crash/);
    await t.stop();
  });

  it('gives up after max_attempts', async () => {
    const t = await setup({ mode: 'crash', ingest: { max_attempts: 3 } });
    await t.app.start({ http: false });
    const done = await t.finished(await t.drop('broken.md'));
    assert.equal(done.status, 'failed');
    assert.equal(done.attempts, 3);
    assert.match(done.error, /driver fake failed: simulated crash/);
    await t.stop();
  });

  it('times out a hung agent and kills it', async () => {
    const t = await setup({ mode: 'hang', ingest: { timeout_minutes: 0.005, max_attempts: 1 } });
    await t.app.start({ http: false });
    const t0 = Date.now();
    const done = await t.finished(await t.drop('slow.md'));
    assert.equal(done.status, 'failed');
    assert.match(done.error, /timed out/);
    assert.ok(Date.now() - t0 < 10000);
    await t.stop();
  });

  it('runs jobs concurrently up to ingest.concurrency', async () => {
    const t = await setup({ ingest: { concurrency: 2 } });
    await t.app.start({ http: false });
    const jobs = await Promise.all([t.drop('one.md', 'one\n'), t.drop('two.md', 'two\n')]);
    const done = await Promise.all(jobs.map((j) => t.finished(j)));
    assert.deepEqual(done.map((j) => j.status), ['succeeded', 'succeeded']);
    assert.notEqual(done[0].workerId, done[1].workerId);
    await t.stop();
  });

  it('stop() returns a running job to the queue without counting the attempt', async () => {
    const t = await setup({ mode: 'hang' });
    await t.app.start({ http: false });
    const started = t.ctx.bus.waitFor('job.started');
    const job = await t.drop('interrupted.md');
    await started;
    await t.ctx.ingest.stop();
    const back = await t.ctx.ingest.get(job.id);
    assert.equal(back.status, 'queued');
    assert.equal(back.attempts, 0);
    await t.stop();
  });

  it('cancel() stops a queued or running job', async () => {
    const t = await setup({ mode: 'hang' });
    const queued = await t.drop('later.md');
    assert.equal((await t.ctx.ingest.cancel(queued.id)).status, 'cancelled');
    await t.app.start({ http: false });
    const started = t.ctx.bus.waitFor('job.started');
    const running = await t.drop('now.md');
    await started;
    const fin = t.finished(running);
    await t.ctx.ingest.cancel(running.id);
    assert.equal((await fin).status, 'cancelled');
    await t.stop();
  });

  it('recovers a job left running by a dead worker', async () => {
    const t = await setup();
    const job = await t.drop('orphan.md');
    await t.ctx.store.jobs.update(job.id, { status: 'running', attempts: 1, workerId: `${(await import('node:os')).hostname()}:999999:dead:0` });
    const fin = t.finished(job);
    await t.app.start({ http: false });
    const done = await fin;
    assert.equal(done.status, 'succeeded');
    assert.equal(done.attempts, 1);
    await t.stop();
  });
});
