/**
 * hooks.mjs — `almagest hook <name>`, the Claude Code hooks. Spec → Hooks.
 *
 * All three run without the app: no database, no git worktrees, nothing that
 * could make a tool call wait. They read the hook's JSON from stdin, decide,
 * and exit.
 *
 *   guard-wiki   PreToolUse Write|Edit|MultiEdit   exit 2 = block
 *   guard-git    PreToolUse Bash                   exit 2 = block (guard-git.mjs)
 *   enqueue      PostToolUse Write                 always exit 0
 *   status       SessionStart                      always exit 0, stdout = context
 *
 * `guard-wiki` is the mechanical half of non-negotiable 1, and it fails closed
 * for exactly one case: the target resolves under a `brain/wiki/` whose
 * checkout is on `main`. Any OTHER error — unreadable stdin, no git, a path
 * that is not in a repo — allows the edit. A guard that blocks on its own bugs
 * gets uninstalled, and then it guards nothing.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../../tools/lib/config.mjs';
import { isIngestCandidate, isInside, realish } from './source.mjs';
import { guardGitDecision } from './guard-git.mjs';
import { writeSpool } from './spool.mjs';

/** stdin as JSON, or {} — a hook run by hand from a terminal has no stdin to wait for. */
export async function readHookInput(stream = process.stdin, timeoutMs = 2000) {
  if (stream.isTTY) return {};
  const chunks = [];
  const done = new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => { clearTimeout(t); resolve(); });
    stream.on('error', () => { clearTimeout(t); resolve(); });
  });
  await done;
  stream.pause?.();
  try { return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); } catch { return {}; }
}

/** The file a Write / Edit / MultiEdit / NotebookEdit call targets, absolute. */
export function targetPath(input) {
  const ti = input?.tool_input || {};
  const p = ti.file_path || ti.notebook_path || ti.path;
  if (!p) return '';
  return path.resolve(input.cwd || process.cwd(), String(p));
}

function gitOut(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
}

function brainSettings(top) {
  try {
    const cfg = loadConfig(top);
    return { brainDir: cfg.brainDir.replace(/\/+$/, ''), main: String(cfg.raw.service?.git?.main || 'main') };
  } catch {
    return { brainDir: 'brain', main: 'main' };
  }
}

/**
 * The guard decision, pure enough to test: `{ block, reason }`.
 * `block` is true only when the target is under `<brain_dir>/wiki/` of its
 * own checkout and that checkout is on the main branch.
 */
export function guardWikiDecision(input) {
  const file = targetPath(input);
  if (!file) return { block: false, reason: 'no target path' };
  let dir = path.dirname(realish(file));
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  let top;
  try { top = realish(gitOut(dir, ['rev-parse', '--show-toplevel'])); }
  catch { return { block: false, reason: 'not in a git checkout' }; }

  const { brainDir, main } = brainSettings(top);
  const wiki = path.join(top, brainDir, 'wiki');
  const real = realish(file);
  if (!isInside(wiki, real) || real === wiki) return { block: false, reason: 'not under the wiki' };

  let branch = '';
  try { branch = gitOut(top, ['symbolic-ref', '--quiet', '--short', 'HEAD']); }
  catch { return { block: false, reason: 'detached HEAD — not main' }; }
  if (branch !== main) return { block: false, reason: `on ${branch}` };

  const rel = path.relative(top, real);
  return {
    block: true,
    reason: `Almagest: blocked — ${rel} is in the wiki and this checkout is on \`${main}\`. `
      + 'Nothing writes to brain/wiki/ on main (non-negotiable 1). Create the ingest branch first '
      + '(`git switch -c ingest/<source-slug>-<sha7>`), or drop the source into brain/raw/ and let the '
      + 'background runner propose it.',
  };
}

