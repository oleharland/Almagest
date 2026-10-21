/**
 * tools/hooks/reference-transaction — the backstop that sees every ref update,
 * whoever typed it — and tools/lib/git-hooks.mjs, its Node side.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { AGENT_ENV_VARS, authorizeMainMove, hooksInstalled, isAgentEnv, mainMoveAuthPath } from '../../../tools/lib/git-hooks.mjs';
import { ada, ALPHA_V2, CLEAN_AUDIT, DELTA, G, govApp, job, proposalBranch } from '../governance/fixtures.mjs';
import { git, makeTempRepo, REPO_ROOT, rmrf } from '../helpers.mjs';

const tmp = [];
after(() => tmp.forEach(rmrf));

/** The test runner may itself run inside an agent session: start from an environment with no agent markers. */
const human = () => {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t', NO_COLOR: '1' };
  for (const k of AGENT_ENV_VARS) delete env[k];
  return env;
};
const agent = (v = 'CLAUDECODE') => ({ ...human(), [v]: '1' });
const run = (cwd, env, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf-8' });

/**
 * A temp repo with this checkout's tools/ committed and core.hooksPath set to
 * it — absolute, as documented: git runs the hooks of a push from $GIT_DIR,
 * where a relative `tools/hooks` does not resolve.
 */
function hookedRepo() {
  const r = makeTempRepo();
  tmp.push(r);
  fs.cpSync(path.join(REPO_ROOT, 'tools'), path.join(r, 'tools'), { recursive: true, filter: (p) => !p.includes('__fixtures__') });
  git(r, 'add', '-A');
  git(r, 'commit', '-qm', 'tools');
  git(r, 'config', 'core.hooksPath', path.join(fs.realpathSync(r), 'tools', 'hooks'));
  return r;
}

/** A branch off main with one commit touching `file`; HEAD goes back to main. */
function branchWith(r, branch, file, content = 'x\n') {
  git(r, 'switch', '-q', '-c', branch);
  fs.mkdirSync(path.dirname(path.join(r, file)), { recursive: true });
  fs.writeFileSync(path.join(r, file), content);
  git(r, 'add', '-A');
  git(r, 'commit', '-qm', `touch ${file}`, '--no-verify');
  git(r, 'switch', '-q', 'main');
  return git(r, 'rev-parse', branch).trim();
}
const mainSha = (r) => git(r, 'rev-parse', 'refs/heads/main').trim();

describe('tools/hooks/reference-transaction', () => {
  it('refuses, from an agent environment, every way of moving a wiki change onto main', () => {
    const r = hookedRepo();
    const wiki = branchWith(r, 'ingest/wiki-1111111', 'brain/wiki/new-page.md', '# new\n');
    const before = mainSha(r);
    const refused = (res, what) => {
      assert.notEqual(res.status, 0, `${what}: ${res.stderr}`);
      assert.match(res.stderr, /refusing to move refs\/heads\/main from an agent environment/, what);
      assert.equal(mainSha(r), before, `${what} left main where it was`);
    };

    refused(run(r, agent(), 'update-ref', 'refs/heads/main', wiki), 'update-ref');
    refused(run(r, agent(), 'update-ref', 'HEAD', wiki), 'update-ref HEAD');
    refused(run(r, agent('AI_AGENT'), 'merge', '-q', '--ff-only', 'ingest/wiki-1111111'), 'merge --ff-only');
    refused(run(r, agent('GEMINI_CLI'), 'reset', '-q', '--soft', wiki), 'reset --soft');

    git(r, 'switch', '-q', 'ingest/wiki-1111111');
    refused(run(r, agent('CODEX_SANDBOX'), 'push', '-q', '.', 'ingest/wiki-1111111:main'), 'push . x:main (the receiving side)');
    refused(run(r, agent(), 'branch', '-f', 'main', wiki), 'branch -f');
    refused(run(r, agent(), 'fetch', '-q', '.', 'ingest/wiki-1111111:main'), 'fetch . x:main');
    refused(run(r, agent(), 'checkout', '-q', '-B', 'main', wiki), 'checkout -B');
    refused(run(r, agent(), 'branch', '-D', 'main'), 'branch -D (deleting main)');
  });

  it('reads the protected branch from the committed config, not only the working tree', () => {
    const r = hookedRepo();
    const wiki = branchWith(r, 'ingest/wiki-1111111', 'brain/wiki/new-page.md', '# new\n');
    fs.appendFileSync(path.join(r, 'brain.config.yaml'), '\nservice:\n  git:\n    main: trunk\n');
    const res = run(r, agent(), 'update-ref', 'refs/heads/main', wiki);
    assert.notEqual(res.status, 0, 'editing the working-tree config does not unprotect main');
  });

  it('lets a person through, and lets an agent move main when the wiki does not change', () => {
    const r = hookedRepo();
    const wiki = branchWith(r, 'ingest/wiki-1111111', 'brain/wiki/new-page.md', '# new\n');
    const code = branchWith(r, 'dev/notes', 'NOTES.txt');
    git(r, 'switch', '-q', '--detach');

    const agentCode = run(r, agent(), 'update-ref', 'refs/heads/main', code);
    assert.equal(agentCode.status, 0, agentCode.stderr);
    assert.equal(mainSha(r), code);

    const person = run(r, human(), 'update-ref', 'refs/heads/main', wiki);
    assert.equal(person.status, 0, person.stderr);
    assert.equal(mainSha(r), wiki, 'a human merging by hand is the gate, not something to block');

    const ingest = run(r, agent(), 'update-ref', 'refs/heads/ingest/wiki-1111111', code);
    assert.equal(ingest.status, 0, 'other branches are not its business');
  });

  it('accepts exactly the transition the service authorized, and only that one', () => {
    const r = hookedRepo();
    const wiki = branchWith(r, 'ingest/wiki-1111111', 'brain/wiki/new-page.md', '# new\n');
    const other = branchWith(r, 'ingest/wiki-2222222', 'brain/wiki/other.md', '# other\n');
    git(r, 'switch', '-q', '--detach');
    const before = mainSha(r);

    const release = authorizeMainMove(r, { ref: 'refs/heads/main', oldSha: before, newSha: wiki });
    assert.ok(fs.existsSync(mainMoveAuthPath(r)));
    assert.notEqual(run(r, agent(), 'update-ref', 'refs/heads/main', other).status, 0, 'a different target is not authorized');
    const ok = run(r, agent(), 'update-ref', 'refs/heads/main', wiki);
    assert.equal(ok.status, 0, ok.stderr);
    release();
    assert.equal(fs.existsSync(mainMoveAuthPath(r)), false, 'the authorization is one-shot');
    assert.notEqual(run(r, agent(), 'update-ref', 'refs/heads/main', other).status, 0);
  });

  it('carries the same agent-variable list as tools/lib/git-hooks.mjs', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'tools', 'hooks', 'reference-transaction'), 'utf-8');
    const listed = text.match(/^AGENT_VARS="([^"]+)"/m)[1].split(/\s+/);
    assert.deepEqual(listed, AGENT_ENV_VARS);
    assert.equal(isAgentEnv({ CLAUDECODE: '1' }), true);
    assert.equal(isAgentEnv({ CLAUDE_CODE_USE_BEDROCK: '1', CODEX_HOME: '/x' }), false, 'a person\'s own config variables are not markers');
  });
});

