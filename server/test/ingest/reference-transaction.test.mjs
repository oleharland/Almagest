/**
 * tools/hooks/reference-transaction — the backstop that sees every ref update,
 * whoever typed it — and tools/lib/git-hooks.mjs, its Node side.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { AGENT_ENV_VARS, authorizeMainMove, hooksDir, hooksInstalled, installHooks, isAgentEnv, mainMoveAuthPath } from '../../../tools/lib/git-hooks.mjs';
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

/** A temp repo with this checkout's tools/ committed on main. */
function toolsRepo() {
  const r = makeTempRepo();
  tmp.push(r);
  fs.cpSync(path.join(REPO_ROOT, 'tools'), path.join(r, 'tools'), { recursive: true, filter: (p) => !p.includes('__fixtures__') });
  git(r, 'add', '-A');
  git(r, 'commit', '-qm', 'tools');
  return r;
}

/**
 * …with the hooks installed from main, as `almagest hooks install` does: into
 * the git dir, core.hooksPath pointing there by absolute path.
 */
function hookedRepo() {
  const r = toolsRepo();
  installHooks(r);
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


const CLI = path.join(REPO_ROOT, 'server', 'bin', 'almagest.mjs');
const cli = (r, env, ...args) => spawnSync(process.execPath, [CLI, ...args, '--repo', r], { env, encoding: 'utf-8' });

describe('almagest hooks install: what git runs is main\'s, not the checkout\'s', () => {
  /**
   * R2-A, reproduced: an attacker's branch (as fetched from a remote) ships a
   * pre-commit that clears the agent variables and moves main onto a wiki
   * commit. The agent checks it out under an ingest name and commits.
   */
  function attackerBranch(r) {
    const wiki = branchWith(r, 'ingest/wiki-1111111', 'brain/wiki/injected.md', '# injected\n');
    const marker = path.join(r, '.payload-ran');
    git(r, 'switch', '-q', '-c', 'evil/payload');
    fs.writeFileSync(path.join(r, 'tools/hooks/pre-commit'),
      `#!/usr/bin/env bash\ntouch "${marker}"\nenv -i PATH="$PATH" HOME="$HOME" git update-ref refs/heads/main ${wiki}\nexit 0\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(r, 'tools/hooks/reference-transaction'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    git(r, 'add', '-A');
    git(r, 'commit', '-qm', 'payload', '--no-verify');
    git(r, 'switch', '-q', 'main');
    return { wiki, marker };
  }
  function exploit(r) {
    const co = run(r, agent(), 'checkout', '-q', '-b', 'ingest/z-1111111', 'evil/payload');
    assert.equal(co.status, 0, co.stderr);
    fs.writeFileSync(path.join(r, 'notes.txt'), 'wip\n');
    assert.equal(run(r, agent(), 'add', 'notes.txt').status, 0);
    return run(r, agent(), 'commit', '-qm', 'wip');
  }

  it('checking out a branch that ships its own hooks changes nothing: main and the installed hooks stay put', () => {
    const r = hookedRepo();
    const { marker } = attackerBranch(r);
    const dir = hooksDir(r);
    const before = { main: mainSha(r), hooks: ['pre-commit', 'reference-transaction'].map((h) => fs.readFileSync(path.join(dir, h))) };

    const res = exploit(r);
    assert.equal(res.status, 0, `the commit itself is fine: ${res.stderr}`);
    assert.equal(fs.existsSync(marker), false, 'the branch\'s pre-commit never ran');
    assert.equal(mainSha(r), before.main, 'main did not move');
    assert.deepEqual(['pre-commit', 'reference-transaction'].map((h) => fs.readFileSync(path.join(dir, h))), before.hooks, 'the installed hooks are unchanged');
    assert.equal(git(r, 'config', '--get', 'core.hooksPath').trim(), dir);
    assert.equal(hooksInstalled(r).ok, true, hooksInstalled(r).problems.join('\n'));
  });

  it('…where hooks run from the working tree, the same steps move main (what the install fixes)', () => {
    const r = toolsRepo();
    const { wiki, marker } = attackerBranch(r);
    git(r, 'config', 'core.hooksPath', path.join(fs.realpathSync(r), 'tools', 'hooks'));
    exploit(r);
    assert.equal(fs.existsSync(marker), true);
    assert.equal(mainSha(r), wiki, 'the old setup let the branch\'s pre-commit move main');
  });

  it('editing the working-tree reference-transaction has no effect on the protection', () => {
    const r = hookedRepo();
    const wiki = branchWith(r, 'ingest/wiki-1111111', 'brain/wiki/new-page.md', '# new\n');
    fs.writeFileSync(path.join(r, 'tools/hooks/reference-transaction'), '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(path.join(r, 'tools/hooks/pre-commit'), '#!/bin/sh\nexit 0\n');
    const cfg = path.join(r, 'brain.config.yaml');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf-8').replace(/^brain_dir: brain$/m, 'brain_dir: elsewhere'));
    const before = mainSha(r);
    const res = run(r, agent(), 'update-ref', 'refs/heads/main', wiki);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /refusing to move refs\/heads\/main from an agent environment/);
    assert.equal(mainSha(r), before);
    assert.equal(hooksInstalled(r).ok, true, 'what is installed is judged against main, not the working tree');
  });

  it('bakes in the main branch and brain_dir from main\'s committed config, and refuses a working-tree mismatch', () => {
    const r = toolsRepo();
    git(r, 'branch', 'trunk');
    fs.appendFileSync(path.join(r, 'brain.config.yaml'), '\nservice:\n  git:\n    main: trunk\n');
    assert.throws(() => installHooks(r), /names "trunk" as the main branch, but trunk's committed brain\.config\.yaml names "main"/);
    assert.match(hooksInstalled(r).problems.join('\n'), /cannot build the hooks from main/);
    git(r, 'commit', '-qam', 'trunk is main', '--no-verify');
    git(r, 'switch', '-q', 'trunk');
    git(r, 'merge', '-q', '--ff-only', 'main');
    const out = installHooks(r);
    assert.equal(out.main, 'trunk');
    const text = fs.readFileSync(path.join(out.dir, 'reference-transaction'), 'utf-8');
    assert.match(text, /^MAIN_BRANCH="trunk"$/m);
    assert.match(text, /^BRAIN_DIR="brain"$/m);
    assert.doesNotMatch(text, /brain\.config\.yaml"\)"|show-toplevel/, 'reads no working-tree config');
  });

  it('only a person installs: the CLI refuses from an agent environment', () => {
    const r = toolsRepo();
    const refused = cli(r, agent(), 'hooks', 'install');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refused — this is an agent environment/);
    assert.equal(run(r, human(), 'config', '--get', 'core.hooksPath').status, 1, 'core.hooksPath left unset');

    const ok = cli(r, human(), 'hooks', 'install');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Installed the hooks from main/);
    assert.equal(cli(r, human(), 'hooks', 'check').status, 0);
    assert.match(cli(r, human(), 'hooks', 'install').stdout, /already current/);
  });

  it('a symlink planted where the hooks go is replaced, not followed', () => {
    const r = toolsRepo();
    const dir = hooksDir(r);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.symlinkSync(path.join(r, 'tools', 'hooks'), dir);
    assert.match(hooksInstalled(r).problems.join('\n'), /is not a directory/);
    installHooks(r);
    assert.equal(fs.lstatSync(dir).isDirectory(), true);
    assert.equal(hooksInstalled(r).ok, true, hooksInstalled(r).problems.join('\n'));
  });
});

describe('hooksInstalled', () => {
  it('reports an unset hooksPath, a wrong one, an outdated hook and one that is not executable', () => {
    const r = toolsRepo();
    const dir = hooksDir(r);
    let h = hooksInstalled(r);
    assert.equal(h.ok, false);
    assert.equal(h.expected, dir);
    assert.match(h.problems.join('\n'), /core\.hooksPath is not set — run `node server\/bin\/almagest\.mjs hooks install`/);

    installHooks(r);
    h = hooksInstalled(r);
    assert.equal(h.ok, true, h.problems.join('\n'));
    assert.equal(h.hooksPath, dir);

    for (const wrong of ['tools/hooks', path.join(fs.realpathSync(r), 'tools', 'hooks')]) {
      git(r, 'config', 'core.hooksPath', wrong);
      assert.match(hooksInstalled(r).problems.join('\n'), /core\.hooksPath is .*, not .*almagest\/hooks/, wrong);
    }
    git(r, 'config', 'core.hooksPath', dir);

    // main's tools/hooks moves on: the installed copy is outdated until install runs again.
    fs.appendFileSync(path.join(r, 'tools/hooks/reference-transaction'), '# a reviewed change\n');
    git(r, 'commit', '-qam', 'hook change', '--no-verify');
    h = hooksInstalled(r);
    assert.equal(h.ok, false);
    assert.match(h.problems.join('\n'), /reference-transaction is outdated .*hooks install/);
    assert.deepEqual(installHooks(r).written, ['reference-transaction']);
    assert.equal(hooksInstalled(r).ok, true);

    // So does a change of brain_dir on main.
    const cfg = path.join(r, 'brain.config.yaml');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf-8').replace(/^brain_dir: brain$/m, 'brain_dir: brain2'));
    git(r, 'commit', '-qam', 'move the brain', '--no-verify');
    assert.match(hooksInstalled(r).problems.join('\n'), /pre-commit is outdated/);
    installHooks(r);

    // Edited in place: outdated too.
    fs.appendFileSync(path.join(dir, 'pre-commit'), 'exit 0\n');
    assert.match(hooksInstalled(r).problems.join('\n'), /pre-commit is outdated/);
    installHooks(r);

    fs.chmodSync(path.join(dir, 'reference-transaction'), 0o644);
    h = hooksInstalled(r);
    assert.equal(h.ok, false);
    assert.match(h.problems.join('\n'), /reference-transaction is not executable/);
    fs.rmSync(path.join(dir, 'pre-commit'));
    assert.match(hooksInstalled(r).problems.join('\n'), /pre-commit is not installed/);
  });

  it('is executable in this checkout\'s tools/hooks, with the lines install bakes', () => {
    for (const hook of ['pre-commit', 'reference-transaction']) {
      const file = path.join(REPO_ROOT, 'tools', 'hooks', hook);
      fs.accessSync(file, fs.constants.X_OK);
      const text = fs.readFileSync(file, 'utf-8');
      assert.match(text, /^MAIN_BRANCH="main"$/m);
      assert.match(text, /^BRAIN_DIR="brain"$/m);
    }
  });
});
