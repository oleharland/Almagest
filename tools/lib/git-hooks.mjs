/**
 * git-hooks.mjs — what the code needs to know about the git hooks in
 * tools/hooks/: whether a clone has them installed, which environment counts
 * as an agent's, and how the service tells the reference-transaction hook
 * that a move of `main` is the reviewed one.
 *
 *   hooksInstalled(repoRoot)   → { ok, hooksPath, expected, problems[] }   (doctor)
 *   isAgentEnv(env)            → true when env carries an agent marker
 *   authorizeMainMove(repoRoot, { ref, oldSha, newSha }) → release()      (merge.mjs)
 *
 * Plain Node, no dependencies: the Claude Code hooks import this without the
 * app, the same way they import tools/lib/config.mjs.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The hooks `core.hooksPath tools/hooks` must make git run. */
export const HOOKS = ['pre-commit', 'reference-transaction'];

/**
 * Variables an agent harness sets in the environment of the commands it runs.
 * tools/hooks/reference-transaction carries the same list (a test keeps them
 * in step). Configuration variables a person exports in their own shell
 * profile — CLAUDE_CODE_USE_BEDROCK, CODEX_HOME — are deliberately NOT here:
 * the hook must not block a human merging by hand in their own terminal.
 */
export const AGENT_ENV_VARS = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',                 // Claude Code
  'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED',      // Codex CLI
  'CODEX_MANAGED_BY_NPM', 'CODEX_THREAD_ID',
  'GEMINI_CLI',                                           // Gemini CLI
  'CURSOR_AGENT',                                         // Cursor agent
  'OPENCODE',                                             // opencode
  'AI_AGENT',                                             // the cross-harness convention
  'ALMAGEST_RUNNER',                                      // the service's own headless agent
  'ALMAGEST_AGENT',                                       // opt-in for any other harness
];

export function isAgentEnv(env = process.env) {
  return AGENT_ENV_VARS.some((k) => env[k] !== undefined && env[k] !== '');
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim();
}

/**
 * Is `core.hooksPath` set to this clone's tools/hooks, and is every hook in
 * HOOKS there and executable? `problems` says what to fix, in words a doctor
 * can print. Never throws.
 */
export function hooksInstalled(repoRoot) {
  const expected = path.join(repoRoot, 'tools', 'hooks');
  const problems = [];
  let hooksPath = '';
  try { hooksPath = git(repoRoot, ['config', '--get', 'core.hooksPath']); } catch { /* unset */ }
  const fix = `run \`git config core.hooksPath "${expected}"\``;
  if (!hooksPath) {
    problems.push(`core.hooksPath is not set — ${fix}`);
  } else {
    // git resolves a relative hooksPath against the top of the working tree —
    // except for the hooks of a push into this repository, which run in
    // $GIT_DIR, where `tools/hooks` names nothing. `git push . x:main` would
    // then pass the reference-transaction hook unseen, so relative is a problem.
    let top = repoRoot;
    try { top = git(repoRoot, ['rev-parse', '--show-toplevel']); } catch { /* keep repoRoot */ }
    const expanded = hooksPath.replace(/^~(?=\/|$)/, process.env.HOME || '~');
    const resolved = path.resolve(top, expanded);
    const same = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); } };
    if (!same(resolved, expected)) problems.push(`core.hooksPath is ${hooksPath}, not tools/hooks — ${fix}`);
    else if (!path.isAbsolute(expanded)) problems.push(`core.hooksPath is relative (${hooksPath}); a push into this repository runs its hooks from .git/, where that path does not resolve — ${fix}`);
  }
  for (const hook of HOOKS) {
    const file = path.join(expected, hook);
    if (!fs.existsSync(file)) { problems.push(`tools/hooks/${hook} is missing`); continue; }
    try { fs.accessSync(file, fs.constants.X_OK); }
    catch { problems.push(`tools/hooks/${hook} is not executable — run \`chmod +x tools/hooks/${hook}\``); }
  }
  return { ok: problems.length === 0, hooksPath, expected, problems };
}

/** Where the service leaves its one-shot authorization. Inside the git dir, which no agent tool may write to. */
export function mainMoveAuthPath(repoRoot) {
  const common = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return path.join(common, 'almagest', 'main-move');
}

/**
 * The service's half of the reference-transaction hook. Before it moves main
 * by compare-and-swap, the service writes `<oldSha> <newSha> <ref>` into the
 * git dir; the hook lets an agent-environment update through only when it is
 * exactly that transition and the file is a few minutes old at most. Call the
 * returned function once the move is done, whatever happened.
 *
 * This is not a secret — an agent that can write into .git/ can forge it, but
 * such an agent can write .git/refs/heads/main directly too. It adds no new
 * way past the hook; it only stops the hook from blocking the service when
 * the service itself was started from inside an agent session.
 */
export function authorizeMainMove(repoRoot, { ref, oldSha, newSha }) {
  let file;
  try {
    file = mainMoveAuthPath(repoRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${oldSha} ${newSha} ${ref}\n`);
  } catch {
    return () => {};   // the move then stands or falls on the hook alone
  }
  return () => { try { fs.rmSync(file, { force: true }); } catch { /* gone already */ } };
}
