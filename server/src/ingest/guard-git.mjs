/**
 * guard-git.mjs — `almagest hook guard-git`, the Bash half of the wiki guard.
 *
 * `guard-wiki` stops a Write/Edit tool call into brain/wiki/ on main. A
 * session can reach the same place through Bash instead: `git commit`,
 * `git merge ingest/x`, `git cherry-pick`, `git am`, `git stash pop`, or
 * plainly `cp draft.md brain/wiki/`. This hook reads the command Claude Code
 * is about to run and blocks (exit 2) when:
 *
 *   - on the main branch, it would put a brain/wiki/ change into main or into
 *     main's working tree;
 *   - on any branch, it would move or rewrite refs/heads/<main> without a
 *     commit: `checkout -B` / `switch -C`, `branch -f|-m|-M|-c|-C|-d|-D`,
 *     `update-ref`, `symbolic-ref`, `worktree add -B`, a `fetch` refspec or a
 *     `push` to a local repository whose destination is main, a `rebase` of
 *     main — and, while on main, `reset <commit>`, `rebase`, `commit --amend`
 *     and `pull`;
 *   - on any branch, it would skip or switch off the repository hooks
 *     (`--no-verify`, `-c core.hooksPath=…`, GIT_CONFIG_COUNT/KEY/PARAMETERS),
 *     or write the git config they stand on (`core.hooksPath`, `almagest.*`,
 *     config includes, remote URLs), since the pre-commit audit is
 *     non-negotiable 7 and the reference-transaction hook is the backstop
 *     under this one;
 *   - on any branch, it would add a new place for branches to come from
 *     (`git remote add|set-url`, a fetch or pull straight from a URL);
 *   - on any branch, it would write inside a `.git/` directory — where
 *     `almagest hooks install` puts the hooks git runs — or clear one of the
 *     agent-environment variables before running git or the Almagest CLI;
 *   - it runs `almagest login`, which mints an approver's sign-in link.
 *
 * It parses shell the way a careful reader would, not the way bash does:
 * `&&` / `||` / `;` / `|` / newlines split commands, quotes group words, and
 * `cd <dir>` and `git switch|checkout <branch>` earlier in the same command
 * are followed, so `git switch main && git merge ingest/x` is judged on main.
 *
 * What it cannot follow — `bash -c "…"`, a script, `eval`, `python3 -c` — it
 * allows, with one exception: command text that names `refs/heads/<main>`,
 * `.git/refs` or `packed-refs` and that this reader cannot account for is
 * blocked. That class is narrow and has no everyday use; everywhere else the
 * principle is the same as guard-wiki — fail closed only on the clear case,
 * open on everything else, because a guard that blocks on its own parse bugs
 * gets uninstalled. Under it sit the pre-commit hook (commits) and the
 * reference-transaction hook (every ref update, whoever typed it), installed
 * from main into `<git-common-dir>/almagest/hooks/`.
 *
 * A human typing in their own terminal is not affected — Claude Code hooks
 * only see Claude Code's tool calls, and a human merge is the gate anyway.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../../tools/lib/config.mjs';
import { AGENT_ENV_VARS } from '../../../tools/lib/git-hooks.mjs';
import { isInside, realish } from './source.mjs';

// ── a small shell-words reader ──────────────────────────────────────────────

/**
 * `cmd` → [[word, …], …], one array per simple command. Redirections are kept
 * as their own words (`>`, `>>`) so the writer check can see their targets.
 * Returns null when the text uses something this reader will not pretend to
 * understand (unbalanced quotes, here-docs).
 */
export function splitCommands(cmd) {
  const out = [];
  let words = [];
  let word = '';
  let inWord = false;
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false; };
  const endCmd = () => { endWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j === -1) return null;
      word += cmd.slice(i + 1, j); inWord = true; i = j; continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = '';
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === '\\' && j + 1 < cmd.length) { buf += cmd[++j]; continue; }
        buf += cmd[j];
      }
      if (j >= cmd.length) return null;
      word += buf; inWord = true; i = j; continue;
    }
    if (c === '\\' && i + 1 < cmd.length) { word += cmd[++i]; inWord = true; continue; }
    if (c === '<' && cmd[i + 1] === '<') return null;   // here-doc / here-string: not followed
    if (c === ';' || c === '\n' || c === '&' || c === '|' || c === '(' || c === ')') { endCmd(); continue; }
    if (c === '>') {
      endWord();
      if (cmd[i + 1] === '>') i++;
      words.push('>');
      continue;
    }
    if (/\s/.test(c)) { endWord(); continue; }
    word += c; inWord = true;
  }
  endCmd();
  return out;
}

