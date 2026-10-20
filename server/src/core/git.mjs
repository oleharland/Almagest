/**
 * git.mjs — the git plumbing every module shares. Shells out to the git CLI;
 * there is no JS git implementation in the loop, so what the service does is
 * exactly what a human would see running the same commands.
 *
 * Deliberately NOT here: merging to main. That is governance's job and lives
 * in server/src/governance/, next to the policy that decides whether it may
 * happen at all.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class GitError extends Error {
  constructor(args, err) {
    super(`git ${args.join(' ')} failed: ${(err.stderr || err.message || '').trim()}`);
    this.name = 'GitError';
    this.code = err.code;
    this.stderr = err.stderr || '';
  }
}

export function createGit({ repoRoot, main = 'main', worktreeDir }) {
  const worktreeRoot = worktreeDir || path.join(repoRoot, '.almagest', 'worktrees');

  async function run(args, { cwd = repoRoot, env, input } = {}) {
    try {
      const child = exec('git', args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
        maxBuffer: 64 * 1024 * 1024,
      });
      if (input !== undefined) { child.child.stdin.end(input); }
      const { stdout } = await child;
      return stdout;
    } catch (err) {
      throw new GitError(args, err);
    }
  }

  async function tryRun(args, options) {
    try { return await run(args, options); } catch { return null; }
  }

  async function revParse(ref, options) {
    return (await run(['rev-parse', '--verify', `${ref}^{commit}`], options)).trim();
  }

  async function branchExists(branch) {
    return (await tryRun(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) !== null;
  }

  async function currentBranch(cwd = repoRoot) {
    return ((await tryRun(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd })) || '').trim();
  }

  /** `git worktree list --porcelain` → [{ path, head, branch }] */
  async function worktrees() {
    const out = await run(['worktree', 'list', '--porcelain']);
    const list = [];
    let cur = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) { cur = { path: line.slice(9), head: '', branch: '' }; list.push(cur); }
      else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
      else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    }
    return list;
  }

  async function worktreeFor(branch) {
    return (await worktrees()).find((w) => w.branch === branch) || null;
  }

  /**
   * A worktree for `branch` under worktree_dir, created from `base` when the
   * branch does not exist yet. Reuses an existing worktree for the branch.
   */
  async function worktreeAdd(branch, { base = main } = {}) {
    const existing = await worktreeFor(branch);
    if (existing) return existing.path;
    const dir = path.join(worktreeRoot, branch.replace(/[^a-zA-Z0-9._-]+/g, '__'));
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (await branchExists(branch)) await run(['worktree', 'add', dir, branch]);
    else await run(['worktree', 'add', '-b', branch, dir, base]);
    // git reports worktrees by real path (/private/var on macOS, not /var), so
    // return that too — callers compare this against worktreeFor().
    return fs.realpathSync(dir);
  }

  async function worktreeRemove(dir, { force = false } = {}) {
    await run(['worktree', 'remove', ...(force ? ['--force'] : []), dir]);
  }

  async function isClean(cwd = repoRoot) {
    return (await run(['status', '--porcelain'], { cwd })).trim() === '';
  }

  /** [{ status: 'A'|'M'|'D'|'R', path, from? }] between two commits, optionally under `paths`. */
  async function diffNames(base, head, paths = []) {
    const out = await run(['diff', '--name-status', '-M', '-z', base, head, '--', ...paths]);
    const parts = out.split('\0').filter(Boolean);
    const changes = [];
    for (let i = 0; i < parts.length; i++) {
      const status = parts[i][0];
      if (status === 'R' || status === 'C') { changes.push({ status: 'R', from: parts[i + 1], path: parts[i + 2] }); i += 2; }
      else { changes.push({ status, path: parts[i + 1] }); i += 1; }
    }
    return changes;
  }

  /** File content at `ref`, or null when it does not exist there. */
  async function show(ref, file) {
    return tryRun(['show', `${ref}:${file}`]);
  }

  async function mergeBase(a, b) {
    return (await run(['merge-base', a, b])).trim();
  }

  /**
   * Stage everything in `cwd` and commit. `author` / `committer` are
   * `{ name, email }`; `coAuthors` become trailers. Returns the new sha, or
   * null when there was nothing to commit (write-if-changed, rule 6).
   */
  async function commitAll(cwd, { message, author, committer = author, coAuthors = [] }) {
    await run(['add', '-A'], { cwd });
    if ((await run(['diff', '--cached', '--name-only'], { cwd })).trim() === '') return null;
    const trailers = coAuthors.map((a) => `\n\nCo-authored-by: ${a.name} <${a.email}>`).join('');
    const env = {
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email,
    };
    await run(['commit', '--no-verify', '-m', message + trailers], { cwd, env });
    return revParse('HEAD', { cwd });
  }

  return {
    repoRoot, main, worktreeRoot,
    run, tryRun, revParse, branchExists, currentBranch,
    worktrees, worktreeFor, worktreeAdd, worktreeRemove,
    isClean, diffNames, show, mergeBase, commitAll,
  };
}

/** `{ name, email }` for an actor, for commit authorship. */
export function gitIdentity(actor) {
  if (!actor) return { name: 'Almagest', email: 'almagest@localhost' };
  return { name: actor.display || actor.id, email: actor.email || `${String(actor.id).replace(/[^a-z0-9._-]+/gi, '-')}@almagest.local` };
}
