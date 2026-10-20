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
    const t = await setup({ ingest: { watch_raw: true, watch_debounce_ms: 30, watch_stable_ms: 60, watch_rescan_seconds: 0 }, mode: 'unchanged' });
    await t.app.start({ http: false });
    // FSEvents only reports changes after its stream is live; give it a moment.
    await new Promise((r) => setTimeout(r, 500));
    const queued = t.ctx.bus.waitFor('job.queued', (p) => p.job.source?.id === 'watched-md', 15000);
    t.write('brain/raw/watched.md', 'watched\n');
    const { job } = await queued;
    assert.equal(job.trigger, 'watch');
    await t.stop();
  });

  it('the periodic rescan catches what fs.watch missed, without re-hashing what it already decided', async () => {
    const t = await setup();
    t.write('brain/raw/first.md', 'first\n');
    assert.deepEqual((await t.ctx.ingest.scan({ onlyUnseen: true })).map((r) => r.action), ['enqueued']);
    t.write('brain/raw/second.md', 'second\n');
    const again = await t.ctx.ingest.scan({ onlyUnseen: true });
    assert.deepEqual(again.map((r) => path.basename(r.file)), ['second.md'], 'first.md is not considered again');
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

  it('places a connector snapshot via connectors.materialize, commits it as the sidecar, and passes the audit', async () => {
    const { sha256 } = await import('../../src/core/schemas.mjs');
    const staged = new Map();
    // Stand-in for WS2's materialize: copy the staged bytes to snapshotPath, refuse a stale sha.
    const connectors = {
      async list() { return []; },
      async sync() { return []; },
      snapshotPath: (ref) => `brain/raw/extracted/drive/${ref.ref}.txt`,
      async materialize(ref, wt) {
        const bytes = staged.get(ref.ref);
        if (sha256(bytes) !== ref.sha256) throw new Error(`staged snapshot for ${ref.id} no longer matches — re-sync`);
        const rel = `brain/raw/extracted/drive/${ref.ref}.txt`;
        fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
        fs.writeFileSync(path.join(wt, rel), bytes);
        return rel;
      },
    };
    const snapshot = '--- end of header ---\n=== section: Overview ===\nThe gateway retries three times.\n';
    staged.set('spec', snapshot);
    const t = await setup({ connectors });
    await t.app.start({ http: false });
    const ref = { kind: 'connector', id: 'drive:spec', connector: 'drive', server: 'google-drive', ref: 'spec', sha256: sha256(snapshot), change: 'new', title: 'Gateway spec' };
    const ok = await t.ctx.ingest.enqueue({ kind: 'ingest', trigger: 'schedule', source: ref });
    const done = await t.finished(ok);
    assert.equal(done.status, 'succeeded', done.error);
    assert.equal(t.show(done.branch, 'brain/raw/extracted/drive/spec.txt'), snapshot, 'the snapshot is committed, not moved');
    assert.match(t.show(done.branch, 'brain/manifest.yaml'), /kind: connector/);
    assert.equal(t.governance.calls[0].details.audit.exit, 0);

    // A 15-minute schedule re-lists the item while its proposal is open: no new job.
    const again = await t.ctx.ingest.enqueue({ kind: 'ingest', trigger: 'schedule', source: { ...ref } });
    assert.equal(again.id, ok.id);
    // Once that proposal is closed, the same bytes may be ingested again.
    t.governance.proposals.get(done.proposalId).status = 'rejected';
    const after = await t.ctx.ingest.enqueue({ kind: 'ingest', trigger: 'schedule', source: { ...ref } });
    assert.notEqual(after.id, ok.id);
    await t.ctx.ingest.cancel(after.id);

    staged.set('spec', `${snapshot}edited after the sync\n`);
    const stale = await t.finished(await t.ctx.ingest.enqueue({ kind: 'ingest', trigger: 'manual', source: { ...ref, id: 'drive:spec-2' } }));
    assert.equal(stale.status, 'failed');
    assert.match(stale.error, /no longer matches/);
    await t.stop();
  });

  it('falls back to the staged snapshot when connectors has no materialize, and checks the fingerprint', async () => {
    const snapshot = '=== section: Overview ===\nThe gateway retries three times.\n';
    const { sha256 } = await import('../../src/core/schemas.mjs');
    const connectors = { async list() { return []; }, async sync() { return []; }, snapshotPath: (ref) => `brain/raw/extracted/drive/${ref.ref}.txt` };
    const t = await setup({ connectors, mode: 'unchanged' });
    t.write('.almagest/connectors/brain/raw/extracted/drive/spec.txt', snapshot);
    await t.app.start({ http: false });
    const done = await t.finished(await t.ctx.ingest.enqueue({ kind: 'ingest', trigger: 'manual', source: { kind: 'connector', id: 'drive-spec', connector: 'drive', ref: 'spec', sha256: sha256(snapshot) } }));
    assert.equal(done.status, 'succeeded', done.error);
    const bad = await t.finished(await t.ctx.ingest.enqueue({ kind: 'ingest', trigger: 'manual', source: { kind: 'connector', id: 'drive-spec', connector: 'drive', ref: 'spec', sha256: 'f'.repeat(64) } }));
    assert.equal(bad.status, 'failed');
    assert.match(bad.error, /fingerprint mismatch/);
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