// ── git helpers ─────────────────────────────────────────────────────────────

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim();
}
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const tryGit = (cwd, args) => { try { return git(cwd, args); } catch { return null; } };

function repoAt(cwd) {
  try {
    const top = realish(git(cwd, ['rev-parse', '--show-toplevel']));
    let brainDir = 'brain';
    let main = 'main';
    try {
      const cfg = loadConfig(top);
      brainDir = cfg.brainDir.replace(/\/+$/, '');
      main = String(cfg.raw.service?.git?.main || 'main');
    } catch { /* defaults */ }
    let branch = '';
    try { branch = git(top, ['symbolic-ref', '--quiet', '--short', 'HEAD']); } catch { branch = ''; }
    return { top, brainDir, main, branch };
  } catch {
    return null;
  }
}

const GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const COMMIT_VALUE_OPTS = new Set(['-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message',
  '--author', '--date', '--fixup', '--squash', '-t', '--template', '--cleanup', '--trailer', '-S', '--gpg-sign', '--pathspec-from-file']);

/** `git [globals] <sub> args` → { cwd, sub, args, hooksDisabled } or null if not git. */
function parseGit(words, cwd) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;   // FOO=bar git …
  if (words[i] === 'command' || words[i] === 'exec') i++;
  if (!words[i] || path.basename(words[i]) !== 'git') return null;
  i++;
  let dir = cwd;
  let hooksDisabled = false;
  while (i < words.length && words[i].startsWith('-')) {
    const w = words[i];
    if (w === '-C') { dir = path.resolve(dir, words[i + 1] || '.'); i += 2; continue; }
    if (w === '-c') {
      if (/^(core\.hookspath|include\.path|includeif\.[^=]*)=/i.test(words[i + 1] || '')) hooksDisabled = true;
      i += 2; continue;
    }
    if (/^-c/.test(w) && /(core\.hookspath|include\.path|includeif\.[^=]*)=/i.test(w)) { hooksDisabled = true; i++; continue; }
    if (GLOBAL_WITH_VALUE.has(w)) { i += 2; continue; }
    i++;
  }
  return { cwd: dir, sub: words[i] || '', args: words.slice(i + 1).filter((w, j, a) => w !== '>' && a[j - 1] !== '>'), hooksDisabled };
}

/** Short-option cluster check: does `-anm` (before any value-taking letter) contain `n`? */
function clusterHas(arg, letter, valueLetters = 'mFCcSt') {
  if (!/^-[A-Za-z]+$/.test(arg)) return false;
  for (const ch of arg.slice(1)) {
    if (ch === letter) return true;
    if (valueLetters.includes(ch)) return false;
  }
  return false;
}

/** Non-option words, skipping the value of each option in `withValue` (`--opt value`; `--opt=value` is one word). */
function operandsOf(args, withValue = new Set()) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { out.push(...args.slice(i + 1)); break; }
    if (withValue.has(a)) { i++; continue; }
    if (a.startsWith('-') && a !== '-') continue;
    out.push(a);
  }
  return out;
}

