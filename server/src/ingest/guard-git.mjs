/**
 * guard-git.mjs — `almagest hook guard-git`, the Bash half of the wiki guard.
 *
 * `guard-wiki` stops a Write/Edit tool call into brain/wiki/ on main. A
 * session can reach the same place through Bash instead: `git commit`,
 * `git merge ingest/x`, `git cherry-pick`, `git am`, `git stash pop`, or
 * plainly `cp draft.md brain/wiki/`. This hook reads the command Claude Code
 * is about to run and blocks (exit 2) when, on the main branch, it would put
 * a brain/wiki/ change into main or into main's working tree — and, on any
 * branch, when it would skip the commit hooks (`--no-verify`,
 * `-c core.hooksPath=…`), since the pre-commit audit is non-negotiable 7.
 *
 * It parses shell the way a careful reader would, not the way bash does:
 * `&&` / `||` / `;` / `|` / newlines split commands, quotes group words, and
 * `cd <dir>` and `git switch|checkout <branch>` earlier in the same command
 * are followed, so `git switch main && git merge ingest/x` is judged on main.
 * What it cannot follow — `bash -c "…"`, a script, `eval` — it allows. The
 * principle is the same as guard-wiki: fail closed only on the clear case,
 * open on everything else, because a guard that blocks on its own parse bugs
 * gets uninstalled. `tools/hooks/pre-commit` is the backstop under it.
 *
 * A human typing in their own terminal is not affected — Claude Code hooks
 * only see Claude Code's tool calls, and a human merge is the gate anyway.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../../tools/lib/config.mjs';
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
      if (/^core\.hookspath=/i.test(words[i + 1] || '')) hooksDisabled = true;
      i += 2; continue;
    }
    if (/^-c/.test(w) && /core\.hookspath=/i.test(w)) { hooksDisabled = true; i++; continue; }
    if (GLOBAL_WITH_VALUE.has(w)) { i += 2; continue; }
    i++;
  }
  return { cwd: dir, sub: words[i] || '', args: words.slice(i + 1), hooksDisabled };
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

/** Commands that write their last argument(s) / redirect targets. Best effort; anything else is not a write. */
function writeTargets(words) {
  const targets = [];
  for (let i = 0; i < words.length; i++) if (words[i] === '>' && words[i + 1]) targets.push(words[i + 1]);
  const cmd = path.basename(words[0] || '');
  const args = words.slice(1).filter((w, i, a) => w !== '>' && a[i - 1] !== '>');
  const operands = args.filter((a) => !a.startsWith('-'));
  if (['cp', 'mv', 'rsync', 'ln', 'install'].includes(cmd) && operands.length >= 2) targets.push(operands[operands.length - 1]);
  if (['tee', 'touch', 'rm', 'truncate'].includes(cmd)) targets.push(...operands);
  if (cmd === 'sed' && args.some((a) => a === '-i' || a.startsWith('-i') || a === '--in-place')) targets.push(...operands.slice(1));
  return targets;
}

/**
 * The decision: `{ block, reason }`.
 * @param {object} input  Claude Code PreToolUse JSON for a Bash call
 */
export function guardGitDecision(input) {
  const command = String(input?.tool_input?.command || '');
  if (!command.trim()) return { block: false, reason: 'no command' };
  const commands = splitCommands(command);
  if (!commands) return { block: false, reason: 'not parsed' };

  let cwd = path.resolve(input.cwd || process.cwd());
  let simulatedBranch = null;   // set by an earlier `git switch|checkout <branch>` in the same command

  for (const words of commands) {
    if (words[0] === 'cd') { cwd = path.resolve(cwd, words[1] || process.env.HOME || '.'); simulatedBranch = null; continue; }

    const g = parseGit(words, cwd);
    if (!g) {
      // Plain writers into the wiki while the checkout is on main.
      const targets = writeTargets(words);
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

    const repo = repoAt(g.cwd);
    if (!repo) continue;

    // Skipping the hooks skips the pre-commit audit — on any branch.
    const runsHooks = ['commit', 'merge', 'push', 'cherry-pick', 'am', 'revert', 'rebase', 'pull'].includes(g.sub);
    const skipsHooks = runsHooks && (g.hooksDisabled
      || g.args.some((a) => a === '--no-verify' || (g.sub === 'commit' && (a === '-n' || clusterHas(a, 'n')))));
    if (skipsHooks) {
      return {
        block: true,
        reason: 'Almagest: blocked — this git command skips the repository hooks (`--no-verify`, `-n` or `-c core.hooksPath=`). '
          + 'tools/hooks/pre-commit runs the audit that gates every commit (non-negotiable 7); fix what it reports instead.',
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
    const branch = simulatedBranch ?? repo.branch;
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
