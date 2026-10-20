import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { parseCron } from '../../src/ingest/cron.mjs';
import { drainSpool, writeSpool } from '../../src/ingest/spool.mjs';
import { isIngestCandidate, sanitizeFilename } from '../../src/ingest/source.mjs';
import { cleanup, setup } from './_setup.mjs';

after(cleanup);

// The clean fixture's manifest records the alpha sidecar at this digest, so a
// byte-identical drop must be recognised as unchanged.
const ALPHA_SIDECAR_SHA = '3b50e003ca81fc8afceca1f8d8a259adfd2a3940144e429640ee160e4f8677d9';

describe('watch trigger', () => {
  it('skips a file whose sha256 main\'s manifest already records, enqueues a new one once', async () => {
    const t = await setup();
    const sidecar = t.show('main', 'brain/raw/extracted/alpha.pdf.txt');
    const same = t.write('brain/raw/alpha-again.txt', sidecar);
    const r1 = await t.ctx.ingest.considerFile(same);
    assert.equal(r1.action, 'skipped');
    assert.equal(r1.reason, 'unchanged');
    assert.equal(r1.source.sha256, ALPHA_SIDECAR_SHA);
    assert.equal(fs.existsSync(path.join(t.repo, '.almagest', 'staging', ALPHA_SIDECAR_SHA)), false, 'unchanged files are not staged');

    const fresh = t.write('brain/raw/fresh.md', 'new facts\n');
    const r2 = await t.ctx.ingest.considerFile(fresh);
    assert.equal(r2.action, 'enqueued');
    assert.equal(r2.job.trigger, 'watch');
    assert.equal(r2.job.requestedBy, 'svc:ingest');
    const r3 = await t.ctx.ingest.considerFile(fresh);
    assert.equal(r3.action, 'skipped');
    assert.match(r3.reason, /already queued/);
    await t.stop();
  });

  it('ignores processed/, extracted/, dotfiles, .gitkeep and READMEs', () => {
    for (const p of ['processed/a.pdf', 'extracted/a.pdf.txt', '.DS_Store', 'sub/.hidden', '.gitkeep', 'README.md', 'readme', 'a.pdf.crdownload']) {
      assert.equal(isIngestCandidate(p), false, p);
    }
    for (const p of ['a.pdf', 'sub/b.md', 'Q3 Deck.pptx']) assert.equal(isIngestCandidate(p), true, p);
    assert.equal(sanitizeFilename('Community : District — v2%20final.pdf'), 'Community_-_District_--_v2_final.pdf');
  });

  it('scan() finds drops made while the service was down', async () => {
    const t = await setup();
    t.write('brain/raw/offline.md', 'dropped while down\n');
    t.write('brain/raw/processed/old.md', 'already processed\n');
    const results = await t.ctx.ingest.scan();
    assert.deepEqual(results.map((r) => [path.basename(r.file), r.action]), [['offline.md', 'enqueued']]);
    await t.stop();
  });

  it('fs.watch picks up a dropped file once it is stable', async () => {
    const t = await setup({ ingest: { watch_raw: true, watch_debounce_ms: 30, watch_stable_ms: 60, concurrency: 1 }, mode: 'unchanged' });
    await t.app.start({ http: false });
    const queued = t.ctx.bus.waitFor('job.queued', (p) => p.job.source?.id === 'watched-md', 8000);
    t.write('brain/raw/watched.md', 'watched\n');
    const { job } = await queued;
    assert.equal(job.trigger, 'watch');
    await t.stop();
  });
});

