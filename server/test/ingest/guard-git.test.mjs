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

describe('guard-git: moving main without a commit (any branch)', () => {
  it('blocks every form that resets, renames, deletes or overwrites refs/heads/main', () => {
    const r = repo();
    branchWith(r, 'ingest/wiki-1111111', 'brain/wiki/new-page.md', '# new\n');
    git(r, 'switch', '-q', 'ingest/wiki-1111111');
    for (const cmd of [
      'git checkout -B main ingest/wiki-1111111', 'git switch -C main ingest/wiki-1111111', 'git switch --force-create main HEAD',
      'git branch -f main ingest/wiki-1111111', 'git branch --force main HEAD', 'git branch -M ingest/wiki-1111111 main',
      'git branch -M main', 'git branch -C ingest/wiki-1111111 main', 'git branch -D main', 'git branch -m main old-main',
      'git update-ref refs/heads/main HEAD', 'git update-ref -m x heads/main HEAD', 'git update-ref -d refs/heads/main',
      'git update-ref --stdin', 'git symbolic-ref refs/heads/main refs/heads/ingest/wiki-1111111',
      'git worktree add -B main ../elsewhere HEAD',
      'git fetch . ingest/wiki-1111111:main', 'git fetch . +HEAD:refs/heads/main', 'git fetch origin "refs/heads/*:refs/heads/*"',
      'git pull . ingest/wiki-1111111:main',
      'git push . ingest/wiki-1111111:main', 'git push . HEAD:refs/heads/main', `git push ${r} HEAD:main`, 'git push . --delete main',
      'git push . :main', 'git push --mirror .',
      'git rebase ingest/wiki-1111111 main', 'git filter-branch -- --all',
    ]) {
      const d = bash(r, cmd);
      assert.equal(d.block, true, cmd);
      assert.match(d.reason, /Almagest: blocked/, cmd);
    }
  });

  it('follows a remote whose URL is a local path, and leaves real remotes alone', () => {
    const r = repo();
    git(r, 'remote', 'add', 'self', '.');
    git(r, 'remote', 'add', 'origin', 'git@github.com:acme/brain.git');
    git(r, 'switch', '-q', '-c', 'ingest/x-1234567');
    assert.equal(blocks(r, 'git push self HEAD:main'), true);
    assert.equal(blocks(r, 'git push origin HEAD:main'), false, "the remote's main is protected by the remote");
    assert.equal(blocks(r, 'git push origin ingest/x-1234567'), false);
  });

  it('blocks reset <commit>, rebase, commit --amend and pull while on main', () => {
    const r = repo();
    fs.writeFileSync(path.join(r, 'NOTES.txt'), 'n\n');
    git(r, 'add', 'NOTES.txt');
    git(r, 'commit', '-qm', 'notes');
    for (const cmd of ['git reset --soft HEAD~1', 'git reset HEAD~1', 'git reset --mixed HEAD~1', 'git reset --keep HEAD~1',
      'git rebase -i HEAD~1', 'git rebase ingest/x', 'git commit --amend -m x', 'git commit --amend --no-edit', 'git pull', 'git pull --rebase origin main']) {
      assert.equal(blocks(r, cmd), true, cmd);
    }
    // These do not move main.
    for (const cmd of ['git reset', 'git reset HEAD', 'git reset -- NOTES.txt', 'git reset NOTES.txt', 'git reset HEAD~1 -- NOTES.txt',
      'git reset -p', 'git rebase --abort', 'git pull --dry-run']) {
      assert.equal(blocks(r, cmd), false, cmd);
    }
    // The same commands on an ingest branch are that branch's business.
    git(r, 'switch', '-q', '-c', 'ingest/x-1234567');
    for (const cmd of ['git reset --soft HEAD~1', 'git rebase main', 'git commit --amend -m x', 'git pull origin main']) {
      assert.equal(blocks(r, cmd), false, cmd);
    }
    assert.equal(blocks(r, 'git switch main && git reset --soft HEAD~1'), true, 'judged on the branch it will be on');
  });

  it('blocks finishing a rebase of main from the detached HEAD it leaves', () => {
    const r = repo();
    const gitDir = path.join(r, '.git');
    git(r, 'checkout', '-q', '--detach');
    fs.mkdirSync(path.join(gitDir, 'rebase-merge'));
    fs.writeFileSync(path.join(gitDir, 'rebase-merge', 'head-name'), 'refs/heads/main\n');
    assert.equal(blocks(r, 'git rebase --continue'), true);
    fs.writeFileSync(path.join(gitDir, 'rebase-merge', 'head-name'), 'refs/heads/ingest/x\n');
    assert.equal(blocks(r, 'git rebase --continue'), false);
  });

  it('keeps the everyday forms allowed, so the guard stays installed', () => {
    const r = repo();
    branchWith(r, 'ingest/x-1234567', 'brain/raw/a.md', 'a\n');
    for (const cmd of ['git switch -c ingest/new-7654321', 'git checkout -b ingest/new-7654321', 'git checkout -B ingest/x-1234567 main',
      'git branch --list', 'git branch --show-current', 'git branch', 'git branch -a', 'git branch -vv', 'git branch --contains main',
      'git branch ingest/y-1111111 main', 'git branch -d ingest/x-1234567', 'git branch -D ingest/x-1234567', 'git branch -f ingest/x-1234567 main',
      'git checkout ingest/x-1234567', 'git switch main', 'git update-ref refs/heads/ingest/x-1234567 HEAD',
      'git fetch origin', 'git fetch origin main', 'git fetch origin main:refs/remotes/origin/main', 'git log refs/heads/main',
      'git show-ref refs/heads/main', 'git rev-parse refs/heads/main', 'cat .git/packed-refs', 'ls .git/refs/heads',
      'grep main .git/packed-refs', 'git -c core.hooksPath=/dev/null status', 'git config --get core.hooksPath', 'env | grep CLAUDE']) {
      assert.equal(blocks(r, cmd), false, cmd);
    }
    git(r, 'switch', '-q', 'ingest/x-1234567');
    assert.equal(blocks(r, 'git rebase main'), false);
    assert.equal(blocks(r, 'git checkout ingest/x-1234567 && git merge main'), false);
  });
});

