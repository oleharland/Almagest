/**
 * Two edges of a synthesize run (docs/v2/curation-design.md, Part 2):
 *
 *   - `synthesize --force` while a learnings proposal from the same main
 *     commit is open: the request is refused and names the open proposal; a
 *     job queued past that check still cannot touch the open proposal's branch.
 *   - a synthesize job that fails without producing a commit leaves nothing
 *     behind (no worktree, no empty branch); one that has commits keeps both.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { cleanup, fakeGovernance, setup } from './_setup.mjs';
import { seedFiles } from './_synthesis.mjs';

after(cleanup);

async function brain(opts = {}) {
  const t = await setup({ files: seedFiles(), ...opts });
  await t.app.start({ http: false });
  t.synthesis = t.ctx.ingest.synthesis;
  return t;
}

const queue = (t) => t.ctx.ingest.enqueue({ kind: 'synthesize', trigger: 'synthesis', requestedBy: 'svc:synthesis' });
const branchExists = (t, branch) => t.git('branch', '--list', branch).trim() !== '';
const worktreeDir = (t, branch) => path.join(t.ctx.config.paths.worktrees, branch.replaceAll('/', '__'));

describe('synthesize --force while a learnings proposal from the same main commit is open', () => {
  it('is refused with a message that names the open proposal, and nothing is queued', async () => {
    const t = await brain();
    const first = await queue(t);
    const done = await t.finished(first);
    assert.equal(done.status, 'succeeded', done.error);
    const [open] = [...t.governance.proposals.values()];
    open.kind = 'learnings';   // the real governance sets it; the fake one does not
    assert.equal(open.branch, done.branch);
    const headBefore = t.git('rev-parse', done.branch).trim();

    const out = await t.synthesis.request({ force: true, via: 'manual' });
    assert.equal(out.queued, false);
    assert.equal(out.code, 'open-proposal');
    assert.ok(out.reason.includes(open.id), out.reason);
    assert.equal((await t.ctx.store.jobs.list({ kind: 'synthesize' })).length, 1, 'no second job');
    assert.equal(t.git('rev-parse', done.branch).trim(), headBefore, 'the open proposal branch did not move');
  });

  it('a job queued past that check works on a branch of its own and leaves the open proposal alone', async () => {
    const t = await brain();
    const done = await t.finished(await queue(t));
    assert.equal(done.status, 'succeeded', done.error);
    const [open] = [...t.governance.proposals.values()];
    const headBefore = open.headSha;

    const second = await t.finished(await queue(t));
    assert.notEqual(second.branch, done.branch, 'a different branch name');
    assert.match(second.branch, /^ingest\/learnings_[0-9a-f]{7}/);
    assert.equal(t.git('rev-parse', done.branch).trim(), headBefore, 'the first proposal branch is untouched');
    assert.equal(t.governance.proposals.get(open.id).headSha, headBefore, 'and so is its record');
  });
});

describe('a failed synthesize job that made no commit cleans up after itself', () => {
  it('removes its worktree and its empty branch when the agent crashes', async () => {
    const t = await brain({ mode: 'crash' });
    const main = t.git('rev-parse', 'main').trim();
    const branch = `ingest/learnings_${main.slice(0, 7)}`;
    const done = await t.finished(await queue(t), 60000);
    assert.equal(done.status, 'failed');
    assert.equal(done.branch, branch);
    assert.equal(fs.existsSync(worktreeDir(t, branch)), false, 'worktree removed');
    assert.equal(branchExists(t, branch), false, 'empty branch removed');
    assert.equal(t.git('rev-parse', 'main').trim(), main);
  });

  it('does the same when the run is refused before any commit (an existing page was edited)', async () => {
    const t = await brain({ mode: 'write' });
    t.ctx.config.ingest.fake.synth = { files: { 'brain/wiki/alpha.md': 'edited by the agent\n' } };
    const main = t.git('rev-parse', 'main').trim();
    const branch = `ingest/learnings_${main.slice(0, 7)}`;
    const done = await t.finished(await queue(t), 60000);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /may only add new claim pages/);
    assert.equal(fs.existsSync(worktreeDir(t, branch)), false, 'worktree removed');
    assert.equal(branchExists(t, branch), false, 'branch removed');
  });

  it('keeps the worktree and the branch when the job did commit, then failed to hand the proposal over', async () => {
    const governance = fakeGovernance();
    governance.createFromJob = async () => { throw new Error('governance is down'); };
    const t = await brain({ governance });
    const done = await t.finished(await queue(t), 60000);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /governance is down/);
    assert.equal(branchExists(t, done.branch), true, 'a branch with a commit stays');
    assert.equal(fs.existsSync(worktreeDir(t, done.branch)), true, 'and so does its worktree');
    assert.notEqual(t.git('rev-parse', done.branch).trim(), t.git('rev-parse', 'main').trim());
  });

  it('does not delete a branch that was already there', async () => {
    const t = await brain({ mode: 'crash' });
    const main = t.git('rev-parse', 'main').trim();
    const branch = `ingest/learnings_${main.slice(0, 7)}`;
    t.git('branch', branch, main);   // somebody else's branch at the same commit
    const done = await t.finished(await queue(t), 60000);
    assert.equal(done.status, 'failed');
    assert.equal(branchExists(t, branch), true, 'the older branch is not ours to delete');
    assert.notEqual(done.branch, branch, 'the job used a branch of its own');
    assert.equal(branchExists(t, done.branch), false, 'and removed that one');
  });
});