/** Paths a git operation would bring into the current branch, or null when it cannot tell. */
function affectedPaths(repo, sub, args) {
  const { top } = repo;
  const revs = args.filter((a) => !a.startsWith('-'));
  try {
    switch (sub) {
      case 'commit': {
        const staged = lines(git(top, ['diff', '--cached', '--name-only']));
        let widened = args.some((a) => a === '-a' || a === '--all' || a === '-i' || a === '--include' || a === '-o' || a === '--only' || clusterHas(a, 'a'));
        for (let i = 0; i < args.length && !widened; i++) {
          const a = args[i];
          if (a === '--') { widened = i + 1 < args.length; break; }
          if (COMMIT_VALUE_OPTS.has(a)) { i++; continue; }
          if (!a.startsWith('-')) widened = true;   // a pathspec
        }
        return widened ? [...new Set([...staged, ...lines(git(top, ['diff', '--name-only']))])] : staged;
      }
      case 'merge': {
        if (args.includes('--abort') || args.includes('--quit')) return [];
        if (args.includes('--continue')) return lines(git(top, ['diff', '--cached', '--name-only']));
        const targets = revs.length ? revs : ['@{upstream}'];
        return targets.flatMap((r) => lines(git(top, ['diff', '--name-only', `HEAD...${r}`])));
      }
      case 'cherry-pick':
      case 'revert': {
        if (args.includes('--abort') || args.includes('--quit') || args.includes('--skip')) return [];
        if (args.includes('--continue')) return lines(git(top, ['diff', '--cached', '--name-only']));
        return revs.flatMap((r) => (r.includes('..')
          ? lines(git(top, ['diff', '--name-only', ...r.split(/\.\.\.?/)]))
          : lines(git(top, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', r]))));
      }
      case 'am': {
        if (args.includes('--abort') || args.includes('--quit') || args.includes('--skip')) return [];
        if (args.includes('--continue')) return lines(git(top, ['diff', '--cached', '--name-only']));
        const files = revs.map((f) => path.resolve(top, f)).filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());
        if (!files.length) return null;
        return files.flatMap((f) => [...fs.readFileSync(f, 'utf-8').matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)].flatMap((m) => [m[1], m[2]]));
      }
      case 'stash': {
        const action = args[0];
        if (action !== 'pop' && action !== 'apply') return [];
        const ref = args.slice(1).find((a) => !a.startsWith('-')) || 'stash@{0}';
        let names = lines(git(top, ['stash', 'show', '--name-only', ref]));
        try { names = [...names, ...lines(git(top, ['stash', 'show', '--name-only', '--only-untracked', ref]))]; } catch { /* older git */ }
        return names;
      }
      default:
        return [];
    }
  } catch {
    return null;
  }
}

// ── moves of refs/heads/<main> ──────────────────────────────────────────────

/** Does `name` (a branch name or full ref, possibly `+`-forced) denote refs/heads/<main>? */
function namesMain(name, main) {
  const n = String(name || '').replace(/^\+/, '');
  return n === main || n === `refs/heads/${main}` || n === `heads/${main}`;
}

/** Does a refspec destination (fetch DWIMs a bare name to refs/heads/) cover refs/heads/<main>? Globs included. */
function destCoversMain(dst, main) {
  if (!dst) return false;
  const d = dst.replace(/^\+/, '');
  const full = d.startsWith('refs/') ? d : `refs/heads/${d}`;
  if (!full.includes('*')) return namesMain(full, main);
  const re = new RegExp(`^${full.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(`refs/heads/${main}`);
}

/** Is a push/fetch <repository> argument this machine's disk (`.`, a path, file://, or a remote whose URL is one)? */
function isLocalRepo(repoArg, top) {
  const local = (u) => u === '.' || /^(\/|\.\.?\/|~|file:)/.test(u) || (!u.includes(':') && fs.existsSync(path.resolve(top, u)));
  if (local(repoArg)) return true;
  if (!/^[A-Za-z0-9._-]+$/.test(repoArg)) return false;
  const urls = [tryGit(top, ['config', '--get-all', `remote.${repoArg}.url`]), tryGit(top, ['config', '--get-all', `remote.${repoArg}.pushurl`])]
    .flatMap((v) => (v ? lines(v) : []));
  return urls.some(local);
}

const BRANCH_VALUE = new Set(['-u', '--set-upstream-to', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format']);
const REBASE_VALUE = new Set(['--onto', '-s', '--strategy', '-X', '--strategy-option', '-x', '--exec']);
const FETCH_VALUE = new Set(['--depth', '--deepen', '--shallow-since', '--shallow-exclude', '-j', '--jobs', '--refmap', '--upload-pack',
  '--negotiation-tip', '-o', '--server-option', '--receive-pack', '--repo', '--push-option', '-s', '--strategy', '-X', '--strategy-option']);

/**
 * When `git <sub> <args>` would move or rewrite refs/heads/<main>, a sentence
 * saying how; else null. `branch` is the branch HEAD is on (or will be, after
 * an earlier `git switch` in the same command).
 */
function mainMove(g, repo, branch) {
  const { main, top } = repo;
  const { sub, args } = g;
  const onMain = branch === main;
  const has = (...flags) => args.some((a) => flags.includes(a));

  switch (sub) {
    case 'checkout':
    case 'switch': {
      const i = args.findIndex((a) => a === '-B' || a === '-C' || a === '--force-create');
      const forced = i !== -1 ? args[i + 1] : (args.find((a) => a.startsWith('--force-create=')) || '').slice(15);
      return forced && namesMain(forced, main) ? `\`git ${sub} ${args[i] || '--force-create'} ${forced}\` resets ${main} to another commit` : null;
    }
    case 'branch': {
      const short = (re) => args.some((a) => /^-[A-Za-z]+$/.test(a) && re.test(a));
      const deletes = has('--delete') || short(/[dD]/);
      const moves = has('--move') || short(/[mM]/);
      const copies = has('--copy') || short(/[cC]/);
      const ops = operandsOf(args, BRANCH_VALUE);
      const listing = has('--list', '-l', '-a', '--all', '-r', '--remotes', '--show-current', '-v', '-vv', '--verbose',
        '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--edit-description', '-u', '--set-upstream-to', '--unset-upstream');
      // Which operands name a branch this command writes: every one for -d,
      // old and new for -m (one operand: HEAD's branch → it), new for -c, and
      // the first for a create / -f (the second is only its start point).
      let written;
      if (deletes) written = ops;
      else if (moves) written = ops.length === 1 ? [branch, ops[0]] : ops.slice(0, 2);
      else if (copies) written = ops.length === 1 ? [ops[0]] : ops.slice(1, 2);
      else if (listing) written = [];
      else written = ops.slice(0, 1);
      const hit = written.find((o) => namesMain(o, main));
      return hit ? `\`git branch ${args.join(' ')}\` rewrites the ${main} branch` : null;
    }
    case 'worktree': {
      if (args[0] !== 'add') return null;
      const i = args.indexOf('-B');
      return i !== -1 && namesMain(args[i + 1], main) ? `\`git worktree add -B ${args[i + 1]}\` resets ${main}` : null;
    }
    case 'update-ref': {
      if (has('--stdin')) return '`git update-ref --stdin` updates refs this guard cannot see';
      const [ref] = operandsOf(args, new Set(['-m']));
      if (namesMain(ref, main)) return `\`git update-ref\` sets refs/heads/${main} directly`;
      if (ref === 'HEAD' && onMain && !has('--no-deref')) return `\`git update-ref HEAD\` on \`${main}\` moves ${main}`;
      return null;
    }
    case 'symbolic-ref': {
      const ops = operandsOf(args, new Set(['-m']));
      return (ops.length >= 2 || has('-d', '--delete')) && namesMain(ops[0], main) ? `\`git symbolic-ref\` repoints refs/heads/${main}` : null;
    }
    case 'fetch':
    case 'pull': {
      const ops = operandsOf(args, FETCH_VALUE);
      const specs = has('--all', '--multiple') ? (has('--multiple') ? [] : ops) : ops.slice(1);
      const hit = specs.find((s) => s.includes(':') && destCoversMain(s.slice(s.indexOf(':') + 1), main));
      if (hit) return `\`git ${sub} … ${hit}\` writes refs/heads/${main}`;
      if (sub === 'pull' && onMain && !has('--dry-run')) return `\`git pull\` on \`${main}\` moves ${main} to what the remote has`;
      return null;
    }
    case 'push': {
      const ops = operandsOf(args, FETCH_VALUE);
      if (!ops.length || !isLocalRepo(ops[0], top)) return null;   // a remote's main is the remote's business
      if (has('--mirror', '--all', '--branches')) return `\`git push ${ops[0]} --mirror|--all\` overwrites ${main} in a local repository`;
      const deleting = has('-d', '--delete');
      const hit = ops.slice(1).find((s) => {
        const dst = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
        return destCoversMain(dst, main) || (deleting && namesMain(s, main));
      });
      return hit ? `\`git push ${ops[0]} ${hit}\` writes refs/heads/${main} in a local repository` : null;
    }
    case 'rebase': {
      if (has('--abort', '--quit', '--edit-todo', '--show-current-patch')) return null;
      const ops = operandsOf(args, REBASE_VALUE);
      if (namesMain(ops[1], main)) return `\`git rebase … ${ops[1]}\` rewrites ${main}`;
      if (onMain) return `\`git rebase\` on \`${main}\` rewrites ${main}`;
      if (has('--continue', '--skip')) {
        const gitDir = tryGit(top, ['rev-parse', '--path-format=absolute', '--git-dir']);
        const headName = gitDir && ['rebase-merge', 'rebase-apply']
          .map((d) => { try { return fs.readFileSync(path.join(gitDir, d, 'head-name'), 'utf-8').trim(); } catch { return ''; } })
          .find(Boolean);
        if (namesMain(headName, main)) return `\`git rebase ${args[0]}\` finishes a rebase of ${main}`;
      }
      return null;
    }
    case 'reset': {
      if (!onMain || has('-p', '--patch') || args.some((a) => a.startsWith('--pathspec-from-file'))) return null;
      const dd = args.indexOf('--');
      const before = (dd === -1 ? args : args.slice(0, dd)).filter((a) => !a.startsWith('-'));
      // Paths after `--`, or a commit followed by paths, touch the index only;
      // no commit at all resets to HEAD. Only `reset [<mode>] <commit>` moves the branch.
      if ((dd !== -1 && dd < args.length - 1) || before.length !== 1) return null;
      const target = tryGit(top, ['rev-parse', '--verify', '--quiet', `${before[0]}^{commit}`]);
      if (!target) return null;           // a path
      const head = tryGit(top, ['rev-parse', 'HEAD']);
      return target !== head ? `\`git reset ${args.join(' ')}\` on \`${main}\` moves ${main} to another commit` : null;
    }
    case 'commit':
      return onMain && has('--amend') ? `\`git commit --amend\` on \`${main}\` rewrites a commit already on ${main}` : null;
    case 'filter-branch':
    case 'filter-repo':
      return `\`git ${sub}\` rewrites history, ${main} included`;
    default:
      return null;
  }
}

/**
 * Config keys an agent may not write: where the hooks live (`core.hooksPath`),
 * Almagest's own (`almagest.*`), anything that pulls in another config file
 * that could set either (`include.path`, `includeIf.*`), and where fetches
 * come from (`remote.<name>.url`, `url.<base>.insteadOf` — the same as
 * `git remote add|set-url`).
 */
const PROTECTED_KEY = /^(core\.hookspath|almagest\..+|include\.path|includeif\..+|remote\..+\.(url|pushurl)|url\..+\.(push)?insteadof)$/i;
const PROTECTED_SECTION = /^(core|almagest|include|includeif|remote|url)(\.|$)/i;

/** A `git config` that writes a protected key: `git config core.hooksPath x`, `--unset`, `set|unset`, `--edit`, section ops; reads are fine. */
function writesProtectedConfig(g) {
  if (g.sub !== 'config') return null;
  const reads = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '-l', '--list', 'get', 'list', '--show-origin', '--show-scope'];
  const writes = ['--unset', '--unset-all', '--replace-all', '--add', 'set', 'unset'];
  if (g.args.some((a) => a === '--edit' || a === '-e' || a === 'edit')) return 'git config --edit';
  const section = g.args.findIndex((a) => ['--remove-section', '--rename-section', 'remove-section', 'rename-section'].includes(a));
  if (section !== -1) {
    const named = g.args.slice(section + 1).find((a) => !a.startsWith('-'));
    return named && PROTECTED_SECTION.test(named) ? `git config ${g.args[section]} ${named}` : null;
  }
  const key = g.args.find((a) => PROTECTED_KEY.test(a));
  if (!key) return null;
  if (g.args.some((a) => writes.includes(a))) return `git config … ${key}`;
  if (g.args.some((a) => reads.includes(a))) return null;
  return g.args.filter((a) => !a.startsWith('-')).length >= 2 ? `git config ${key} …` : null;   // `git config <key> <value>`
}

