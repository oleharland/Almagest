/**
 * merge.mjs — the one place in the service that moves `main`.
 *
 * Called by governance only after the policy engine says a proposal is ready.
 * Everything happens in git plumbing so no checkout is touched until the very
 * last step:
 *
 *   1. `git merge-tree --write-tree main head`     the merge, computed in memory
 *   2. bookkeeping conflicts are resolved mechanically (bookkeeping.mjs): the
 *      manifest by a structured merge of `sources[]` by id; log.md, index.md
 *      and the challenges ledger when both sides only added rows (template
 *      placeholder rows either side replaced are dropped first); the derived
 *      index (brain/.index/) is regenerated. Any other conflict → `conflicted`.
 *   3. `brain/log.md` gets the approval row (temporary GIT_INDEX_FILE)
 *   4. `commit-tree` with parents (main, head): author = the approving human,
 *      committer = svc:governance
 *   5. re-audit the merge result in a throwaway detached worktree with the
 *      SERVICE'S OWN tools/audit.mjs — exit ≠ 0 → main does not move
 *   6. check, once more, that the branch diff AND the merge result touch only
 *      the knowledge base's writable files (paths.mjs) — nothing else moves main
 *   7. move main by compare-and-swap: `merge --ff-only` inside the worktree
 *      that has main checked out, else `update-ref main <new> <old>`
 *
 * Merges are serialised by the caller's mutex; the CAS covers everyone else.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { authorizeMainMove } from '../../../tools/lib/git-hooks.mjs';
import { serviceActor } from '../core/auth.mjs';
import { gitIdentity } from '../core/git.mjs';
import { mergeManifest, stripRemovedPlaceholders } from './bookkeeping.mjs';
import { describeOutside, listChanges, outsideFiles } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The audit that gates merges is this checkout's — never one inside a worktree an agent wrote to. */
export const AUDIT_SCRIPT = path.resolve(HERE, '..', '..', '..', 'tools', 'audit.mjs');

/** Run `fn`s one at a time, in call order. */
export function createMutex() {
  let tail = Promise.resolve();
  return function lock(fn) {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}

/** execFile that resolves with the exit code instead of rejecting on it. */
function execp(cmd, args, { cwd, env, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && typeof err.code !== 'number' ? err.message : '') });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Normalise the runner's audit summary or raw `tools/audit.mjs --json` output. */
export function normalizeAudit(audit) {
  if (!audit) return { exit: null, errors: 0, warnings: 0, findings: [] };
  const counts = audit.counts || {};
  const exit = typeof audit.exit === 'number' ? audit.exit : typeof audit.ok === 'boolean' ? (audit.ok ? 0 : 1) : null;
  return {
    exit,
    errors: Number(audit.errors ?? counts.errors ?? 0),
    warnings: Number(audit.warnings ?? counts.warnings ?? 0),
    findings: Array.isArray(audit.findings) ? audit.findings.slice(0, 200) : [],
  };
}

export async function runAudit(repoDir, { script = AUDIT_SCRIPT } = {}) {
  const r = await execp(process.execPath, [script, '--json', '--no-color', '--repo', repoDir]);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* exit 2 prints no JSON */ }
  const out = normalizeAudit(parsed ? { ...parsed, exit: r.code } : { exit: r.code });
  if (!parsed) out.error = r.stderr.trim().slice(0, 1000) || 'the audit produced no report';
  return out;
}

export async function runAuditIndex(repoDir, { script = AUDIT_SCRIPT } = {}) {
  return execp(process.execPath, [script, 'index', '--no-color', '--repo', repoDir]);
}

// ── text helpers (pure) ──────────────────────────────────────────────────────

const DEFAULT_LOG = `---
title: "Audit Log"
type: system
---

# Log

Chronological record of all ingest, audit, and maintenance actions.

| Date | Action | Details |
|------|--------|---------|
`;

const cell = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

