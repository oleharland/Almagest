import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { guardGitDecision, splitCommands } from '../../src/ingest/guard-git.mjs';
import { git, makeTempRepo, rmrf, SERVICE_ROOT } from '../helpers.mjs';

const tmp = [];
after(() => tmp.forEach(rmrf));

function repo() {
  const r = makeTempRepo();
  tmp.push(r);
  return r;
}
const bash = (cwd, command) => guardGitDecision({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } });
const blocks = (cwd, command) => bash(cwd, command).block;

/** A branch with one commit touching `file`. */
function branchWith(r, branch, file, content) {
  git(r, 'switch', '-q', '-c', branch);
  fs.mkdirSync(path.dirname(path.join(r, file)), { recursive: true });
  fs.writeFileSync(path.join(r, file), content);
  git(r, 'add', '-A');
  git(r, 'commit', '-qm', `touch ${file}`);
  const sha = git(r, 'rev-parse', 'HEAD').trim();
  git(r, 'switch', '-q', 'main');
  return sha;
}

describe('guard-git: shell reading', () => {
  it('splits commands and keeps quoted words together', () => {
    assert.deepEqual(splitCommands(`cd "my dir" && git commit -m 'a b; c' || echo x > out.txt`), [
      ['cd', 'my dir'], ['git', 'commit', '-m', 'a b; c'], ['echo', 'x', '>', 'out.txt'],
    ]);
    assert.equal(splitCommands('git commit -m "unbalanced'), null);
    assert.equal(splitCommands('cat <<EOF\nx\nEOF'), null);
  });
});