/** Environment that hands git config on the side: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath …`, `GIT_CONFIG_PARAMETERS=…`. */
function injectsGitConfig(words) {
  const injected = (w) => /^(GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+)=/.test(w);
  if (words[0] === 'export' || words[0] === 'declare' || words[0] === 'typeset') return words.slice(1).some(injected);
  if (path.basename(words[0] || '') === 'env') return words.slice(1).some(injected);
  for (const w of words) {
    if (!/^[A-Za-z_]\w*=/.test(w)) break;
    if (injected(w)) return true;
  }
  return false;
}

/** `git remote add|set-url`, or a fetch/pull straight from a URL: a new place for branches to come from. */
function newRemote(g) {
  if (g.sub === 'remote') {
    const action = g.args.find((a) => a !== '-v' && a !== '--verbose');
    return action === 'add' || action === 'set-url' ? `git remote ${action}` : null;
  }
  if (g.sub === 'fetch' || g.sub === 'pull') {
    const [repoArg] = operandsOf(g.args, FETCH_VALUE);
    return repoArg && (/:\/\//.test(repoArg) || /^[^/:\s]+@[^/:\s]+:/.test(repoArg)) ? `git ${g.sub} ${repoArg}` : null;
  }
  return null;
}

// ── writers ─────────────────────────────────────────────────────────────────

/** Commands that write their last argument(s) / redirect targets. Best effort; anything else is not a write. */
function writeTargets(words) {
  const targets = [];
  for (let i = 0; i < words.length; i++) if (words[i] === '>' && words[i + 1]) targets.push(words[i + 1]);
  const cmd = path.basename(words[0] || '');
  const args = words.slice(1).filter((w, i, a) => w !== '>' && a[i - 1] !== '>');
  const operands = args.filter((a) => !a.startsWith('-'));
  if (['cp', 'rsync', 'ln', 'install'].includes(cmd) && operands.length >= 2) targets.push(operands[operands.length - 1]);
  if (cmd === 'mv' && operands.length >= 2) targets.push(...operands);   // a move removes its sources too
  if (['tee', 'touch', 'rm', 'truncate', 'unlink'].includes(cmd)) targets.push(...operands);
  // Taking a hook's x bit away switches it off as surely as deleting it.
  if (cmd === 'chmod') targets.push(...operands.filter((a) => !/^([0-7]{1,4}|[ugoa]*[-+=][rwxXst]*(,[ugoa]*[-+=][rwxXst]*)*)$/.test(a)));
  if (['chown', 'chgrp', 'chflags', 'setfacl'].includes(cmd)) targets.push(...operands.slice(1));
  if (cmd === 'sed' && args.some((a) => a === '-i' || a.startsWith('-i') || a === '--in-place')) targets.push(...operands.slice(1));
  return targets;
}

/** Is `abs` inside a git directory — a `.git` path segment, or the repo's own (common) git dir? */
function insideGitDir(abs, cwd) {
  if (abs.split(path.sep).includes('.git')) return true;
  const common = tryGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return Boolean(common && isInside(realish(common), abs));
}

// ── the narrow fail-closed class ────────────────────────────────────────────

/** Programs whose words this guard accounts for when they name a ref file: readers, and git itself. */
const READERS = new Set(['cat', 'ls', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'less', 'more', 'file', 'stat',
  'echo', 'printf', 'diff', 'cmp', 'test', '[', 'true', 'false', 'pwd', 'which', 'cd', 'git', 'sort', 'uniq', 'cut', 'tr']);

/** git's own subcommands; anything else after `git` is an alias or an external `git-<name>`. */
const GIT_SUBCOMMANDS = new Set(('add am annotate apply archive bisect blame branch bundle cat-file check-ignore check-ref-format '
  + 'checkout cherry cherry-pick clean clone commit commit-tree config count-objects describe diff diff-files diff-index '
  + 'diff-tree fetch filter-branch filter-repo for-each-ref format-patch fsck gc grep hash-object help init log ls-files '
  + 'ls-remote ls-tree merge merge-base merge-file merge-tree mv name-rev notes prune pull push range-diff read-tree rebase '
  + 'reflog remote repack replace reset restore rev-list rev-parse revert rm shortlog show show-branch show-ref sparse-checkout '
  + 'stash status submodule switch symbolic-ref tag update-index update-ref var verify-commit version whatchanged worktree write-tree').split(' '));

function refTextPattern(main) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`refs/heads/(${esc(main)}|main)(?![\\w./-])|\\.git/refs|packed-refs`);
}