export function logRow({ date, proposal, approvers }) {
  const who = approvers.map((a) => `${a.display || a.actorId} (${a.channel})`).join(', ') || 'unknown';
  const pages = (proposal.changes || []).filter((c) => c.pageStatus !== 'rejected').map((c) => c.slug).join(', ') || 'none';
  return `| ${cell(date)} | merge | ${cell(proposal.id)} ${cell(proposal.title)} — approved by ${cell(who)}; reviewed ${cell(String(proposal.headSha).slice(0, 7))}; pages: ${cell(pages)} |`;
}

export function appendLogRow(text, row) {
  const base = text === null || text === undefined ? DEFAULT_LOG : String(text);
  return `${base.replace(/\n*$/, '\n')}${row}\n`;
}

/** In diff3 output, did every conflict hunk have an empty base? (both sides only added lines) */
export function onlyInsertions(diff3) {
  let state = 'outside';
  for (const line of String(diff3).split('\n')) {
    if (line.startsWith('<<<<<<< ')) { state = 'ours'; continue; }
    if (state === 'ours' && line.startsWith('||||||| ')) { state = 'base'; continue; }
    if ((state === 'ours' || state === 'base') && line === '=======') { state = 'theirs'; continue; }
    if (state === 'theirs' && line.startsWith('>>>>>>> ')) { state = 'outside'; continue; }
    if (state === 'base') return false;
  }
  return true;
}

// ── the merger ───────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {object} deps.git       core git helpers
 * @param {object} deps.config    loadServiceConfig() result
 * @param {object} [deps.log]
 * @param {string} [deps.auditScript]
 */