describe('guard-git: .git/, hooks config, agent environment', () => {
  it('blocks writes inside .git/ on any branch', () => {
    const r = repo();
    git(r, 'switch', '-q', '-c', 'ingest/x-1234567');
    for (const cmd of ['echo abc > .git/refs/heads/main', 'cp /tmp/sha .git/refs/heads/main', 'mv x .git/packed-refs',
      'tee .git/HEAD', 'ln -sf ../x .git/refs/heads/main', 'sed -i "" s/a/b/ .git/packed-refs', 'printf x >> .git/config',
      'cd .git && echo x > refs/heads/main', 'git show HEAD:x > .git/refs/heads/main', 'rm .git/refs/heads/main',
      'cp evil .git/hooks/reference-transaction']) {
      assert.equal(blocks(r, cmd), true, cmd);
    }
    assert.equal(blocks(r, 'rm -f .git/index.lock'), false, 'clearing a stale lock moves no ref');
    assert.equal(blocks(r, 'echo x > .gitignore'), false);
  });

  it('blocks switching the hooks off through git config', () => {
    const r = repo();
    for (const cmd of ['git config core.hooksPath /dev/null', 'git config --local core.hooksPath x', 'git config --unset core.hooksPath',
      'git config set core.hooksPath x', 'git config unset core.hooksPath']) {
      assert.equal(blocks(r, cmd), true, cmd);
    }
    assert.equal(blocks(r, 'git config core.hooksPath'), false, 'reading it is fine');
    assert.equal(blocks(r, 'git config user.name x'), false);
  });

  it('blocks clearing the agent-environment variables the git hook reads, before git', () => {
    const r = repo();
    for (const cmd of ['env -u CLAUDECODE git merge ingest/x', 'env -i PATH=/usr/bin git branch -f main x', 'CLAUDECODE= git merge x',
      'unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; git merge x', 'export AI_AGENT= && git merge x', 'env --unset=CLAUDECODE git status']) {
      assert.equal(blocks(r, cmd), true, cmd);
    }
    assert.equal(blocks(r, 'env -u FOO git status'), false);
    assert.equal(blocks(r, 'unset CLAUDECODE; ls'), false, 'no git in the command');
  });

  it('fails closed only for text naming refs/heads/main, .git/refs or packed-refs that it cannot follow', () => {
    const r = repo();
    for (const cmd of [
      `python3 -c "import subprocess; subprocess.run(['git','update-ref','refs/heads/main','HEAD'])"`,
      'bash -c "git update-ref refs/heads/main HEAD"', 'sh -c "echo x > .git/refs/heads/main"', 'eval git update-ref refs/heads/main HEAD',
      `node -e "require('fs').writeFileSync('.git/packed-refs', '')"`, 'echo HEAD | xargs git update-ref refs/heads/main',
      `git -c alias.x='!git update-ref refs/heads/main HEAD' x`, 'cat <<EOF > x\nrefs/heads/main\nEOF', 'find .git/refs -delete',
      'git commit -m "unbalanced refs/heads/main']) {
      assert.equal(blocks(r, cmd), true, cmd);
    }
    // Outside that class the guard still fails open.
    assert.equal(blocks(r, 'bash -c "git status"'), false);
    assert.equal(blocks(r, 'python3 -c "print(1)"'), false);
    assert.equal(blocks(r, 'bash -c "echo refs/heads/main-old"'), false, 'a different branch name');
    assert.equal(blocks(r, 'find .git/refs -name main'), false, 'find without -delete/-exec only reads');
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
  it('pre-approves nothing that runs arbitrary code or moves main, and denies the ref movers', () => {
    const { allow, deny } = settings.permissions;
    for (const a of ['Bash(python3:*)', 'Bash(npx tsx:*)', 'Bash(xargs:*)', 'Bash(cp:*)', 'Bash(mv:*)', 'Bash(git branch:*)',
      'Bash(git checkout:*)', 'Bash(git switch:*)', 'Bash(curl -s http://localhost:*)']) assert.ok(!allow.includes(a), a);
    for (const d of ['Bash(git checkout -B:*)', 'Bash(git switch -C:*)', 'Bash(git branch -f:*)', 'Bash(git branch -M:*)', 'Bash(git branch -C:*)',
      'Bash(git reset --soft:*)', 'Bash(git reset --mixed:*)', 'Bash(git update-ref:*)', 'Bash(curl *inbox/login*)']) assert.ok(deny.includes(d), d);
  });
  it('wires guard-git on Bash and guard-wiki on file edits', () => {
    const pre = settings.hooks.PreToolUse;
    assert.ok(pre.some((h) => h.matcher === 'Bash' && h.hooks.some((x) => x.command.endsWith('hook guard-git'))));
    assert.ok(pre.some((h) => h.matcher === 'Write|Edit|MultiEdit' && h.hooks.some((x) => x.command.endsWith('hook guard-wiki'))));
  });
});
