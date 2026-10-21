/**
 * git-hooks.mjs — what the code needs to know about the git hooks: how to
 * install them, whether a clone has them installed, which environment counts
 * as an agent's, and how the service tells the reference-transaction hook
 * that a move of `main` is the reviewed one.
 *
 *   renderHooks(repoRoot)      → { main, brainDir, dir, hooks: { name: text } }
 *   installHooks(repoRoot)     → { main, brainDir, dir, written[] }      (`almagest hooks install`)
 *   hooksInstalled(repoRoot)   → { ok, hooksPath, expected, problems[] }   (doctor)
 *   isAgentEnv(env)            → true when env carries an agent marker
 *   authorizeMainMove(repoRoot, { ref, oldSha, newSha }) → release()      (merge.mjs)
 *
 * The hooks git runs are NOT tools/hooks/ in the working tree. A checkout
 * rewrites every tracked file, so hooks run from the working tree are whatever
 * the branch checked out says they are — a branch could ship a pre-commit that
 * moves main itself. `installHooks` takes them from main as committed (the
 * reviewed version), bakes in the main branch name and brain_dir from main's
 * committed brain.config.yaml, writes them to `<git-common-dir>/almagest/hooks/`
 * and points `core.hooksPath` there. Nothing a checkout writes reaches that
 * directory, and writing into a git dir is what the Claude Code guards refuse.
 *
 * Plain Node plus `yaml`, like tools/lib/config.mjs: the Claude Code hooks
 * import this without the app.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/** The hooks `almagest hooks install` puts in place. */
export const HOOKS = ['pre-commit', 'reference-transaction'];

/** What doctor tells a person to run. */
export const INSTALL_COMMAND = 'node server/bin/almagest.mjs hooks install';

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

/** A blob as committed, byte for byte. `git replace` stand-ins are ignored: an agent could plant one for main's hook. */
function committedBlob(cwd, spec) {
  return execFileSync('git', ['cat-file', 'blob', spec], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });
}

function commonDir(repoRoot) {
  return fs.realpathSync(git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

/** `<git-common-dir>/almagest/hooks` — absolute, shared by every worktree of the clone. */
export function hooksDir(repoRoot) {
  return path.join(commonDir(repoRoot), 'almagest', 'hooks');
}

/** Values baked into a hook become shell string literals; keep them to characters that need no quoting. */
const SAFE = /^[A-Za-z0-9._/-]+$/;

/** Replace the one `NAME="…"` line for each key; a hook without the line predates `hooks install`. */
function bake(text, hook, main, values) {
  let out = text;
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^${key}="[^"\\n]*"$`, 'gm');
    const hits = out.match(re) || [];
    if (hits.length !== 1) {
      throw new Error(`${main}:tools/hooks/${hook} has ${hits.length ? 'more than one' : 'no'} ${key}="…" line — `
        + `it predates \`almagest hooks install\`; merge the current tools/hooks/ into ${main} first`);
    }
    out = out.replace(re, `${key}="${value}"`);
  }
  return out;
}

/**
 * The hooks as `installHooks` would write them, built only from what is
 * committed on main. The branch name comes from the working tree's
 * brain.config.yaml (that is how the service finds it too) but must match what
 * main's own committed config says, so a working-tree edit cannot point the
 * install at another branch. Throws with a sentence a person can act on.
 */
