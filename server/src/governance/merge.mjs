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
 * Steps 5 and 6 are verifyCandidate(). acceptExternal() runs the same gate on
 * a merge commit made elsewhere (a merged GitHub PR) before main may move to
 * it, after checking that the commit holds exactly the merge of main and the
 * reviewed head — Almagest stays the gate for its own main.
 *
 * Merges are serialised by the caller's mutex; the CAS covers everyone else.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalOrUnsure, canonicalSet, differOnlyInTier, tierOfText } from '../../../tools/lib/canonical.mjs';
import { authorizeMainMove } from '../../../tools/lib/git-hooks.mjs';
import { serviceActor } from '../core/auth.mjs';
import { childEnv, gitIdentity } from '../core/git.mjs';
import { mergeManifest, stripRemovedPlaceholders } from './bookkeeping.mjs';
import { canonicalAt } from './canonical.mjs';
import { mergePages, pageProvenance } from './page-merge.mjs';
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

/**
 * execFile that resolves with the exit code instead of rejecting on it. The
 * child gets core/git.mjs's childEnv(): an inherited GIT_DIR, GIT_INDEX_FILE
 * or GIT_WORK_TREE must not point a merge at another repository or index.
 */
function execp(cmd, args, { cwd, env, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      cwd,
      env: childEnv(env),
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

export function logRow({ date, proposal, approvers, combined = [] }) {
  const who = approvers.map((a) => `${a.display || a.actorId} (${a.channel})`).join(', ') || 'unknown';
  const pages = (proposal.changes || []).filter((c) => c.pageStatus !== 'rejected').map((c) => c.slug).join(', ') || 'none';
  const joined = combined.length ? `; combined with what was already there: ${cell(combined.join(', '))}` : '';
  return `| ${cell(date)} | merge | ${cell(proposal.id)} ${cell(proposal.title)} — approved by ${cell(who)}; reviewed ${cell(String(proposal.headSha).slice(0, 7))}; pages: ${cell(pages)}${joined} |`;
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
  const configLocked = canonicalSet({ configPages: config.v1.canonicalPages });
  const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pageFile = new RegExp(`^${escapeRe(brainDir.replace(/\/+$/, ''))}/wiki/([^/]+)\\.md$`);
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

  /**
   * Two approved versions of one wiki page, combined (page-merge.mjs), or null
   * when that is not provably safe: not a page, a canonical page (or one whose
   * tier the two parsers read differently), a version missing on either side
   * (delete against change), or any clash. What the agent reported (`extends`)
   * plays no part. `locked` is the canonical set on main (canonical.mjs).
   */
  async function combinePage(file, base, ours, theirs, locked = new Set()) {
    const m = pageFile.exec(file);
    if (!m || locked.has(m[1])) return null;
    const [b, o, t] = await Promise.all([git.show(base, file), git.show(ours, file), git.show(theirs, file)]);
    if (o === null || t === null) return null;
    if ([b, o, t].some((text) => text !== null && canonicalOrUnsure(text))) return null;
    const r = await mergePages({ base: b, ours: o, theirs: t });
    if (!r.ok) {
      log?.info('page merge fell through to a revise', { file, reason: r.reason });
      return null;
    }
    return { slug: m[1], text: r.text };
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
   * With `regenerate: false` the commit must be final as it is: a derived
   * index that is not current fails the check instead of being rebuilt.
   */
  async function verify(commit, { parents, message, author, regenerate = true }) {
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
        if (status.length && !regenerate) {
          return { commit, audit: { exit: 1, errors: 1, warnings: 0, findings: [], error: `${indexDir} is not current for this commit` } };
        }
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

  /** Files outside the knowledge base in what the reviewer saw (base..head) or in what main would become. */
  async function outsideOfCandidate(commit, { mainSha, base, head }) {
    return outsideFiles([
      ...(await listChanges(git, base, head)),
      ...(await listChanges(git, mainSha, commit)),
    ], allowed);
  }

  function refusePaths(outside, proposalId) {
    log?.error('merge refused: files outside the knowledge base', { proposal: proposalId, files: outside.map((o) => o.path) });
    return { ok: false, reason: 'paths', files: outside, message: describeOutside(outside) };
  }

  /**
   * Does `commit` hold exactly the merge of `mainSha` and the reviewed `head`
   * — what `git merge-tree` computes, and what a merge commit made by
   * GitHub's merge button holds when nobody edited it? Returns null if so,
   * else the files that differ (or that clash, when the two do not merge
   * cleanly: how a clash was settled on GitHub is content nobody reviewed).
   *
   * The derived index (brain/.index/) is the one exception: a file there may
   * differ from the plain merge — a merge of two index edits is rarely the
   * current index, and whoever merged may have regenerated it. It is not
   * free text: acceptExternal() verifies with `regenerate: false`, which
   * rebuilds the index from the commit's (now proven reviewed) pages and
   * refuses the commit unless every index file is exactly what that yields.
   * Only modifications are tolerated, so the index cannot be dropped (which
   * would skip that check) and no file can be added beside it.
   */
  async function unreviewedContent(commit, mainSha, head, { locked = new Set() } = {}) {
    const derived = (f) => f.startsWith(`${indexDir}/`);
    const { tree, conflicts } = await mergeTree(mainSha, head);
    // A clash on a wiki page that page-merge.mjs can combine is part of "the
    // merge of the two": the expected tree holds the combined page. Anything
    // else that clashes is how somebody settled something nobody reviewed.
    const base = conflicts.some((f) => !derived(f)) ? await git.mergeBase(mainSha, head) : null;
    const combined = new Map();
    const clashes = [];
    for (const f of conflicts.filter((x) => !derived(x))) {
      const page = await combinePage(f, base, mainSha, head, locked);
      if (page) combined.set(f, page.text); else clashes.push(f);
    }
    if (clashes.length) return { clash: true, files: clashes.map((f) => ({ path: f, reason: 'clashes with the current knowledge base' })) };
    const expected = combined.size ? await treeWith(tree, combined) : tree;
    const actual = (await git.run(['rev-parse', `${commit}^{tree}`])).trim();
    if (actual === expected) return null;
    const parts = (await git.run(['diff', '--name-status', '--no-renames', '-z', expected, actual])).split('\0');
    const what = { A: 'added', D: 'removed', M: 'changed', T: 'changed' };
    const files = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const [status, file] = [parts[i][0], parts[i + 1]];
      if (status === 'M' && derived(file)) continue;
      files.push({ path: file, reason: `${what[status] || 'changed'} after review` });
    }
    return files.length ? { clash: false, files } : null;
  }

  /**
   * For every wiki page that clashed between main and the reviewed head, what
   * `commit` holds must satisfy the page-merge invariant, recomputed here from
   * main's version, the head's version and their merge base: every body line and
   * every frontmatter value occurs in one of the two, each side's lines keep
   * their order, and nothing a side removed since the base is back. This does not trust whoever
   * made the commit, and does not look at how they got there. A page that is
   * canonical is never combined. A clash on any file that is neither such a
   * page nor one of the bookkeeping files merge() resolves itself is refused.
   * Returns the files that fail, [] when there is nothing wrong.
   */
  async function combinedPageProblems(commit, mainSha, head, locked = new Set(), base = null) {
    const derived = (f) => f.startsWith(`${indexDir}/`);
    const { conflicts } = await mergeTree(mainSha, head);
    const mergeBase = base || (conflicts.some((f) => !derived(f) && !appendOnly.has(f)) ? await git.mergeBase(mainSha, head) : null);
    const bad = [];
    for (const file of conflicts.filter((f) => !derived(f))) {
      if (appendOnly.has(file)) continue;
      const m = pageFile.exec(file);
      const [o, t, c, b] = m ? await Promise.all([git.show(mainSha, file), git.show(head, file), git.show(commit, file), mergeBase ? git.show(mergeBase, file) : null]) : [null, null, null, null];
      const tier = [o, t, c, b].some((text) => text !== null && canonicalOrUnsure(text));
      if (!m || locked.has(m[1]) || tier || o === null || t === null || c === null) {
        bad.push({ path: file, reason: 'clashed with the current knowledge base and was not combined from the two versions' });
        continue;
      }
      const why = pageProvenance(c, o, t, b);
      if (why) bad.push({ path: file, reason: `holds content that is in neither version (${why})` });
    }
    return bad;
  }

  /**
   * The gate every new main passes, whoever made the commit: only the
   * knowledge base's writable files change, and the result passes the
   * service's own audit. The path check runs first, so a commit that touches
   * anything else is never even checked out for the audit.
   *
   * @returns {Promise<{ ok: true, commit, audit } | { ok: false, reason: 'paths'|'audit', message, files?, audit? }>}
   */
  async function verifyCandidate(commit, { mainSha, base, head, parents, message, author, regenerate = true, proposalId = '', locked = new Set() }) {
    const refuse = (outside) => refusePaths(outside, proposalId);
    let outside = await outsideOfCandidate(commit, { mainSha, base, head });
    if (outside.length) return refuse(outside);
    const unreviewed = await combinedPageProblems(commit, mainSha, head, locked, base);
    if (unreviewed.length) {
      log?.error('merge refused: a combined page holds content that was not reviewed', { proposal: proposalId, files: unreviewed.map((f) => f.path) });
      return { ok: false, reason: 'content', files: unreviewed, message: `The combined result holds content that was in neither reviewed version (${unreviewed.slice(0, 5).map((f) => f.path).join(', ')}), so it was not added.` };
    }
    const { commit: final, audit } = await verify(commit, { parents, message, author, regenerate });
    if (audit.exit !== 0) {
      return {
        ok: false, reason: 'audit', audit,
        message: `Combined with the current knowledge base, this fails the automatic checks (${audit.errors || 'unknown'} problem${audit.errors === 1 ? '' : 's'}).`,
      };
    }
    // Last gate before main moves: a regenerated index is a new commit — check it too.
    if (final !== commit) {
      outside = await outsideOfCandidate(final, { mainSha, base, head });
      if (outside.length) return refuse(outside);
    }
    return { ok: true, commit: final, audit };
  }

  // ── canonical: what a proposal may do to a locked page, and to a page's tier ──

  const wikiFile = (slug) => `${brainDir.replace(/\/+$/, '')}/wiki/${slug}.md`;
  const tierAt = async (sha, file) => tierOfText(await git.show(sha, file));

  /**
   * Pages the reviewed branch (base..head) changes that it must not:
   *
   *   - a page that is canonical on main, or was canonical where the branch
   *     started: an agent never changes one (non-negotiable 4). The one
   *     exception is the single `tier:` line of a tier proposal's own page,
   *     which tierProposalProblems() verifies separately;
   *   - a page the branch makes canonical, unless a person chose that in the
   *     inbox: the service recorded the choice on the proposal (`tierEdits`)
   *     with the blob of the page as it was then, and the page is still that
   *     blob. An external merge (GitHub) accepts no promotion at all.
   *
   * @returns {Promise<Array<{ path: string, reason: string }>>}
   */
  async function canonicalProblems(proposal, { base, head, locked, external = false }) {
    const out = [];
    const own = proposal?.kind === 'tier' ? proposal.tier?.slug : '';
    for (const f of await listChanges(git, base, head)) {
      for (const file of [f.path, f.from].filter(Boolean)) {
        const m = pageFile.exec(file);
        if (!m) continue;
        const slug = m[1];
        if (slug === own && !external) continue;
        const wasLocked = locked.has(slug) || canonicalOrUnsure(await git.show(base, file));
        if (wasLocked) {
          out.push({ path: file, reason: 'a locked reference page, which a proposal never changes' });
          continue;
        }
        if (file === f.path && f.status !== 'D' && canonicalOrUnsure(await git.show(head, file))) {
          const edit = proposal?.tierEdits?.[slug];
          const blob = (await git.tryRun(['rev-parse', `${head}:${file}`]))?.trim();
          const chosen = !external && edit?.to === 'canonical' && edit.blob && edit.blob === blob;
          if (!chosen) out.push({ path: file, reason: external ? 'made canonical outside the review inbox' : 'made canonical without a person choosing it in the review inbox' });
        }
      }
    }
    return out;
  }

  /**
   * A tier proposal is exactly one line: the `tier:` line of one page. From
   * what the reviewer saw (base..head) it must be that one file, changed in
   * nothing else, going from the recorded tier to the recorded one; and main's
   * copy of the page must still hold the tier it is leaving. A page locked by
   * brain.config.yaml cannot be lowered here: that file is not the service's.
   */
  async function tierProposalProblems(proposal, { mainSha, base, head }) {
    const t = proposal.tier || {};
    if (!t.slug || !t.to) return [{ path: '(unknown)', reason: 'this tier change does not say which page or which tier' }];
    const file = wikiFile(t.slug);
    const bad = (reason) => [{ path: file, reason }];
    const changed = await listChanges(git, base, head);
    if (changed.length !== 1 || changed[0].path !== file || changed[0].status !== 'M' || changed[0].mode !== '100644') {
      return [{ path: changed.find((f) => f.path !== file)?.path || file, reason: 'a tier change may change only the tier line of its one page' }];
    }
    const [before, after, now] = await Promise.all([git.show(base, file), git.show(head, file), git.show(mainSha, file)]);
    if (before === null || after === null || now === null) return bad('the page is missing');
    if (!differOnlyInTier(before, after)) return bad('it changes more than the tier line');
    if (tierOfText(after) !== t.to) return bad(`the page does not end up at tier ${t.to}`);
    if (tierOfText(before) !== t.from) return bad(`the page was not at tier ${t.from} when this was proposed`);
    if (tierOfText(now) !== t.from) return bad(`the page is no longer at tier ${t.from} on the knowledge base`);
    if (configLocked.has(t.slug) && t.to !== 'canonical') return bad('the page is locked in brain.config.yaml, which only a person edits by hand');
    return [];
  }

  /** What main would become: for a tier proposal, nothing beyond the page, the log and the derived index. */
  async function tierResultProblems(proposal, commit, mainSha) {
    const t = proposal.tier || {};
    const file = wikiFile(t.slug);
    const out = [];
    for (const f of await listChanges(git, mainSha, commit)) {
      if (f.path === file || f.path === logPath || f.path.startsWith(`${indexDir}/`)) continue;
      out.push({ path: f.path, reason: 'a tier change may change only its page, the log and the derived index' });
    }
    if ((await tierAt(commit, file)) !== t.to) out.push({ path: file, reason: `the result does not hold tier ${t.to}` });
    return out;
  }

  const canonicalRefusal = (files, proposalId, what = 'canonical') => {
    log?.error('merge refused: a canonical rule', { proposal: proposalId, files: files.map((f) => f.path) });
    return {
      ok: false, reason: what, files,
      message: `This cannot be added: ${files.slice(0, 5).map((f) => `${f.path} (${f.reason})`).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}.`,
    };
  };

  /** Check out `commit` detached in a temp dir and run the service's own audit on it. */
  async function auditCommit(commit) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-audit-'));
    try {
      await git.run(['worktree', 'add', '--detach', '--force', dir, commit]);
      return await runAudit(dir, { script: auditScript });
    } finally {
      await git.tryRun(['worktree', 'remove', '--force', dir]);
      fs.rmSync(dir, { recursive: true, force: true });
      await git.tryRun(['worktree', 'prune']);
    }
  }

  /**
   * Compare-and-swap main from `oldSha` to `newSha`. The
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
      const locked = await canonicalAt(git, config, mainSha);
      const forbidden = await canonicalProblems(proposal, { base, head, locked });
      if (forbidden.length) return canonicalRefusal(forbidden, proposal.id);
      if (proposal.kind === 'tier') {
        const wrong = await tierProposalProblems(proposal, { mainSha, base, head });
        if (wrong.length) return canonicalRefusal(wrong, proposal.id, 'tier');
      }
      const { tree, conflicts } = await mergeTree(mainSha, head);

      const replacements = new Map();
      const unresolved = [];
      const combined = [];
      for (const file of conflicts) {
        if (file.startsWith(`${indexDir}/`)) continue;          // derived — regenerated in verify()
        let resolved = null;
        if (appendOnly.has(file)) resolved = await unionResolve(file, base, mainSha, head);
        else {
          const page = proposal.kind === 'tier' ? null : await combinePage(file, base, mainSha, head, locked);
          if (page) { resolved = page.text; combined.push(page.slug); }
        }
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
      replacements.set(logPath, appendLogRow(logText, logRow({ date, proposal, approvers, combined })));
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
      const checked = await verifyCandidate(candidate, { mainSha, base, head, parents, message, author, proposalId: proposal.id, locked });
      if (!checked.ok) {
        return checked.reason === 'audit' ? { ...checked, message: `${checked.message} The agent has been asked to fix it.` } : checked;
      }
      const { commit, audit } = checked;
      if (proposal.kind === 'tier') {
        const wrong = await tierResultProblems(proposal, commit, mainSha);
        if (wrong.length) return canonicalRefusal(wrong, proposal.id, 'tier');
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
        return { ok: true, sha: commit, audit, method: moved.method, pushed, combined };
      }
      if (moved.reason !== 'moved') return moved;
      log?.info('main moved during merge — retrying', { proposal: proposal.id, attempt });
    }
    return { ok: false, reason: 'busy', message: 'The knowledge base kept changing while this was being added. Press "Try again".' };
  }

  /**
   * Accept a merge commit made elsewhere (a pull request merged on GitHub) as
   * the new main — only if it is provably "the reviewed head on top of this
   * main": parents exactly (local main, proposal.headSha), its tree exactly
   * the merge of the two (unreviewedContent(); refused as `content`), and the
   * commit passes verifyCandidate() unchanged. GitHub's merge button writes
   * no log row and resolves no bookkeeping clash, so a legitimate merge is
   * the plain merge-tree result, not what merge() would have made. A squash
   * or rebase merge has no such parents and cannot be checked, so it is
   * refused like any other mismatch.
   * The caller holds the governance lock and has already decided the policy.
   *
   * @param {object} proposal
   * @param {string} sha   the merge commit; must already be in the local object store
   * @returns {Promise<{ ok: true, sha, audit, method } | { ok: false, reason, message, files?, audit? }>}
   */
  async function acceptExternal(proposal, sha) {
    const commit = /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(String(sha)) ? (await git.tryRun(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]))?.trim() : '';
    if (!commit) return { ok: false, reason: 'shape', message: `The merge commit ${String(sha).slice(0, 7) || '(none given)'} is not available here, so it cannot be checked.` };
    const mainSha = await git.revParse(main);
    const [, ...parents] = (await git.run(['rev-list', '--parents', '-n', '1', commit])).trim().split(/\s+/);
    if (parents.length !== 2) {
      return { ok: false, reason: 'shape', message: 'It was squashed or rebased, so Almagest cannot check that the result is exactly the reviewed version on top of the current knowledge base. Use a merge commit, or bring it in by hand.' };
    }
    if (parents[1] !== proposal.headSha) {
      return { ok: false, reason: 'head', message: `The merged branch is at ${parents[1].slice(0, 7)}, but the reviewed version is ${String(proposal.headSha).slice(0, 7)}.` };
    }
    if (parents[0] !== mainSha) {
      return { ok: false, reason: 'shape', message: `It was merged onto ${parents[0].slice(0, 7)}, which is not this knowledge base's main (${mainSha.slice(0, 7)}).` };
    }
    const base = await git.mergeBase(mainSha, proposal.headSha);
    // A commit made outside the service may not make a page canonical or change
    // a canonical one: promoting and lowering are decided in the review inbox.
    const locked = await canonicalAt(git, config, mainSha);
    const forbidden = await canonicalProblems(proposal, { base, head: proposal.headSha, locked, external: true });
    if (forbidden.length) return canonicalRefusal(forbidden, proposal.id);
    const candidate = { mainSha, base, head: proposal.headSha, parents, regenerate: false, proposalId: proposal.id, locked };
    // Paths first (an edit to the gate is named as such), then content, then
    // verifyCandidate() — which repeats the path check, as every new main does.
    const outside = await outsideOfCandidate(commit, candidate);
    if (outside.length) return refusePaths(outside, proposal.id);
    // Right parents say nothing about what the commit holds: a hand-made
    // merge commit can carry any edit. It must be the reviewed merge, exactly.
    const extra = await unreviewedContent(commit, mainSha, proposal.headSha, { locked });
    if (extra) {
      const list = `${extra.files.slice(0, 5).map((f) => f.path).join(', ')}${extra.files.length > 5 ? ` and ${extra.files.length - 5} more` : ''}`;
      log?.error('external merge refused: content not in the reviewed version', { proposal: proposal.id, sha: commit, files: extra.files.map((f) => f.path) });
      return {
        ok: false, reason: 'content', files: extra.files,
        message: extra.clash
          ? `The merge on GitHub contains changes that were not in the reviewed version: the reviewed version clashes with the current knowledge base in ${list}, and how that was settled was never reviewed. Bring it in by hand.`
          : `The merge on GitHub contains changes that were not in the reviewed version: ${list}.`,
      };
    }
    const checked = await verifyCandidate(commit, candidate);
    if (!checked.ok) return checked;
    const moved = await moveMain(mainSha, commit, `almagest: accept merged pull request for ${proposal.id}`);
    if (!moved.ok) return { ok: false, reason: moved.reason === 'checkout' ? 'checkout' : 'busy', message: moved.message || 'The knowledge base changed while this was being checked.' };
    await cleanup(proposal.branch);
    return { ok: true, sha: commit, audit: checked.audit, method: moved.method };
  }

  return { merge, acceptExternal, verifyCandidate, moveMain, mergeTree, treeWith, commitTree, auditCommit, canonicalProblems, tierProposalProblems };
}
