import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { enqueueFromHook, guardWikiDecision, statusLine } from '../../src/ingest/hooks.mjs';
import { git, makeTempRepo, REPO_ROOT, rmrf, SERVICE_ROOT } from '../helpers.mjs';
import { cleanup, setup } from './_setup.mjs';

const tmp = [];
after(async () => { await cleanup(); tmp.forEach(rmrf); });

const CLI = path.join(SERVICE_ROOT, 'bin', 'almagest.mjs');
const write = (file) => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: path.dirname(file), tool_input: { file_path: file, content: 'x' } });

function hook(name, input, { repo, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, 'hook', name, ...(repo ? ['--repo', repo] : [])], {
    input: JSON.stringify(input), encoding: 'utf-8', env: { ...process.env, ...env }, timeout: 20000,
  });
}

describe('hook guard-wiki', () => {
  it('blocks a write under brain/wiki/ on main', () => {
    const repo = makeTempRepo();
    tmp.push(repo);
    const d = guardWikiDecision(write(path.join(repo, 'brain', 'wiki', 'new-page.md')));
    assert.equal(d.block, true);
    assert.match(d.reason, /brain\/wiki\/new-page\.md is in the wiki and this checkout is on `main`/);

    // A relative path resolves against the hook's cwd.
    assert.equal(guardWikiDecision({ cwd: repo, tool_input: { file_path: 'brain/wiki/alpha.md' } }).block, true);
    // MultiEdit and Edit carry the same file_path.
    assert.equal(guardWikiDecision({ cwd: repo, tool_name: 'MultiEdit', tool_input: { file_path: path.join(repo, 'brain/wiki/sub/deep.md'), edits: [] } }).block, true);
  });

  it('allows the same write on an ingest branch (worktree), and outside brain/wiki/', () => {
    const repo = makeTempRepo();
    tmp.push(repo);
    const wt = path.join(repo, '.almagest', 'worktrees', 'ingest__x');
    git(repo, 'worktree', 'add', '-q', '-b', 'ingest/x-1234567', wt);
    assert.equal(guardWikiDecision(write(path.join(wt, 'brain', 'wiki', 'new-page.md'))).block, false);
    assert.equal(guardWikiDecision(write(path.join(repo, 'brain', 'raw', 'drop.md'))).block, false);
    assert.equal(guardWikiDecision(write(path.join(repo, 'brain', 'index.md'))).block, false);
    assert.equal(guardWikiDecision(write(path.join(repo, 'brain', 'wiki'))).block, false, 'the directory itself is not a page');

    git(repo, 'switch', '-q', '-c', 'ingest/manual-7654321');
    assert.equal(guardWikiDecision(write(path.join(repo, 'brain', 'wiki', 'new-page.md'))).block, false);
  });

  it('blocks writes into .git/ on any branch, in the repo and in any other git dir', () => {
    const repo = makeTempRepo();
    tmp.push(repo);
    git(repo, 'switch', '-q', '-c', 'ingest/x-1234567');
    for (const rel of ['.git/refs/heads/main', '.git/packed-refs', '.git/config', '.git/hooks/reference-transaction', '.git/almagest/main-move']) {
      const d = guardWikiDecision(write(path.join(repo, rel)));
      assert.equal(d.block, true, rel);
      assert.match(d.reason, /inside a git directory/);
    }
    assert.equal(guardWikiDecision({ cwd: repo, tool_name: 'Edit', tool_input: { file_path: '.git/HEAD' } }).block, true);
    // A separate git dir (`git init --separate-git-dir`, or a worktree's own) is found through git, not by name.
    const sep = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-sepgit-'));
    tmp.push(sep);
    git(sep, 'init', '-q', '--separate-git-dir', path.join(sep, 'gitdir'), path.join(sep, 'work'));
    assert.equal(guardWikiDecision(write(path.join(sep, 'gitdir', 'refs', 'heads', 'main'))).block, true);
    assert.equal(guardWikiDecision(write(path.join(sep, 'work', 'notes.md'))).block, false);
    // Names that only look similar are not git dirs.
    assert.equal(guardWikiDecision(write(path.join(repo, '.gitignore'))).block, false);
    assert.equal(guardWikiDecision(write(path.join(repo, 'docs', 'x.git', 'a.md'))).block, false);
  });

  it('fails open on everything except the cases it guards', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-nogit-'));
    tmp.push(outside);
    assert.equal(guardWikiDecision(write(path.join(outside, 'brain', 'wiki', 'x.md'))).block, false);
    assert.equal(guardWikiDecision({}).block, false);
    assert.equal(guardWikiDecision({ tool_input: {} }).block, false);
  });

  it('exits 2 with the reason on stderr through the CLI, 0 otherwise', () => {
    const repo = makeTempRepo();
    tmp.push(repo);
    const blocked = hook('guard-wiki', write(path.join(repo, 'brain', 'wiki', 'x.md')));
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, /Almagest: blocked/);
    assert.equal(hook('guard-wiki', write(path.join(repo, 'brain', 'raw', 'x.md'))).status, 0);
    const garbage = spawnSync(process.execPath, [CLI, 'hook', 'guard-wiki'], { input: 'not json', encoding: 'utf-8' });
    assert.equal(garbage.status, 0);
    assert.equal(spawnSync(process.execPath, [CLI, 'hook', 'nope'], { input: '{}', encoding: 'utf-8' }).status, 1, 'a typo must not block edits');
  });
});