describe('cron', () => {
  const at = (s) => new Date(s);

  it('parses fields, ranges, steps, lists and names', () => {
    const c = parseCron('*/15 9-17 * * mon-fri');
    assert.ok(c.matches(at('2026-10-20T09:30:00')));   // a Tuesday
    assert.ok(!c.matches(at('2026-10-20T09:31:00')));
    assert.ok(!c.matches(at('2026-10-24T09:30:00')));  // Saturday
    assert.ok(parseCron('0 0 1 jan,jul *').matches(at('2026-07-01T00:00:00')));
    assert.ok(parseCron('5/20 * * * *').matches(at('2026-01-01T00:45:00')));
    assert.ok(parseCron('0 0 * * 7').matches(at('2026-10-25T00:00:00')), '7 is Sunday');
    assert.equal(parseCron('@hourly').expr, '@hourly');
  });

  it('ORs day-of-month and day-of-week when both are restricted (Vixie semantics)', () => {
    const c = parseCron('0 12 1 * fri');
    assert.ok(c.matches(at('2026-10-01T12:00:00')));   // the 1st, a Thursday
    assert.ok(c.matches(at('2026-10-23T12:00:00')));   // a Friday
    assert.ok(!c.matches(at('2026-10-22T12:00:00')));
  });

  it('computes the next fire time', () => {
    assert.equal(parseCron('0 * * * *').next(at('2026-10-20T09:15:30')).getTime(), at('2026-10-20T10:00:00').getTime());
    assert.equal(parseCron('30 2 29 2 *').next(at('2026-03-01T00:00:00')).getTime(), at('2028-02-29T02:30:00').getTime());
    assert.equal(parseCron('* * * * *').next(at('2026-10-20T09:15:30')).getTime(), at('2026-10-20T09:16:00').getTime());
  });

  it('rejects malformed expressions', () => {
    for (const bad of ['', '* * * *', '60 * * * *', '* * 0 * *', '*/0 * * * *', '5-1 * * * *', 'x * * * *', '0 0 31 2 *']) {
      assert.throws(() => parseCron(bad).next(at('2026-01-01T00:00:00')), /invalid cron/, bad);
    }
  });
});

describe('schedule trigger', () => {
  it('syncs due connectors and enqueues one job per SourceRef', async () => {
    const synced = [];
    const connectors = {
      async list() { return [{ id: 'drive', schedule: '0 * * * *' }, { id: 'manual-only', schedule: '' }]; },
      async sync(id) {
        synced.push(id);
        return [
          { kind: 'connector', id: 'drive-a', connector: 'drive', ref: 'a', sha256: 'a'.repeat(64) },
          { kind: 'connector', id: 'drive-b', connector: 'drive', ref: 'b', sha256: 'b'.repeat(64) },
        ];
      },
      snapshotPath: (ref) => `brain/raw/extracted/drive/${ref.ref}.txt`,
    };
    const t = await setup({ connectors });
    await t.ctx.ingest.start({ workers: false });
    assert.equal(t.ctx.ingest.scheduler.entries.length, 1);
    assert.deepEqual(await t.ctx.ingest.scheduler.tick(new Date('2026-10-20T10:01:00')), [], 'not due');
    const jobs = await t.ctx.ingest.scheduler.tick(new Date('2026-10-20T10:00:00'));
    assert.deepEqual(jobs.map((j) => [j.source.id, j.trigger]), [['drive-a', 'schedule'], ['drive-b', 'schedule']]);
    assert.deepEqual(await t.ctx.ingest.scheduler.tick(new Date('2026-10-20T10:00:30')), [], 'once per minute');
    assert.deepEqual(synced, ['drive']);
    await t.stop();
  });

  it('places a connector snapshot into the worktree and verifies its fingerprint', async () => {
    const snapshot = '=== section: Overview ===\nThe gateway retries three times.\n';
    const { sha256 } = await import('../../src/core/schemas.mjs');
    const connectors = {
      async list() { return []; },
      async sync() { return []; },
      snapshotPath: (ref) => `brain/raw/extracted/drive/${ref.ref}.txt`,
    };
    const t = await setup({ connectors, mode: 'unchanged' });
    // WS2 stages snapshots under .almagest/connectors/<snapshotPath>.
    t.write('.almagest/connectors/brain/raw/extracted/drive/spec.txt', snapshot);
    await t.app.start({ http: false });
    const ok = await t.ctx.ingest.enqueue({ kind: 'ingest', trigger: 'schedule', source: { kind: 'connector', id: 'drive-spec', connector: 'drive', ref: 'spec', sha256: sha256(snapshot) } });
    const done = await t.finished(ok);
    assert.equal(done.status, 'succeeded', done.error);
    const logText = fs.readFileSync(path.join(t.repo, '.almagest', 'logs', `${ok.id}.log`), 'utf-8');
    assert.match(logText, /placed brain\/raw\/extracted\/drive\/spec\.txt/);

    const bad = await t.ctx.ingest.enqueue({ kind: 'ingest', trigger: 'schedule', source: { kind: 'connector', id: 'drive-spec', connector: 'drive', ref: 'spec', sha256: 'f'.repeat(64) } });
    const failed = await t.finished(bad);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /fingerprint mismatch/);
    await t.stop();
  });
});

