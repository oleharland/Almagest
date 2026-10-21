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
import os from 'node:os';
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

/**
 * A linked worktree whose `.git` file is not what git wrote when it was
 * created: a symlink, a directory, or a pointer at some other git dir (the main
 * repository's, so a commit lands on `main`; or a fake one whose config runs a
 * program). `content` is what the file holds now, for the job log.
 */
export class WorktreeTamperedError extends Error {
  constructor(dotGit, problem, content) {
    super(`${dotGit} ${problem}`);
    this.name = 'WorktreeTamperedError';
    this.dotGit = dotGit;
    this.content = content;
  }
}

/**
 * Inherited GIT_* variables that only say how to reach a remote or where the
 * operator's global config is. Every other one (GIT_DIR, GIT_WORK_TREE,
 * GIT_INDEX_FILE, GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT …) would redirect
 * or reconfigure a command, and is dropped from every child. A caller's own
 * `env` (a temporary GIT_INDEX_FILE, author names) is applied after this.
 */
const KEEP_GIT_ENV = new Set(['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_ASKPASS', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GIT_PROXY_COMMAND', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']);

/**
 * process.env for a git child, without the inherited GIT_* that would
 * redirect it; every other variable (agent markers included) is kept. Also
 * used by modules that spawn git themselves (governance/merge.mjs).
 */
export function childEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') || KEEP_GIT_ENV.has(k)) env[k] = v;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...extra };
}

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

export function createGit({ repoRoot, main = 'main', worktreeDir }) {
  const worktreeRoot = worktreeDir || path.join(repoRoot, '.almagest', 'worktrees');

  async function run(args, { cwd = repoRoot, env, input } = {}) {
    try {
      const child = exec('git', args, {
        cwd,
        env: childEnv(env),
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
   * The admin dir git keeps for the linked worktree at `dir` —
   * `<common-dir>/worktrees/<name>`, holding its HEAD and index — or null when
   * `dir` is not a linked worktree of this repository. Asked of the repo root
   * and read from the admin dirs' own `gitdir` back-pointers, never from the
   * worktree's `.git` file: whoever could write the worktree could write that.
   */
  async function worktreeGitDir(dir) {
    const real = realOr(dir);
    if (!(await worktrees()).some((w) => realOr(w.path) === real)) return null;
    const common = path.resolve(repoRoot, (await run(['rev-parse', '--git-common-dir'])).trim());
    const admin = path.join(common, 'worktrees');
    let names = [];
    try { names = fs.readdirSync(admin); } catch { return null; }
    for (const name of names) {
      let target;
      try { target = fs.readFileSync(path.join(admin, name, 'gitdir'), 'utf-8').trim(); } catch { continue; }
      if (target && realOr(path.dirname(path.resolve(admin, name, target))) === real) return path.join(admin, name);
    }
    return null;
  }

  /**
   * A handle for running git in a linked worktree without trusting anything in
   * it. `.git` is checked now — a regular file pointing at the admin dir from
   * worktreeGitDir — and its bytes recorded; every later command first checks
   * it is still exactly that, then runs with `--git-dir`/`--work-tree` given
   * explicitly, fsmonitor off and no hooks, so neither a rewritten `.git` nor a
   * fake git dir's config is ever read. Null when `dir` is not a linked
   * worktree; throws WorktreeTamperedError when it is one and `.git` is wrong.
   */
  async function openWorktree(dir) {
    const gitDir = await worktreeGitDir(dir);
    if (!gitDir) return null;
    const worktree = realOr(dir);
    const dotGit = path.join(worktree, '.git');
    const read = () => {
      const st = fs.lstatSync(dotGit, { throwIfNoEntry: false });
      if (!st) return { problem: 'is missing' };
      if (!st.isFile()) return { problem: `is a ${st.isSymbolicLink() ? 'symbolic link' : st.isDirectory() ? 'directory' : 'special file'}, not the file git wrote` };
      return { bytes: fs.readFileSync(dotGit) };
    };
    const first = read();
    if (first.problem) throw new WorktreeTamperedError(dotGit, first.problem, '');
    const pointer = /^gitdir: (.+?)\r?\n?$/.exec(first.bytes.toString('utf-8'))?.[1];
    if (!pointer || realOr(path.resolve(worktree, pointer)) !== realOr(gitDir)) {
      throw new WorktreeTamperedError(dotGit, `does not point at this worktree's git dir ${gitDir}`, first.bytes.toString('utf-8'));
    }

    function check() {
      const now = read();
      if (now.problem) throw new WorktreeTamperedError(dotGit, `${now.problem} — it changed after the worktree was opened`, '');
      if (!now.bytes.equals(first.bytes)) throw new WorktreeTamperedError(dotGit, 'changed after the worktree was opened', now.bytes.toString('utf-8'));
    }

    const pinned = ['--git-dir', gitDir, '--work-tree', worktree, '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${os.devNull}`];
    async function wrun(args, { env, input } = {}) {
      check();
      return run([...pinned, ...args], { cwd: worktree, env, input });
    }
    const wrev = async (ref) => (await wrun(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    return {
      path: worktree, gitDir, check,
      run: wrun,
      revParse: wrev,
      /** refs/heads/<branch> HEAD is on, from the admin dir's HEAD; '' when detached. */
      branch: async () => (await wrun(['symbolic-ref', '--quiet', 'HEAD']).catch((err) => {
        if (err instanceof WorktreeTamperedError) throw err;
        return '';
      })).trim().replace(/^refs\/heads\//, ''),
      commitAll: (opts) => commitWith(wrun, wrev, opts),
    };
  }

  async function commitWith(r, rev, { message, author, committer = author, coAuthors = [] }) {
    await r(['add', '-A']);
    if ((await r(['diff', '--cached', '--name-only'])).trim() === '') return null;
    const trailers = coAuthors.map((a) => `\n\nCo-authored-by: ${a.name} <${a.email}>`).join('');
    const env = {
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email,
    };
    await r(['commit', '--no-verify', '-m', message + trailers], { env });
    return rev('HEAD');
  }

  /**
   * Stage everything in `cwd` and commit. `author` / `committer` are
   * `{ name, email }`; `coAuthors` become trailers. Returns the new sha, or
   * null when there was nothing to commit (write-if-changed, rule 6). In a
   * linked worktree this goes through openWorktree, so a rewritten `.git`
   * fails the commit instead of redirecting it.
   */
  async function commitAll(cwd, opts) {
    const wt = await openWorktree(cwd);
    if (wt) return wt.commitAll(opts);
    return commitWith((args, o = {}) => run(args, { ...o, cwd }), (ref) => revParse(ref, { cwd }), opts);
  }

  return {
    repoRoot, main, worktreeRoot,
    run, tryRun, revParse, branchExists, currentBranch,
    worktrees, worktreeFor, worktreeAdd, worktreeRemove, worktreeGitDir, openWorktree,
    isClean, diffNames, show, mergeBase, commitAll,
  };
}

/** `{ name, email }` for an actor, for commit authorship. */
export function gitIdentity(actor) {
  if (!actor) return { name: 'Almagest', email: 'almagest@localhost' };
  return { name: actor.display || actor.id, email: actor.email || `${String(actor.id).replace(/[^a-z0-9._-]+/gi, '-')}@almagest.local` };
}