describe('hook enqueue', () => {
  it('spools when the service is unreachable, and the service drains the spool', async () => {
    const t = await setup();
    const file = t.write('brain/raw/hooked.md', 'written by a session\n');
    const prev = process.env.ALMAGEST_URL;
    process.env.ALMAGEST_URL = 'http://127.0.0.1:9';   // discard port: nothing listens
    try {
      const r = await enqueueFromHook({ tool_input: { file_path: file } }, { repoRoot: t.repo, timeoutMs: 500 });
      assert.equal(r.action, 'spooled');
      assert.ok(fs.existsSync(r.file));
      assert.equal(JSON.parse(fs.readFileSync(r.file, 'utf-8')).path, 'brain/raw/hooked.md');
    } finally {
      if (prev === undefined) delete process.env.ALMAGEST_URL; else process.env.ALMAGEST_URL = prev;
    }
    await t.ctx.ingest.start({ workers: false });
    const [job] = await t.ctx.ingest.list();
    assert.equal(job.trigger, 'hook');
    assert.equal(job.source.id, 'hooked-md');
    await t.stop();
  });

  it('ignores files outside the drop folder, processed/extracted, and the runner\'s own writes', async () => {
    const repo = makeTempRepo();
    tmp.push(repo);
    const ignore = (p) => enqueueFromHook({ tool_input: { file_path: path.join(repo, p) } }, { repoRoot: repo, timeoutMs: 200 });
    assert.equal((await ignore('brain/wiki/alpha.md')).action, 'ignored');
    assert.equal((await ignore('brain/raw/processed/a.md')).action, 'ignored');
    assert.equal((await ignore('brain/raw/extracted/a.pdf.txt')).action, 'ignored');
    assert.equal((await ignore('.almagest/worktrees/x/brain/raw/a.md')).action, 'ignored');
    process.env.ALMAGEST_RUNNER = '1';
    try { assert.equal((await ignore('brain/raw/a.md')).action, 'ignored'); }
    finally { delete process.env.ALMAGEST_RUNNER; }
    assert.equal(fs.existsSync(path.join(repo, '.almagest', 'spool')), false);
  });

  it('POSTs to a running service with ALMAGEST_TOKEN', async () => {
    process.env.ALMAGEST_TOKENS = 'ada:owner:tok';
    const t = await setup({ http: true });
    const server = await t.app.start();
    const env = { ALMAGEST_URL: `http://127.0.0.1:${server.address().port}`, ALMAGEST_TOKEN: 'tok' };
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const file = t.write('brain/raw/posted.md', 'posted by a hook\n');
      const r = await enqueueFromHook({ tool_input: { file_path: file } }, { repoRoot: t.repo });
      assert.equal(r.action, 'posted');
      const job = await t.ctx.ingest.get(r.job);
      assert.equal(job.trigger, 'hook');
      assert.equal(job.requestedBy, 'usr_ada');
    } finally {
      for (const k of ['ALMAGEST_URL', 'ALMAGEST_TOKEN', 'ALMAGEST_TOKENS']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      await t.stop();
    }
  });
});