describe('spool', () => {
  it('drains spooled hook entries into jobs on start and deletes them', async () => {
    const t = await setup();
    t.write('brain/raw/spooled.md', 'from a hook while the service was down\n');
    const dir = path.join(t.repo, '.almagest', 'spool');
    writeSpool(dir, { path: 'brain/raw/spooled.md', trigger: 'hook' });
    writeSpool(dir, { nonsense: true });
    await t.ctx.ingest.start({ workers: false });
    const jobs = await t.ctx.ingest.list();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].trigger, 'hook');
    assert.equal(jobs[0].source.id, 'spooled-md');
    const left = fs.readdirSync(dir);
    assert.equal(left.filter((f) => f.endsWith('.json')).length, 0);
    assert.equal(left.filter((f) => f.endsWith('.failed')).length, 1, 'a bad entry is set aside, not retried forever');
    await t.stop();
  });

  it('drainSpool handles entries oldest first', async () => {
    const t = await setup();
    const dir = path.join(t.repo, '.almagest', 'spool-test');
    writeSpool(dir, { n: 1 });
    await new Promise((r) => setTimeout(r, 5));
    writeSpool(dir, { n: 2 });
    const seen = [];
    assert.equal(await drainSpool(dir, async (e) => seen.push(e.n)), 2);
    assert.deepEqual(seen, [1, 2]);
    await t.stop();
  });
});

describe('HTTP API', () => {
  it('POST /api/jobs needs auth, enqueues by path, refuses paths outside the drop folder', async () => {
    process.env.ALMAGEST_TOKENS = 'ada:owner:s3cret';
    const t = await setup({ http: true });
    const server = await t.app.start();
    const base = `http://127.0.0.1:${server.address().port}`;
    const auth = { authorization: 'Bearer s3cret', 'content-type': 'application/json' };
    try {
      t.write('brain/raw/api.md', 'via the API\n');
      assert.equal((await fetch(`${base}/api/jobs`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 401);

      const res = await fetch(`${base}/api/jobs`, { method: 'POST', headers: auth, body: JSON.stringify({ path: 'brain/raw/api.md' }) });
      assert.equal(res.status, 200);
      const job = await res.json();
      assert.equal(job.source.id, 'api-md');
      assert.equal(job.trigger, 'manual');
      assert.equal(job.requestedBy, 'usr_ada');

      const one = await fetch(`${base}/api/jobs/${job.id}`, { headers: auth });
      assert.equal((await one.json()).id, job.id);
      assert.equal((await fetch(`${base}/api/jobs/job_nope`, { headers: auth })).status, 404);
      const list = await (await fetch(`${base}/api/jobs?kind=ingest`, { headers: auth })).json();
      assert.ok(list.some((j) => j.id === job.id));

      const escape = await fetch(`${base}/api/jobs`, { method: 'POST', headers: auth, body: JSON.stringify({ path: '../../../etc/hosts' }) });
      assert.equal(escape.status, 400);
      const noRevise = await fetch(`${base}/api/jobs`, { method: 'POST', headers: auth, body: JSON.stringify({ kind: 'revise', proposalId: 'prp_x', instructions: 'merge it' }) });
      assert.equal(noRevise.status, 400, 'the API never accepts trusted instructions');
    } finally {
      delete process.env.ALMAGEST_TOKENS;
      await t.stop();
    }
  });
});