/** Does this simple command clear an agent-environment variable that tools/hooks/reference-transaction reads? */
function clearsAgentEnv(words) {
  const listed = (name) => AGENT_ENV_VARS.includes(name);
  if (words[0] === 'unset') return words.slice(1).some(listed);
  if (words[0] === 'export' || words[0] === 'declare' || words[0] === 'typeset') return words.slice(1).some((w) => /^[A-Za-z_]\w*=/.test(w) && listed(w.split('=')[0]));
  for (const w of words) {                                                     // CLAUDECODE= git …
    if (!/^[A-Za-z_]\w*=/.test(w)) break;
    if (listed(w.split('=')[0])) return true;
  }
  if (path.basename(words[0] || '') === 'env') {
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (w === '-i' || w === '--ignore-environment' || w === '-') return true;
      if ((w === '-u' || w === '--unset') && listed(words[i + 1])) return true;
      if (w.startsWith('--unset=') && listed(w.slice(8))) return true;
      if (/^-u./.test(w) && listed(w.slice(2))) return true;
      if (/^[A-Za-z_]\w*=/.test(w) && listed(w.split('=')[0])) return true;
    }
  }
  return false;
}

/** Command text that starts the Almagest CLI or the service — inside a nested shell too. */
const SERVICE_TEXT = /almagest\.mjs|\bnpx\s+(--\S+\s+)*almagest\b|\bnpm\s+(run(-script)?\s+)?serve\b|\bnpm\s+exec\s+(--\S+\s+)*almagest\b/;

