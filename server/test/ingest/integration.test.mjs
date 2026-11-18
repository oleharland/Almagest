import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { makeApp, makeTempRepo, rmrf } from '../helpers.mjs';

const repos = [];
after(() => repos.forEach(rmrf));

// Through ctx the way the composition root wires it: real ingest, real
// governance, fake driver. A dropped file becomes a proposal in the store.
describe('ingest → governance (real modules)', () => {
  it('a drop becomes an open proposal on its ingest branch, with blocked[] as decisions', async () => {
    const repo = makeTempRepo();
    repos.push(repo);
    const app = await makeApp({
      repoRoot: repo,
      real: ['ingest', 'governance'],
      overrides: { ingest: { driver: 'fake', watch_raw: false, poll_ms: 25, spool_interval_seconds: 0, fake: { mode: 'blocked' } } },
    });
    try {
      await app.start({ http: false });
      fs.writeFileSync(path.join(repo, 'brain', 'raw', 'notes.md'), 'The widget ships in March.\n');
      const job = await app.ctx.ingest.enqueue({ kind: 'ingest', source: { kind: 'local', path: 'brain/raw/notes.md' }, trigger: 'manual', requestedBy: 'usr_ada' });
      const { job: done } = await app.ctx.bus.waitFor('job.finished', (p) => p.job.id === job.id, 20000);
      assert.equal(done.status, 'succeeded', done.error);
      assert.ok(done.proposalId);

      const proposal = await app.ctx.governance.getProposal(done.proposalId);
      assert.equal(proposal.branch, done.branch);
      assert.equal(proposal.headSha, done.headSha);
      assert.ok(proposal.changes.some((c) => c.slug === 'notes'));
      const decisions = await app.ctx.store.decisions.listByProposal(proposal.id);
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].kind, 'contradiction');
    } finally {
      await app.stop();
    }
  });
});