export function renderHooks(repoRoot) {
  let main = 'main';
  try {
    const wt = YAML.parse(fs.readFileSync(path.join(repoRoot, 'brain.config.yaml'), 'utf-8')) || {};
    main = String(wt.service?.git?.main || 'main');
  } catch { /* defaults */ }
  if (!SAFE.test(main)) throw new Error(`service.git.main "${main}" is not a plain branch name`);
  try { git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${main}^{commit}`]); }
  catch { throw new Error(`no local branch "${main}" (service.git.main) to install the hooks from`); }

  let committed = {};
  let text = null;
  try { text = committedBlob(repoRoot, `refs/heads/${main}:brain.config.yaml`); } catch { /* none committed: the defaults */ }
  if (text !== null) {
    try { committed = YAML.parse(text) || {}; }
    catch (err) { throw new Error(`${main}'s committed brain.config.yaml does not parse: ${err.message.split('\n')[0]}`); }
  }
  const committedMain = String(committed.service?.git?.main || 'main');
  if (committedMain !== main) {
    throw new Error(`brain.config.yaml names "${main}" as the main branch, but ${main}'s committed brain.config.yaml names "${committedMain}" — `
      + 'commit the change on main through review, or undo it in the working tree');
  }
  const brainDir = String(committed.brain_dir || 'brain').replace(/\/+$/, '') || 'brain';
  if (!SAFE.test(brainDir)) throw new Error(`brain_dir "${brainDir}" on ${main} is not a plain path`);

  const hooks = {};
  for (const hook of HOOKS) {
    let text;
    try { text = committedBlob(repoRoot, `refs/heads/${main}:tools/hooks/${hook}`); }
    catch { throw new Error(`${main} has no tools/hooks/${hook} committed`); }
    hooks[hook] = bake(text, hook, main, { MAIN_BRANCH: main, BRAIN_DIR: brainDir });
  }
  return { main, brainDir, dir: hooksDir(repoRoot), hooks };
}

/** Remove a symlink standing where a directory of ours should be — it would send our writes elsewhere. */
function realDir(dir) {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) fs.rmSync(dir, { force: true });
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * `almagest hooks install`: write main's hooks into the git dir, executable,
 * and point core.hooksPath at them. Write-if-changed; a file is replaced by
 * rename, so a symlink planted in its place is replaced, not followed.
 */
export function installHooks(repoRoot) {
  const { main, brainDir, dir, hooks } = renderHooks(repoRoot);
  realDir(path.dirname(dir));
  realDir(dir);
  const written = [];
  for (const [name, text] of Object.entries(hooks)) {
    const file = path.join(dir, name);
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    const same = st?.isFile() && fs.readFileSync(file, 'utf-8') === text;
    if (!same) {
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, text, { mode: 0o755 });
      fs.renameSync(tmp, file);
      written.push(name);
    }
    fs.chmodSync(file, 0o755);
  }
  git(repoRoot, ['config', 'core.hooksPath', dir]);
  return { main, brainDir, dir, written };
}

/**
 * Is `core.hooksPath` exactly `<git-common-dir>/almagest/hooks`, and is every
 * hook there executable and byte-identical to what `installHooks` would write
 * from main now? A hook that differs is "outdated" — main's tools/hooks or
 * its brain.config.yaml changed since the install, or someone edited it.
 * `problems` says what to fix, in words a doctor can print. Never throws.
 */
export function hooksInstalled(repoRoot) {
  const problems = [];
  const fix = `run \`${INSTALL_COMMAND}\``;
  let hooksPath = '';
  let expected = '';
  try { expected = hooksDir(repoRoot); }
  catch { return { ok: false, hooksPath, expected, problems: [`${repoRoot} is not a git repository`] }; }
  try { hooksPath = git(repoRoot, ['config', '--get', 'core.hooksPath']); } catch { /* unset */ }
  if (!hooksPath) problems.push(`core.hooksPath is not set — ${fix}`);
  else if (hooksPath !== expected) problems.push(`core.hooksPath is ${hooksPath}, not ${expected} — ${fix}`);

  for (const dir of [path.dirname(expected), expected]) {
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) problems.push(`${dir} is not a directory — ${fix}`);
  }

  let rendered = null;
  try { rendered = renderHooks(repoRoot).hooks; }
  catch (err) { problems.push(`cannot build the hooks from main: ${err.message}`); }

  for (const hook of HOOKS) {
    const file = path.join(expected, hook);
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!st) { problems.push(`${hook} is not installed — ${fix}`); continue; }
    if (!st.isFile()) { problems.push(`${hook} in ${expected} is not a regular file — ${fix}`); continue; }
    if (rendered && fs.readFileSync(file, 'utf-8') !== rendered[hook]) {
      problems.push(`${hook} is outdated — it differs from what main's tools/hooks/${hook} installs; ${fix}`);
    }
    try { fs.accessSync(file, fs.constants.X_OK); }
    catch { problems.push(`${hook} is not executable — ${fix}`); }
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