describe('the service merge path with the hook installed', () => {
  async function approveUnderAgentEnv(detach) {
    const r = hookedRepo();
    if (detach) git(r, 'checkout', '-q', '--detach');
    const prev = process.env.CLAUDECODE;
    process.env.CLAUDECODE = '1';   // the service was started from inside an agent session
    try {
      const app = await govApp(r);
      const branch = 'ingest/q3-board-deck-abcdef1';
      const b = await proposalBranch(app, branch, { 'brain/wiki/alpha.md': ALPHA_V2, 'brain/wiki/delta.md': DELTA });
      const p = await G(app).createFromJob(job(branch), { ...b, audit: CLEAN_AUDIT, runReport: { source: { id: 'alpha-pdf' }, outcome: 'written', pages: [] } });
      const out = await G(app).approve(p.id, ada);
      await app.stop();
      return { r, out };
    } finally {
      if (prev === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = prev;
    }
  }

  it('still merges an approved proposal by update-ref (main checked out nowhere)', async () => {
    const { r, out } = await approveUnderAgentEnv(true);
    assert.equal(out.status, 'merged', out.mergeError?.message);
    assert.equal(out.merge.method, 'update-ref');
    assert.equal(mainSha(r), out.merge.sha);
    assert.equal(fs.existsSync(mainMoveAuthPath(r)), false);
  });

  it('still merges an approved proposal by merge --ff-only in the checked-out main', async () => {
    const { r, out } = await approveUnderAgentEnv(false);
    assert.equal(out.status, 'merged', out.mergeError?.message);
    assert.equal(out.merge.method, 'ff-only');
    assert.equal(fs.readFileSync(path.join(r, 'brain/wiki/delta.md'), 'utf-8'), DELTA);
  });
});

describe('hooksInstalled', () => {
  it('reports an unset hooksPath, a wrong one, and a hook that is not executable', () => {
    const r = makeTempRepo();
    tmp.push(r);
    fs.cpSync(path.join(REPO_ROOT, 'tools', 'hooks'), path.join(r, 'tools', 'hooks'), { recursive: true });
    let h = hooksInstalled(r);
    assert.equal(h.ok, false);
    assert.match(h.problems.join('\n'), /core\.hooksPath is not set/);

    git(r, 'config', 'core.hooksPath', '.git/hooks');
    assert.match(hooksInstalled(r).problems.join('\n'), /not tools\/hooks/);

    git(r, 'config', 'core.hooksPath', 'tools/hooks');
    h = hooksInstalled(r);
    assert.equal(h.ok, false, 'relative: a push into this repo would run no hook');
    assert.match(h.problems.join('\n'), /relative/);

    git(r, 'config', 'core.hooksPath', path.join(fs.realpathSync(r), 'tools', 'hooks'));
    h = hooksInstalled(r);
    assert.equal(h.ok, true, h.problems.join('\n'));

    fs.chmodSync(path.join(r, 'tools', 'hooks', 'reference-transaction'), 0o644);
    h = hooksInstalled(r);
    assert.equal(h.ok, false);
    assert.match(h.problems.join('\n'), /reference-transaction is not executable/);
    fs.rmSync(path.join(r, 'tools', 'hooks', 'pre-commit'));
    assert.match(hooksInstalled(r).problems.join('\n'), /pre-commit is missing/);
  });

  it('is installed in this checkout\'s tools/hooks as executables', () => {
    for (const hook of ['pre-commit', 'reference-transaction']) {
      fs.accessSync(path.join(REPO_ROOT, 'tools', 'hooks', hook), fs.constants.X_OK);
    }
  });
});