export function createMerger({ git, config, log, allowed, auditScript = AUDIT_SCRIPT }) {
  if (typeof allowed !== 'function') throw new Error('createMerger needs the writable-path matcher (paths.mjs)');
  const main = config.service.git.main;
  const brainDir = config.v1.brainDir;
  const logPath = `${brainDir}/log.md`;
  const indexDir = config.v1.indexDir.replace(/\/+$/, '');
  const appendOnly = new Set([logPath, `${brainDir}/index.md`, config.v1.manifestPath, config.v1.challengesPath]);
  const committer = gitIdentity(serviceActor('governance'));
  const gitx = (args, opts = {}) => execp('git', args, { cwd: git.repoRoot, ...opts });

  async function mergeTree(ours, theirs) {
    const r = await gitx(['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs]);
    if (r.code !== 0 && r.code !== 1) throw new Error(`git merge-tree failed: ${r.stderr.trim()}`);
    const lines = r.stdout.split('\n').filter(Boolean);
    return { tree: lines[0], conflicts: r.code === 1 ? [...new Set(lines.slice(1))] : [] };
  }

  async function unionResolve(file, base, ours, theirs) {
    const [b0, o0, t0] = await Promise.all([git.show(base, file), git.show(ours, file), git.show(theirs, file)]);
    if (o0 === null || t0 === null) return null;   // modify/delete — a person has to decide
    if (file === config.v1.manifestPath) return mergeManifest(b0, o0, t0);
    const [b, o, t] = stripRemovedPlaceholders(b0, o0, t0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-union-'));
    try {
      const [fo, fb, ft] = ['ours', 'base', 'theirs'].map((n) => path.join(dir, n));
      fs.writeFileSync(fo, o);
      fs.writeFileSync(fb, b ?? '');
      fs.writeFileSync(ft, t);
      const d3 = await gitx(['merge-file', '-p', '--diff3', fo, fb, ft]);
      if (d3.code === 0) return d3.stdout;
      if (d3.code < 0 || !onlyInsertions(d3.stdout)) return null;
      const u = await gitx(['merge-file', '-p', '--union', fo, fb, ft]);
      return u.code >= 0 ? u.stdout : null;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async function treeWith(tree, files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-index-'));
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    try {
      await git.run(['read-tree', tree], { env });
      for (const [file, content] of files) {
        const blob = (await git.run(['hash-object', '-w', '--stdin'], { input: content })).trim();
        await git.run(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env });
      }
      return (await git.run(['write-tree'], { env })).trim();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async function commitTree(tree, parents, message, author) {
    const env = {
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email,
    };
    return (await git.run(['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], { env })).trim();
  }

  /**
   * Check out `commit` detached in a temp dir, regenerate the derived index if
   * the brain has one, and audit it. Returns the (possibly re-made) commit.
   */
  async function verify(commit, { parents, message, author }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-merge-'));
    let final = commit;
    try {
      await git.run(['worktree', 'add', '--detach', '--force', dir, commit]);
      const hasIndex = (await git.tryRun(['cat-file', '-e', `${commit}:${indexDir}`])) !== null;
      if (hasIndex) {
        const r = await runAuditIndex(dir, { script: auditScript });
        if (r.code !== 0) return { commit, audit: { exit: r.code, errors: 1, warnings: 0, findings: [], error: r.stderr.trim() } };
        const status = (await git.run(['status', '--porcelain'], { cwd: dir })).split('\n').filter(Boolean);
        const stray = status.filter((l) => !l.slice(3).startsWith(`${indexDir}/`));
        if (stray.length) throw new Error(`regenerating ${indexDir} touched other files: ${stray.join(', ')}`);
        if (status.length) {
          await git.run(['add', '-A', '--', indexDir], { cwd: dir });
          const tree = (await git.run(['write-tree'], { cwd: dir })).trim();
          final = await commitTree(tree, parents, message, author);
        }
      }
      const audit = await runAudit(dir, { script: auditScript });
      return { commit: final, audit };
    } finally {
      await git.tryRun(['worktree', 'remove', '--force', dir]);
      fs.rmSync(dir, { recursive: true, force: true });
      await git.tryRun(['worktree', 'prune']);
    }
  }

  /**
   * Compare-and-swap main from `oldSha` to `newSha`. [workstream C] The
   * reference-transaction hook refuses a wiki change to main from an agent
   * environment; a service started inside one says, for exactly this
   * transition, that it is the reviewed move (tools/lib/git-hooks.mjs).
   */
  async function moveMain(oldSha, newSha, message) {
    const release = authorizeMainMove(git.repoRoot, { ref: `refs/heads/${main}`, oldSha, newSha });
    try { return await casMain(oldSha, newSha, message); } finally { release(); }
  }

  async function casMain(oldSha, newSha, message) {
    const wt = await git.worktreeFor(main);
    if (wt) {
      const head = (await git.run(['rev-parse', 'HEAD'], { cwd: wt.path })).trim();
      if (head !== oldSha) return { ok: false, reason: 'moved' };
      const r = await gitx(['merge', '--ff-only', '--quiet', newSha], { cwd: wt.path });
      if (r.code === 0) return { ok: true, method: 'ff-only', path: wt.path };
      const now = (await git.run(['rev-parse', 'HEAD'], { cwd: wt.path })).trim();
      if (now !== oldSha) return { ok: false, reason: 'moved' };
      return {
        ok: false,
        reason: 'checkout',
        message: `The copy of the knowledge base at ${wt.path} has unsaved edits to files this change touches, so it could not be updated. Save (commit) or set those edits aside, then press "Try again". Git said: ${r.stderr.trim().split('\n')[0] || 'merge refused'}`,
      };
    }
    const r = await gitx(['update-ref', '-m', message, `refs/heads/${main}`, newSha, oldSha]);
    return r.code === 0 ? { ok: true, method: 'update-ref' } : { ok: false, reason: 'moved' };
  }

  async function cleanup(branch) {
    const wt = await git.worktreeFor(branch);
    if (wt) await git.tryRun(['worktree', 'remove', '--force', wt.path]);
    await git.tryRun(['branch', '-d', branch]);
  }

  /**
   * @param {object} proposal
   * @param {object} opts
   * @param {Array}  opts.approvers  counted approvals (display, email, actorId, channel)
   * @param {object} opts.author     { name, email } — the human whose approval completed it
   * @param {string} [opts.date]     YYYY-MM-DD for the log row
   * @returns {Promise<{ ok: true, sha, audit, method, pushed } | { ok: false, reason, message, files?, audit? }>}
   */
  async function merge(proposal, { approvers, author, date = new Date().toISOString().slice(0, 10) }) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const mainSha = await git.revParse(main);
      const branchSha = (await git.tryRun(['rev-parse', '--verify', `refs/heads/${proposal.branch}^{commit}`]))?.trim();
      if (branchSha && branchSha !== proposal.headSha) {
        return { ok: false, reason: 'stale', message: 'The proposal changed after it was approved. It will be shown again for review.' };
      }
      const head = proposal.headSha;
      const base = await git.mergeBase(mainSha, head);
      const { tree, conflicts } = await mergeTree(mainSha, head);

      const replacements = new Map();
      const unresolved = [];
      for (const file of conflicts) {
        if (file.startsWith(`${indexDir}/`)) continue;          // derived — regenerated in verify()
        const resolved = appendOnly.has(file) ? await unionResolve(file, base, mainSha, head) : null;
        if (resolved === null) unresolved.push(file);
        else replacements.set(file, resolved);
      }
      if (unresolved.length) {
        return {
          ok: false, reason: 'conflict', files: unresolved,
          message: `This clashes with changes added since it was written (${unresolved.join(', ')}). The agent has been asked to redo it on top of the current knowledge base.`,
        };
      }

      const logText = replacements.has(logPath) ? replacements.get(logPath) : await git.show(tree, logPath);
      replacements.set(logPath, appendLogRow(logText, logRow({ date, proposal, approvers })));
      const mergedTree = await treeWith(tree, replacements);

      const names = approvers.map((a) => `${a.display || a.actorId}${a.email ? ` <${a.email}>` : ''} (${a.channel})`);
      const message = [
        `Merge proposal ${proposal.id}: ${proposal.title}`,
        '',
        `Approved by: ${names.join(', ')}`,
        `Reviewed head: ${head}`,
        `Proposal: ${proposal.id}`,
        `Branch: ${proposal.branch}`,
      ].join('\n');
      const parents = [mainSha, head];
      const candidate = await commitTree(mergedTree, parents, message, author);
      const { commit, audit } = await verify(candidate, { parents, message, author });
      if (audit.exit !== 0) {
        return {
          ok: false, reason: 'audit', audit,
          message: `Combined with the current knowledge base, this fails the automatic checks (${audit.errors || 'unknown'} problem${audit.errors === 1 ? '' : 's'}). The agent has been asked to fix it.`,
        };
      }

      // Last gate before main moves: what the reviewer approved, and what main would become.
      const outside = outsideFiles([
        ...(await listChanges(git, base, head)),
        ...(await listChanges(git, mainSha, commit)),
      ], allowed);
      if (outside.length) {
        log?.error('merge refused: files outside the knowledge base', { proposal: proposal.id, files: outside.map((o) => o.path) });
        return { ok: false, reason: 'paths', files: outside, message: describeOutside(outside) };
      }

      const moved = await moveMain(mainSha, commit, `almagest: merge ${proposal.id}`);
      if (moved.ok) {
        let pushed = false;
        const { remote, push } = config.service.git;
        if (push && remote) {
          const r = await gitx(['push', '--quiet', remote, `refs/heads/${main}:refs/heads/${main}`]);
          pushed = r.code === 0;
          if (!pushed) log?.error('push after merge failed — main moved locally only', { error: r.stderr.trim() });
        }
        await cleanup(proposal.branch);
        return { ok: true, sha: commit, audit, method: moved.method, pushed };
      }
      if (moved.reason !== 'moved') return moved;
      log?.info('main moved during merge — retrying', { proposal: proposal.id, attempt });
    }
    return { ok: false, reason: 'busy', message: 'The knowledge base kept changing while this was being added. Press "Try again".' };
  }

  return { merge, moveMain, mergeTree };
}
