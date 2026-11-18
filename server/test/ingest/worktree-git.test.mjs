/**
 * The runner never trusts the worktree's `.git` file (D1). An agent that
 * rewrites it — at the main repository's git dir, or at a fake one whose
 * config runs a program — gets a failed job, nothing committed anywhere, and
 * the program never runs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createGit, WorktreeTamperedError } from '../../src/core/git.mjs';
import { makeTempRepo, rmrf } from '../helpers.mjs';
import { cleanup, setup } from './_setup.mjs';

const dirs = [];
after(async () => { await cleanup(); dirs.forEach(rmrf); });

describe('runner: the worktree .git file is never trusted', () => {
  it('a .git rewritten to the main repository fails the job; main and the checkout are untouched', async () => {
    const t = await setup({ mode: 'gitdir' });
    const mainBefore = t.git('rev-parse', 'main').trim();
    await t.app.start({ http: false });
    const done = await t.finished(await t.drop('redirect.md'));

    assert.equal(done.status, 'failed');
    assert.match(done.error, /\.git file was tampered with/);
    assert.equal(done.attempts, 1, 'not retried');
    assert.equal(t.git('rev-parse', 'main').trim(), mainBefore, 'main must not move');
    assert.equal(t.git('rev-list', '--count', `main..${done.branch}`).trim(), '0', 'nothing committed on the branch either');
    assert.equal(t.git('log', '--all', '--format=%s', '--grep', 'ingest: redirect').trim(), '', 'no commit of this job exists anywhere');
    assert.equal(t.git('status', '--porcelain', '--untracked-files=no').trim(), '', 'the main checkout\'s index and tree are untouched');
    assert.equal(t.show('main', 'brain/wiki/redirect.md'), null);
    assert.equal(t.governance.calls.length, 0);
    // Evidence kept: the worktree still holds the rewritten pointer.
    assert.match(fs.readFileSync(path.join(done.worktree, '.git'), 'utf-8'), /^gitdir: /);
    assert.ok(!fs.readFileSync(path.join(done.worktree, '.git'), 'utf-8').includes('/worktrees/'));
    await t.stop();
  });

  it('a .git pointing at a fake git dir with core.fsmonitor never runs the fsmonitor program', async () => {
    const t = await setup({ mode: 'fsmonitor' });
    const marker = path.join(t.repo, '.almagest', 'fsmonitor-ran');
    t.ctx.config.ingest.fake.marker = marker;
    const mainBefore = t.git('rev-parse', 'main').trim();
    await t.app.start({ http: false });
    const done = await t.finished(await t.drop('monitor.md'));

    assert.equal(fs.existsSync(marker), false, 'the fsmonitor hook ran as the service user');
    assert.equal(done.status, 'failed');
    assert.match(done.error, /\.git file was tampered with/);
    assert.equal(t.git('rev-parse', 'main').trim(), mainBefore);
    assert.equal(t.governance.calls.length, 0);

    // The next job on the same branch finds the kept worktree still tampered
    // with and fails before its own reset — which would otherwise run there.
    t.ctx.config.ingest.fake.mode = 'write';
    const again = await t.finished(await t.ctx.ingest.enqueue({ kind: 'ingest', source: done.source, branch: done.branch, trigger: 'manual', requestedBy: 'usr_ada' }));
    assert.equal(again.status, 'failed');
    assert.match(again.error, /\.git file was tampered with/);
    assert.equal(fs.existsSync(marker), false);
    await t.stop();
  });

  it('a normal run commits through the pinned git dir (no hooks run)', async () => {
    const t = await setup();
    // A post-commit hook in the main repository: --no-verify does not skip it, hooksPath does.
    const hook = path.join(t.repo, '.git', 'hooks', 'post-commit');
    const marker = path.join(t.repo, '.almagest', 'hook-ran');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    await t.app.start({ http: false });
    const done = await t.finished(await t.drop('fine.md'));
    assert.equal(done.status, 'succeeded', done.error);
    assert.equal(t.git('rev-list', '--count', `main..${done.branch}`).trim(), '1');
    assert.equal(fs.existsSync(marker), false, 'no hook runs on a service commit');
    await t.stop();
  });
});

describe('git.openWorktree', () => {
  it('finds the admin dir from the repo root and refuses a .git that is not what git wrote', async () => {
    const r = makeTempRepo();
    dirs.push(r);
    const g = createGit({ repoRoot: r });
    assert.equal(await g.openWorktree(r), null, 'the main checkout is not a linked worktree');
    const dir = await g.worktreeAdd('ingest/pin-1234567');
    const wt = await g.openWorktree(dir);
    assert.equal(fs.realpathSync(wt.gitDir), fs.realpathSync(path.join(r, '.git', 'worktrees', path.basename(dir))));
    assert.equal(await wt.branch(), 'ingest/pin-1234567');

    // Changed after opening: every command refuses.
    const dotGit = path.join(dir, '.git');
    const original = fs.readFileSync(dotGit);
    fs.writeFileSync(dotGit, `gitdir: ${path.join(r, '.git')}\n`);
    await assert.rejects(() => wt.run(['status']), WorktreeTamperedError);
    await assert.rejects(() => wt.commitAll({ message: 'x', author: { name: 'a', email: 'a@a' } }), WorktreeTamperedError);
    // Opened while wrong: refused up front, and commitAll(cwd) cannot fall back to the pointer.
    await assert.rejects(() => g.openWorktree(dir), WorktreeTamperedError);
    fs.writeFileSync(path.join(dir, 'brain', 'wiki', 'x.md'), '# x\n');
    await assert.rejects(() => g.commitAll(dir, { message: 'x', author: { name: 'a', email: 'a@a' } }), WorktreeTamperedError);
    assert.equal((await g.run(['rev-list', '--count', 'main'])).trim(), '1', 'nothing reached main');

    // A symlink with the right content is still not the file git wrote.
    fs.rmSync(dotGit);
    const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-dotgit-')), 'dotgit');
    dirs.push(path.dirname(elsewhere));
    fs.writeFileSync(elsewhere, original);
    fs.symlinkSync(elsewhere, dotGit);
    await assert.rejects(() => g.openWorktree(dir), /symbolic link/);
    fs.rmSync(dotGit);
    fs.writeFileSync(dotGit, original);
    assert.ok(await g.openWorktree(dir), 'restored, it opens again');
  });

  it('inherited GIT_DIR / GIT_WORK_TREE do not redirect a command', async () => {
    const r = makeTempRepo();
    const other = makeTempRepo();
    dirs.push(r, other);
    const g = createGit({ repoRoot: r });
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(other, '.git');
    process.env.GIT_WORK_TREE = other;
    try {
      const dir = await g.worktreeAdd('ingest/env-1234567');
      fs.writeFileSync(path.join(dir, 'brain', 'wiki', 'e.md'), '# e\n');
      const sha = await g.commitAll(dir, { message: 'e', author: { name: 'a', email: 'a@a' } });
      assert.equal(await g.revParse('ingest/env-1234567'), sha);
    } finally {
      for (const [k, v] of [['GIT_DIR', saved.dir], ['GIT_WORK_TREE', saved.tree]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});