describe('hook status', () => {
  it('prints nothing when the service is down, a count line when it is up', async () => {
    const prev = process.env.ALMAGEST_URL;
    process.env.ALMAGEST_URL = 'http://127.0.0.1:9';
    const repo = makeTempRepo();
    tmp.push(repo);
    assert.equal(await statusLine({ repoRoot: repo, timeoutMs: 300 }), '');
    const viaCli = hook('status', { hook_event_name: 'SessionStart' }, { repo, env: { ALMAGEST_URL: 'http://127.0.0.1:9' } });
    assert.equal(viaCli.status, 0);
    assert.equal(viaCli.stdout, '');

    const t = await setup({ http: true });
    t.ctx.http.route('GET', '/api/proposals', async () => [{ id: 'prp_1' }, { id: 'prp_2' }]);
    t.ctx.http.route('GET', '/api/decisions', async () => ({ items: [{ id: 'dec_1' }] }));
    const server = await t.app.start();
    process.env.ALMAGEST_URL = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal(await statusLine({ repoRoot: t.repo }), `Almagest: 2 open proposals, 1 open decision awaiting review — ${process.env.ALMAGEST_URL}/inbox`);
    } finally {
      if (prev === undefined) delete process.env.ALMAGEST_URL; else process.env.ALMAGEST_URL = prev;
      await t.stop();
    }
  });
});

describe('tools/hooks/pre-commit', () => {
  it('blocks wiki commits on main and audit failures in the STAGED tree; allows the rest', () => {
    const repo = makeTempRepo();
    tmp.push(repo);
    fs.cpSync(path.join(REPO_ROOT, 'tools'), path.join(repo, 'tools'), { recursive: true, filter: (p) => !p.includes('__fixtures__') });
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(repo, 'node_modules'));
    fs.appendFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'tools');
    git(repo, 'config', 'core.hooksPath', 'tools/hooks');
    const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t', NO_COLOR: '1' };
    const commit = (msg) => spawnSync('git', ['commit', '-qm', msg], { cwd: repo, env, encoding: 'utf-8' });
    const alpha = path.join(repo, 'brain', 'wiki', 'alpha.md');

    fs.appendFileSync(alpha, '\nMore. [source: alpha-pdf, p.3]\n');
    git(repo, 'add', '-A');
    const onMain = commit('wiki on main');
    assert.equal(onMain.status, 1);
    assert.match(onMain.stderr, /refusing to commit to main/);

    git(repo, 'switch', '-q', '-c', 'ingest/x-1234567');
    assert.equal(commit('clean').status, 0);

    fs.appendFileSync(alpha, '\nBad. [source: nope, p.3]\n');
    git(repo, 'add', '-A');
    fs.writeFileSync(alpha, fs.readFileSync(alpha, 'utf-8').replace('[source: nope, p.3]', '[source: alpha-pdf, p.3]'));
    const staged = commit('staged mistake, unstaged fix');
    assert.equal(staged.status, 1, 'the staged tree is what gets audited');
    assert.match(staged.stderr, /audit\.mjs found errors/);
    git(repo, 'add', '-A');
    assert.equal(commit('fixed').status, 0);

    git(repo, 'switch', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'NOTES.txt'), 'not the brain\n');
    git(repo, 'add', 'NOTES.txt');
    assert.equal(commit('code only').status, 0);
  });
});
