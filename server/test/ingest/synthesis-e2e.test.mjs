/**
 * The whole loop with the real ingest and the real governance and the fake
 * agent: five source pages are merged one after another, the fifth merge queues
 * a synthesize job, the job writes a claim page, a person approves the
 * proposal, and the claim lands on main and passes the audit. Merging the
 * learning does not start another run.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { STATE_KEY, STATE_NS } from '../../src/ingest/synthesis.mjs';
import { AUDIT, git, makeApp, makeTempRepo, rmrf } from '../helpers.mjs';
import { ada, G } from '../governance/fixtures.mjs';

const dirs = [];
after(() => dirs.forEach(rmrf));

describe('synthesis end to end', () => {
  it('five merged source pages queue a run; its proposal is approved; a claim lands on main and passes the audit', async () => {
    const repo = makeTempRepo();
    dirs.push(repo);
    const app = await makeApp({
      repoRoot: repo,
      real: ['ingest', 'governance'],
      overrides: { ingest: { driver: 'fake', watch_raw: false, poll_ms: 25, spool_interval_seconds: 0, fake: { mode: 'write' } } },
    });
    const { ctx } = app;
    const gov = G(app);
    try {
      await app.start({ http: false });
      // A run has just happened on today's main: only what is merged from here on counts.
      await ctx.store.kv.set(STATE_NS, STATE_KEY, { mainSha: git(repo, 'rev-parse', 'main').trim(), at: new Date().toISOString(), jobId: 'job_earlier' });

      const synthJobs = () => ctx.store.jobs.list({ kind: 'synthesize' });
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(path.join(repo, 'brain', 'raw', `notes-${i}.md`), `Widget ${i} ships in March.\n`);
        const job = await ctx.ingest.enqueue({ kind: 'ingest', source: { kind: 'local', path: `brain/raw/notes-${i}.md` }, trigger: 'manual', requestedBy: 'usr_ada' });
        const { job: done } = await ctx.bus.waitFor('job.finished', (p) => p.job.id === job.id, 30000);
        assert.equal(done.status, 'succeeded', done.error);
        const asked = i === 5 ? ctx.bus.waitFor('job.queued', (p) => p.job.kind === 'synthesize', 30000) : null;
        const merged = await gov.approve(done.proposalId, ada);
        assert.equal(merged.status, 'merged', merged.mergeError?.message);
        await ctx.bus.drain();
        if (i < 5) assert.equal((await synthJobs()).length, 0, `after ${i} merged page(s) no run is queued`);
        else assert.equal((await asked).job.trigger, 'synthesis');
      }

      const [queued] = await synthJobs();
      let finished = await ctx.store.jobs.get(queued.id);
      for (let n = 0; n < 1200 && !['succeeded', 'failed', 'blocked', 'cancelled'].includes(finished.status); n++) {
        await new Promise((r) => setTimeout(r, 50));
        finished = await ctx.store.jobs.get(queued.id);
      }
      assert.equal(finished.status, 'succeeded', finished.error);
      assert.match(finished.branch, /^ingest\/learnings_[0-9a-f]{7}$/);

      const proposal = await ctx.governance.getProposal(finished.proposalId);
      assert.equal(proposal.kind, 'learnings');
      assert.equal(proposal.title, '1 thing the brain concluded from what it holds');
      assert.equal(proposal.status, 'open');
      const slug = proposal.changes[0].slug;
      assert.equal(await ctx.git.show('main', `brain/wiki/${slug}.md`), null, 'nothing is on main before a person approves');

      const landed = await gov.approve(proposal.id, ada);
      assert.equal(landed.status, 'merged', landed.mergeError?.message);
      const claim = await ctx.git.show('main', `brain/wiki/${slug}.md`);
      assert.match(claim, /type: claim/);
      assert.match(claim, /origin: self/);
      assert.match(claim, /## Basis/);

      // main, exactly as the repository holds it, passes the audit.
      const out = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-e2e-'));
      dirs.push(out);
      const tar = execFileSync('git', ['archive', '--format=tar', 'main'], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
      execFileSync('tar', ['-x', '-C', out], { input: tar });
      const audit = JSON.parse(execFileSync(process.execPath, [AUDIT, '--repo', out, '--json'], { encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } }));
      assert.equal(audit.ok, true, JSON.stringify(audit.findings.filter((f) => f.severity === 'error')));
      assert.ok(!audit.findings.some((f) => f.severity === 'error'));

      // The learning's own merge starts nothing.
      await ctx.bus.drain();
      assert.equal((await synthJobs()).length, 1);
    } finally {
      await app.stop();
    }
  });
});