async function postJson(url, body, token, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getJson(url, token, timeoutMs) {
  const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function serviceSettings(repoRoot, configPath) {
  // The full service config loader would do, but it is the one import a hook
  // can avoid: read the two keys straight from the v1 parse.
  try {
    const raw = loadConfig(repoRoot, configPath).raw;
    const http = raw.service?.http || {};
    const host = http.host || '127.0.0.1';
    const port = http.port || 4747;
    return {
      baseUrl: String(process.env.ALMAGEST_URL || http.base_url || `http://${host}:${port}`).replace(/\/+$/, ''),
      localPath: String(raw.sources?.local?.path || 'brain/raw'),
    };
  } catch {
    return { baseUrl: String(process.env.ALMAGEST_URL || 'http://127.0.0.1:4747'), localPath: 'brain/raw' };
  }
}

/**
 * `{ action: 'ignored' | 'posted' | 'spooled', reason?, file? }`. The file must
 * be under THIS repo's drop folder — a hook in a session working inside an
 * ingest worktree must not feed the worktree's own writes back into the queue.
 */
export async function enqueueFromHook(input, { repoRoot, configPath, timeoutMs = 1500 } = {}) {
  if (process.env.ALMAGEST_RUNNER === '1') return { action: 'ignored', reason: 'inside the ingest runner' };
  const file = targetPath(input);
  if (!file) return { action: 'ignored', reason: 'no target path' };
  const { baseUrl, localPath } = serviceSettings(repoRoot, configPath);
  const root = realish(path.resolve(repoRoot, localPath));
  const real = realish(file);
  if (!isInside(root, real) || real === root) return { action: 'ignored', reason: 'not in the drop folder' };
  if (isInside(realish(path.join(repoRoot, '.almagest')), real)) return { action: 'ignored', reason: 'service state' };
  if (!isIngestCandidate(path.relative(root, real))) return { action: 'ignored', reason: 'not an ingest candidate' };

  const rel = path.relative(realish(repoRoot), real).split(path.sep).join('/');
  try {
    const job = await postJson(`${baseUrl}/api/jobs`, { path: rel, trigger: 'hook' }, process.env.ALMAGEST_TOKEN, timeoutMs);
    return { action: 'posted', job: job?.id || job?.job?.id, file: rel };
  } catch (err) {
    const spooled = writeSpool(path.join(repoRoot, '.almagest', 'spool'), { path: rel, trigger: 'hook', error: err.message });
    return { action: 'spooled', file: spooled, reason: err.message };
  }
}

const count = (v) => (Array.isArray(v) ? v.length : Array.isArray(v?.items) ? v.items.length : Array.isArray(v?.proposals) ? v.proposals.length : Array.isArray(v?.decisions) ? v.decisions.length : Number(v?.count ?? NaN));

/** The SessionStart line, or '' when the service is not up. Never throws. */
export async function statusLine({ repoRoot, configPath, timeoutMs = 1000 } = {}) {
  const { baseUrl } = serviceSettings(repoRoot, configPath);
  const token = process.env.ALMAGEST_TOKEN;
  let proposals;
  try { proposals = await getJson(`${baseUrl}/api/proposals?status=open`, token, timeoutMs); }
  catch { return ''; }
  const open = count(proposals);
  let decisions = NaN;
  try { decisions = count(await getJson(`${baseUrl}/api/decisions?status=open`, token, timeoutMs)); }
  catch {
    const list = proposals?.items || proposals?.proposals || (Array.isArray(proposals) ? proposals : []);
    if (list.every((p) => Array.isArray(p.openDecisions))) decisions = list.reduce((n, p) => n + p.openDecisions.length, 0);
  }
  if (!Number.isFinite(open)) return '';
  const parts = [`${open} open proposal${open === 1 ? '' : 's'}`];
  if (Number.isFinite(decisions)) parts.push(`${decisions} open decision${decisions === 1 ? '' : 's'}`);
  return `Almagest: ${parts.join(', ')} awaiting review — ${baseUrl}/inbox`;
}

export const hookCommand = {
  summary: 'Claude Code hooks: guard-wiki | guard-git | enqueue | status',
  needsApp: false,
  async run(argv, env) {
    const [name] = argv;
    if (name === 'guard-wiki') {
      let decision;
      try { decision = guardWikiDecision(await readHookInput()); }
      catch { return 0; }   // fail open on the guard's own errors — see the header
      if (decision.block) { process.stderr.write(`${decision.reason}\n`); return 2; }
      return 0;
    }
    if (name === 'guard-git') {
      let decision;
      try { decision = guardGitDecision(await readHookInput()); }
      catch { return 0; }   // fail open on the guard's own errors
      if (decision.block) { process.stderr.write(`${decision.reason}\n`); return 2; }
      return 0;
    }
    if (name === 'enqueue') {
      try {
        const r = await enqueueFromHook(await readHookInput(), { repoRoot: env.repoRoot, configPath: env.configPath });
        if (r.action === 'spooled') process.stderr.write(`almagest: service not reachable (${r.reason}) — spooled for the next start\n`);
      } catch { /* a PostToolUse hook never fails the session */ }
      return 0;
    }
    if (name === 'status') {
      try {
        await readHookInput(process.stdin, 300);
        const line = await statusLine({ repoRoot: env.repoRoot, configPath: env.configPath });
        if (line) process.stdout.write(`${line}\n`);
      } catch { /* SessionStart must never fail */ }
      return 0;
    }
    // Exit 1, not 2: in a PreToolUse slot exit 2 means "block", and a typo in
    // settings.json should not block every edit.
    process.stderr.write('usage: almagest hook <guard-wiki | guard-git | enqueue | status>  (reads Claude Code hook JSON on stdin)\n');
    return 1;
  },
};