/**
 * `almagest login …` as `node server/bin/almagest.mjs login`, `npx almagest
 * login`, a bin symlink, or inside `bash -c "…"` → the command as words, else
 * null. `connectors login` is a different command (a connector's OAuth) and passes.
 */
function signsIn(command, commands) {
  for (const words of commands) {
    const i = words.findIndex((w) => /^almagest(\.mjs)?$/.test(path.basename(w)));
    if (i === -1) continue;
    let j = i + 1;
    while (j < words.length && words[j].startsWith('-')) j += words[j] === '--repo' || words[j] === '--config' ? 2 : 1;
    if (words[j] === 'login') return words.slice(i, j + 1).join(' ');
  }
  const nested = command.match(/almagest(\.mjs)?["']?\s+(?:--(?:repo|config)[\s=]+\S+\s+)*login\b/);
  return nested ? nested[0] : null;
}

/**
 * The decision: `{ block, reason }`.
 * @param {object} input  Claude Code PreToolUse JSON for a Bash call
 */
export function guardGitDecision(input) {
  const command = String(input?.tool_input?.command || '');
  if (!command.trim()) return { block: false, reason: 'no command' };
  let cwd = path.resolve(input.cwd || process.cwd());
  const startRepo = repoAt(cwd);
  const refText = refTextPattern(startRepo?.main || 'main');

  const commands = splitCommands(command);
  const login = signsIn(command, commands || []);
  if (login) {
    return {
      block: true,
      reason: `Almagest: blocked — \`${login}\` mints an inbox sign-in link, which signs in as a person who can approve. `
        + 'Agents never approve (non-negotiable 1): the person runs `almagest login` in their own terminal.',
    };
  }
  if (!commands) {
    if (refText.test(command)) return unreadable(command.match(refText)[0]);
    return { block: false, reason: 'not parsed' };
  }

  const runsGit = /\bgit\b/.test(command);
  const runsService = SERVICE_TEXT.test(command) || commands.some((words) => words.some((w) => /^almagest(\.mjs)?$/.test(path.basename(w))));
  // Any program, not just git and the CLI: a renamed or wrapped bin is still a
  // way to run as a person, and no legitimate agent command needs it.
  if (commands.some(clearsAgentEnv)) {
    return {
      block: true,
      reason: `Almagest: blocked — this command clears an agent-environment variable before running ${runsGit ? 'git' : runsService ? 'the Almagest CLI' : 'a program'}. `
        + 'The reference-transaction hook and `almagest login` use those variables to tell an agent from a person, '
        + 'and only a person approves or moves main (non-negotiable 1); run it as you are.',
    };
  }
  if (runsGit && commands.some(injectsGitConfig)) {
    return {
      block: true,
      reason: 'Almagest: blocked — this command hands git configuration through GIT_CONFIG_COUNT / GIT_CONFIG_KEY_<n> / GIT_CONFIG_PARAMETERS, '
        + 'which can switch off the repository hooks (non-negotiable 7) without `git config`; run git as you are.',
    };
  }

  let simulatedBranch = null;   // set by an earlier `git switch|checkout <branch>` in the same command

  for (const words of commands) {
    if (words[0] === 'cd') { cwd = path.resolve(cwd, words[1] || process.env.HOME || '.'); simulatedBranch = null; continue; }

    // Nothing writes inside a git directory, on any branch: refs, packed-refs,
    // config and hooks there are what every other check stands on.
    const targets = writeTargets(words);
    const intoGit = targets.map((t) => realish(path.resolve(cwd, t)))
      .find((t) => insideGitDir(t, cwd) && !(path.basename(words[0] || '') === 'rm' && t.endsWith('.lock')));
    if (intoGit) {
      return {
        block: true,
        reason: `Almagest: blocked — \`${words[0]}\` would write ${intoGit}, inside a git directory. `
          + 'Refs, config and hooks there are what keeps wiki changes off main (non-negotiable 1); use git commands on an ingest branch instead.',
      };
    }

    const g = parseGit(words, cwd);
    if (!g) {
      // A command this guard cannot account for, naming a ref file: closed.
      const prog = path.basename(words.find((w) => !/^[A-Za-z_]\w*=/.test(w)) || '');
      const named = words.find((w) => refText.test(w));
      const unsafeFind = prog === 'find' && words.some((w) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(w));
      if (named && (!(READERS.has(prog) || prog === 'find') || unsafeFind)) return unreadable(named.match(refText)[0]);

      // Plain writers into the wiki while the checkout is on main.
      if (!targets.length) continue;
      const repo = repoAt(cwd);
      if (!repo) continue;
      const branch = simulatedBranch ?? repo.branch;
      if (branch !== repo.main) continue;
      const wiki = path.join(repo.top, repo.brainDir, 'wiki');
      // The wiki directory itself counts: `mv draft.md brain/wiki/` writes into it.
      const hit = targets.map((t) => realish(path.resolve(cwd, t))).find((t) => isInside(wiki, t));
      if (hit) return block(`\`${words[0]}\` would write ${path.relative(repo.top, hit)} on \`${repo.main}\``, repo.main);
      continue;
    }

    // An alias (`git -c alias.x='!…' x`, or one from config) runs what this guard cannot see.
    if (!GIT_SUBCOMMANDS.has(g.sub)) {
      const named = words.find((w) => refText.test(w));
      if (named) return unreadable(named.match(refText)[0]);
    }

    const repo = repoAt(g.cwd);
    if (!repo) continue;
    const branch = simulatedBranch ?? repo.branch;

    // A redirect out of a git command (`git show x:a.md > brain/wiki/a.md`) is a plain write.
    if (targets.length && branch === repo.main) {
      const wiki = path.join(repo.top, repo.brainDir, 'wiki');
      const hit = targets.map((t) => realish(path.resolve(cwd, t))).find((t) => isInside(wiki, t));
      if (hit) return block(`\`git ${g.sub}\` output would be written to ${path.relative(repo.top, hit)} on \`${repo.main}\``, repo.main);
    }

    // Skipping the hooks skips the pre-commit audit — on any branch.
    const runsHooks = ['commit', 'merge', 'push', 'cherry-pick', 'am', 'revert', 'rebase', 'pull'].includes(g.sub);
    const skipsHooks = runsHooks && (g.hooksDisabled
      || g.args.some((a) => a === '--no-verify' || (g.sub === 'commit' && (a === '-n' || clusterHas(a, 'n')))));
    if (skipsHooks) {
      return {
        block: true,
        reason: 'Almagest: blocked — this git command skips or switches off the repository hooks (`--no-verify`, `-n` or `-c core.hooksPath=`). '
          + 'The installed hooks run the audit that gates every commit (non-negotiable 7) and keep wiki changes off main; fix what they report instead.',
      };
    }
    const config = writesProtectedConfig(g);
    if (config) {
      return {
        block: true,
        reason: `Almagest: blocked — \`${config}\` writes git configuration an agent may not change: where the hooks live (core.hooksPath), `
          + 'Almagest\'s own almagest.* keys, config includes, or where branches are fetched from. '
          + 'The hooks keep wiki changes off main (non-negotiable 1); a person installs them with `node server/bin/almagest.mjs hooks install`.',
      };
    }
    const remote = newRemote(g);
    if (remote) {
      return {
        block: true,
        reason: `Almagest: blocked — \`${remote}\` adds a new place for branches to come from. Work from the remotes this clone already has; `
          + 'a person adds a remote in their own terminal.',
      };
    }

    // Moving main without a commit — on any branch.
    const moved = mainMove(g, repo, branch);
    if (moved) {
      return {
        block: true,
        reason: `Almagest: blocked — ${moved}. Only a person moves \`${repo.main}\`, by merging a reviewed diff (non-negotiable 1): `
          + 'work on an ingest branch (`git switch -c ingest/<source-slug>-<sha7>`) and leave main to the review.',
      };
    }

    if (g.sub === 'switch' || g.sub === 'checkout') {
      const createFlag = g.args.findIndex((a) => a === '-b' || a === '-B' || a === '-c' || a === '-C' || a === '--orphan');
      if (createFlag !== -1) { simulatedBranch = g.args[createFlag + 1] || simulatedBranch; continue; }
      const target = g.args.find((a) => !a.startsWith('-'));
      if (target && !g.args.includes('--')) {
        try { git(repo.top, ['show-ref', '--verify', '--quiet', `refs/heads/${target}`]); simulatedBranch = target; }
        catch { /* a path, a detached commit, or unknown — leave the branch as it is */ }
      }
      continue;
    }

    if (!['commit', 'merge', 'cherry-pick', 'revert', 'am', 'stash'].includes(g.sub)) continue;
    if (branch !== repo.main) continue;
    const paths = affectedPaths(repo, g.sub, g.args);
    if (!paths) continue;   // could not tell — open
    const wiki = paths.filter((p) => p.startsWith(`${repo.brainDir}/wiki/`));
    if (wiki.length) {
      const what = g.sub === 'stash' ? `git stash ${g.args[0]}` : `git ${g.sub}`;
      return block(`\`${what}\` on \`${repo.main}\` would bring ${wiki.slice(0, 3).join(', ')}${wiki.length > 3 ? ', …' : ''} into the wiki`, repo.main);
    }
  }
  return { block: false, reason: 'allowed' };
}

function block(what, main) {
  return {
    block: true,
    reason: `Almagest: blocked — ${what}. Nothing writes to brain/wiki/ on \`${main}\` (non-negotiable 1): `
      + 'work on an ingest branch (`git switch -c ingest/<source-slug>-<sha7>`) and let a person merge the reviewed diff.',
  };
}

function unreadable(what) {
  return {
    block: true,
    reason: `Almagest: blocked — this command names \`${what}\` in a form the guard cannot follow (a nested shell, an interpreter, a script). `
      + 'Refs are changed with plain git commands on an ingest branch, never by writing them; main moves only by a reviewed merge (non-negotiable 1).',
  };
}