describe('guard-git: commits on main', () => {
  it('blocks a commit whose staged changes touch brain/wiki/', () => {
    const r = repo();
    fs.appendFileSync(path.join(r, 'brain/wiki/alpha.md'), '\nx\n');
    git(r, 'add', 'brain/wiki/alpha.md');
    const d = bash(r, 'git commit -m "update alpha"');
    assert.equal(d.block, true);
    assert.match(d.reason, /git commit` on `main` would bring brain\/wiki\/alpha\.md into the wiki/);
  });

  it('sees -a, pathspecs, and unstaged wiki changes they would sweep in', () => {
    const r = repo();
    fs.appendFileSync(path.join(r, 'brain/wiki/alpha.md'), '\nx\n');
    fs.writeFileSync(path.join(r, 'brain/raw/note.md'), 'n\n');
    git(r, 'add', 'brain/raw/note.md');
    assert.equal(blocks(r, 'git commit -m "raw only"'), false, 'staged changes are raw only');
    assert.equal(blocks(r, 'git commit -am "everything"'), true);
    assert.equal(blocks(r, 'git commit --all -m x'), true);
    assert.equal(blocks(r, 'git commit -m x -- brain/wiki/alpha.md'), true);
    assert.equal(blocks(r, 'git commit -m x brain/wiki/alpha.md'), true);
  });

  it('allows the same commit on an ingest branch', () => {
    const r = repo();
    git(r, 'switch', '-q', '-c', 'ingest/x-1234567');
    fs.appendFileSync(path.join(r, 'brain/wiki/alpha.md'), '\nx\n');
    git(r, 'add', '-A');
    assert.equal(blocks(r, 'git commit -m x'), false);
    assert.equal(blocks(r, 'git status && git diff --cached'), false);
  });
});

describe('guard-git: skipping hooks', () => {
  it('blocks --no-verify, -n and core.hooksPath overrides on any branch', () => {
    const r = repo();
    git(r, 'switch', '-q', '-c', 'ingest/x-1234567');
    for (const cmd of ['git commit --no-verify -m x', 'git commit -m x --no-verify', 'git commit -nm x', 'git commit -an -m x',
      'git -c core.hooksPath=/dev/null commit -m x', 'git push --no-verify origin ingest/x-1234567', 'git merge --no-verify main']) {
      assert.equal(blocks(r, cmd), true, cmd);
    }
    assert.equal(blocks(r, 'git -c core.hooksPath=/dev/null status'), false, 'a read-only command runs no hooks');
    assert.equal(blocks(r, 'git commit -m "no-verify in a message"'), false);
    assert.equal(blocks(r, 'git push -n origin x'), false, 'push -n is --dry-run');
  });
});

describe('guard-git: merges, picks, patches, stashes on main', () => {
  it('blocks a merge that brings wiki changes into main, and follows switch / cd', () => {
    const r = repo();
    branchWith(r, 'ingest/wiki-1111111', 'brain/wiki/new-page.md', '# new\n');
    branchWith(r, 'ingest/raw-2222222', 'brain/raw/processed/a.md', 'a\n');
    assert.equal(blocks(r, 'git merge ingest/wiki-1111111'), true);
    assert.equal(blocks(r, 'git merge --ff-only ingest/wiki-1111111'), true);
    assert.equal(blocks(r, 'git merge ingest/raw-2222222'), false, 'no wiki paths');
    assert.equal(blocks(r, 'git merge --abort'), false);

    git(r, 'switch', '-q', 'ingest/raw-2222222');
    assert.equal(blocks(r, 'git merge ingest/wiki-1111111'), false, 'merging into an ingest branch is fine');
    assert.equal(blocks(r, 'git switch main && git merge ingest/wiki-1111111'), true, 'judged on the branch it will be on');
    assert.equal(blocks(r, 'git checkout main; git merge ingest/wiki-1111111'), true);
    git(r, 'switch', '-q', 'main');

    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-cwd-'));
    tmp.push(elsewhere);
    assert.equal(blocks(elsewhere, `cd ${r} && git merge ingest/wiki-1111111`), true);
    assert.equal(blocks(elsewhere, `git -C ${r} merge ingest/wiki-1111111`), true);
  });

  it('blocks cherry-pick / revert of a wiki commit, am of a wiki patch, stash pop of wiki changes', () => {
    const r = repo();
    const sha = branchWith(r, 'ingest/wiki-1111111', 'brain/wiki/new-page.md', '# new\n');
    assert.equal(blocks(r, `git cherry-pick ${sha}`), true);
    assert.equal(blocks(r, `git cherry-pick main..ingest/wiki-1111111`), true);

    const patch = path.join(r, 'wiki.patch');
    fs.writeFileSync(patch, git(r, 'format-patch', '-1', '--stdout', sha));
    assert.equal(blocks(r, 'git am wiki.patch'), true);

    fs.appendFileSync(path.join(r, 'brain/wiki/alpha.md'), '\nstashed\n');
    git(r, 'stash', 'push', '-q', '-m', 'wiki work');
    assert.equal(blocks(r, 'git stash pop'), true);
    assert.equal(blocks(r, 'git stash apply stash@{0}'), true);
    assert.equal(blocks(r, 'git stash list'), false);
  });
});

describe('guard-git: plain writers into the wiki on main', () => {
  it('blocks redirects, cp/mv/tee/sed -i into brain/wiki/ on main; allows them elsewhere', () => {
    const r = repo();
    for (const cmd of ['echo hi > brain/wiki/x.md', 'cat a >> brain/wiki/alpha.md', 'cp /tmp/draft.md brain/wiki/draft.md',
      'mv draft.md brain/wiki/', 'tee brain/wiki/x.md', 'sed -i "" s/a/b/ brain/wiki/alpha.md', 'rm brain/wiki/beta.md']) {
      assert.equal(blocks(r, cmd), true, cmd);
    }
    assert.equal(blocks(r, 'cp brain/wiki/alpha.md /tmp/copy.md'), false, 'reading from the wiki is fine');
    assert.equal(blocks(r, 'echo hi > brain/raw/note.md'), false);
    git(r, 'switch', '-q', '-c', 'ingest/x-1234567');
    assert.equal(blocks(r, 'echo hi > brain/wiki/x.md'), false);
  });
});

describe('guard-git: fails open', () => {
  it('allows what it cannot follow, and non-repos', () => {
    const r = repo();
    fs.appendFileSync(path.join(r, 'brain/wiki/alpha.md'), '\nx\n');
    git(r, 'add', '-A');
    assert.equal(blocks(r, 'bash -c "git commit -m x"'), false, 'a nested shell is not followed — pre-commit is the backstop');
    assert.equal(blocks(r, 'git commit -m "unbalanced'), false);
    assert.equal(blocks(os.tmpdir(), 'git commit -m x'), false);
    assert.equal(guardGitDecision({}).block, false);
  });

  it('exits 2 through the CLI with the reason on stderr', () => {
    const r = repo();
    fs.appendFileSync(path.join(r, 'brain/wiki/alpha.md'), '\nx\n');
    git(r, 'add', '-A');
    const res = spawnSync(process.execPath, [path.join(SERVICE_ROOT, 'bin', 'almagest.mjs'), 'hook', 'guard-git'], {
      input: JSON.stringify({ tool_name: 'Bash', cwd: r, tool_input: { command: 'git commit -m x' } }), encoding: 'utf-8',
    });
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /non-negotiable 1/);
  });
});

describe('.claude/settings.json (finding 5a)', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(SERVICE_ROOT, '..', '.claude', 'settings.json'), 'utf-8'));
  it('does not pre-approve arbitrary node or git push, and denies hook-skipping commands', () => {
    const { allow, deny } = settings.permissions;
    assert.ok(!allow.includes('Bash(node:*)'));
    assert.ok(!allow.some((a) => a.startsWith('Bash(git push')));
    for (const d of ['Bash(git commit --no-verify:*)', 'Bash(git commit -n:*)', 'Bash(git push --no-verify:*)', 'Bash(git update-ref:*)']) assert.ok(deny.includes(d), d);
    assert.ok(allow.includes('Bash(node tools/audit.mjs:*)'));
  });
  it('wires guard-git on Bash and guard-wiki on file edits', () => {
    const pre = settings.hooks.PreToolUse;
    assert.ok(pre.some((h) => h.matcher === 'Bash' && h.hooks.some((x) => x.command.endsWith('hook guard-git'))));
    assert.ok(pre.some((h) => h.matcher === 'Write|Edit|MultiEdit' && h.hooks.some((x) => x.command.endsWith('hook guard-wiki'))));
  });
});
