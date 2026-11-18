/**
 * runner.mjs — one job, start to proposal. Spec: docs/v2/spec.md → Background
 * ingest → Runner, steps 1–7.
 *
 * The order of the gates is the design:
 *
 *   agent writes → report validated → original moved → PATH GUARD → AUDIT → commit → proposal
 *
 * Everything before the path guard is the agent's account of what it did.
 * Everything from the path guard on is the runner checking that account
 * mechanically against the working tree, with tools the agent could not have
 * edited. Nothing is committed that has not passed both, and nothing reaches
 * `main` from here at all — the runner's last act is handing governance a
 * branch.
 *
 * Git itself is one of those tools. The worktree's `.git` file is the agent's
 * to rewrite, so the runner never lets git read it: the worktree is opened
 * once from the repo root (core/git.mjs → openWorktree), and every git command
 * after that names the admin dir explicitly and first checks `.git` is still
 * byte-for-byte what git wrote. A changed `.git` fails the job, uncommitted.
 */
import fs from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';
import YAML from 'yaml';

import { canonicalOrUnsure } from '../../../tools/lib/canonical.mjs';
import { asArray, findCitations, safeFrontmatter } from '../../../tools/lib/wiki-core.mjs';

import { serviceActor } from '../core/auth.mjs';
import { modelForTier } from '../core/config.mjs';
import { gitIdentity, WorktreeTamperedError } from '../core/git.mjs';
import { oneLine } from '../core/text.mjs';
import { ingestBranch, learningsBranch, nowIso, slugify, validateRunReport } from '../core/schemas.mjs';
import { canonicalAt } from '../governance/canonical.mjs';
import { appendViolation, basisOf, createRejectedMemory, describeHidden, distinctSources, frontMatterProblem, hiddenCharacter, MAX_LEARNING_CHARS, readPage, synthesisSettings } from '../governance/learnings.mjs';
import { isPlaceholderRow } from '../governance/bookkeeping.mjs';
import { agentInstructionPath, writableMatcher } from '../governance/paths.mjs';
import { LIVE } from '../governance/policy.mjs';
import { auditSummary, runAudit, wrapperIntact, writeAuditWrapper } from './audit.mjs';
import { allowedTools as claudeAllowedTools } from './drivers/claude-code.mjs';
import { appendTableRow, removeTableRowsFor } from './md.mjs';
import { buildPrompt, RUN_REPORT_PATH } from './prompt.mjs';
import { isInside, placeSource, realish, sha256File } from './source.mjs';

/** A job failure the queue knows how to treat. `retryable` failures are re-queued up to max_attempts. */
export class JobError extends Error {
  constructor(message, { retryable = false, patch = {} } = {}) {
    super(message);
    this.name = 'JobError';
    this.retryable = retryable;
    this.patch = patch;
  }
}

const SVC = serviceActor('ingest');
/** Front matter is YAML and nothing else: a `---js` block is refused, never run. */
const parseFrontmatter = safeFrontmatter(matter);
const CLOSED_PROPOSAL = new Set(['merged', 'rejected', 'superseded']);

/**
 * Where the text of pages pending in other proposals is put for the agent to
 * read: under `.almagest/` in the job worktree, next to the run report. That
 * directory is git-ignored, outside every path the path guard allows, never
 * read by the audit (which reads the wiki directory and the bookkeeping files
 * only), and removed by the runner right after the agent finishes, before the
 * run report is read and long before the path guard, the audit and the commit.
 */
export const PENDING_DIR = '.almagest/pending';
/** A page text never needs more than this; a runaway set of open proposals is cut at it, newest first. */
const MAX_PENDING_PAGES = 400;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const pairKey = (slug, proposalId) => `${slug}\0${proposalId}`;

function modelFor(config, driverName) {
  if (config.ingest.model) return String(config.ingest.model);
  // A tier resolves through the profile of the harness the DRIVER runs, not
  // agent.harness: an instance configured for codex in the IDE can still run
  // claude-code in the background, and a codex model name would break it.
  return modelForTier({ agent: { ...config.agent, harness: driverName } }, config.ingest.model_tier || 'judgment');
}

/**
 * Files the agent may change, relative to the worktree: the same matcher
 * governance enforces on the branch diff (governance/paths.mjs), so there is
 * one definition of "knowledge-base file" and no agent instruction file
 * (CLAUDE.md, AGENTS.md, .claude/ …) passes either check.
 */
function writablePaths(config) {
  return {
    allowed: writableMatcher({
      brainDir: config.v1.brainDir, manifestPath: config.v1.manifestPath,
      challengesPath: config.v1.challengesPath, indexDir: config.v1.indexDir,
    }),
  };
}

/**
 * Every path that differs between `startSha` — the branch head the worktree
 * was reset to — and the working tree, plus untracked files: what the agent
 * changed, as the trusted git dir sees it. Renames count on both sides.
 */
async function touchedPaths(wt, startSha) {
  const changed = await wt.run(['diff', '--name-only', '-z', '--no-renames', startSha, '--']);
  const untracked = await wt.run(['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...changed.split('\0'), ...untracked.split('\0')].filter(Boolean))];
}

/** A `.git` that changed under the runner → a failed job, never a retry; the worktree stays as evidence. */
function tamperedJob(err, wt) {
  const content = err.content ? ` It now reads ${JSON.stringify(err.content.slice(0, 200))}.` : '';
  return new JobError(`the worktree's .git file was tampered with: ${err.message}.${content} Nothing was committed; the worktree is kept at ${wt} for inspection`);
}

/**
 * The first line of `before` that `after` no longer holds in the same order,
 * or null when `after` only adds whole lines. Placeholder rows may go: the
 * bookkeeping replaces `| _(no actions yet)_ | | |` with the first real row.
 */
function firstLostLine(before, after) {
  const lines = (text) => { const xs = text.split('\n'); if (xs.length && xs[xs.length - 1] === '') xs.pop(); return xs; };
  const old = lines(before).filter((l) => !isPlaceholderRow(l));
  let at = 0;
  for (const line of lines(after)) if (at < old.length && line === old[at]) at += 1;
  return at < old.length ? old[at] : null;
}

export function createRunner(ctx, { driver, logsDir }) {
  const { config, git, log } = ctx;
  const branchLocks = new Map();
  const turnedDown = createRejectedMemory({ store: ctx.store, git, config });

  /** Jobs on one branch run one at a time, whatever ingest.concurrency says. */
  async function withBranchLock(branch, fn) {
    const prev = branchLocks.get(branch) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const chained = prev.then(() => mine);
    branchLocks.set(branch, chained);
    await prev;
    try { return await fn(); }
    finally {
      release();
      if (branchLocks.get(branch) === chained) branchLocks.delete(branch);
    }
  }

  async function proposalFor(job) {
    if (!job.proposalId) return null;
    let proposal;
    try { proposal = await ctx.governance.getProposal(job.proposalId); }
    catch (err) { throw new JobError(`cannot load proposal ${job.proposalId}: ${err.message}`, { retryable: true }); }
    if (!proposal) throw new JobError(`proposal ${job.proposalId} not found`);
    if (CLOSED_PROPOSAL.has(proposal.status)) throw new JobError(`proposal ${proposal.id} is ${proposal.status} — nothing to ${job.kind}`);
    return proposal;
  }

  /** Step 1: which branch, from where. revise / drop-page reuse the proposal's branch. */
  async function target(job) {
    const proposal = await proposalFor(job);
    if (job.kind === 'revise' || job.kind === 'drop-page') {
      if (!proposal) throw new JobError(`${job.kind} needs a proposalId`);
      return { proposal, branch: proposal.branch, source: job.source || proposal.source || null };
    }
    if (proposal) return { proposal, branch: proposal.branch, source: job.source || proposal.source || null };
    if (job.kind === 'synthesize') {
      // No source: the branch is named for the commit of main it reads. A
      // retry keeps the branch the first attempt made (patchJob stored it).
      let branch = job.branch;
      if (!branch) {
        const mainSha = await git.revParse(config.service.git.main);
        branch = learningsBranch(mainSha);
        if (await git.branchExists(branch)) branch = learningsBranch(mainSha, { unique: true });
      }
      return { proposal: null, branch, source: job.source || null };
    }
    const source = job.source || { id: `${job.kind}-${slugify(job.slug || job.instructions || 'pages')}`, sha256: (await git.revParse(config.service.git.main)).slice(0, 12) };
    const branch = job.branch || ingestBranch(source);
    await refuseForeignBranch(job, branch, job.source || null);
    return { proposal: null, branch, source: job.source || null };
  }

  /**
   * An ingest that is not a revise must not work on a branch where a live
   * proposal of something else is open. The branch names are built so a
   * person's source cannot collide with a learnings or tier branch; this is
   * the check that does not rely on that: before the agent runs, a live
   * proposal on the target branch has to be of the ordinary kind and have
   * come from this same source.
   */
  async function refuseForeignBranch(job, branch, source) {
    let live = [];
    try { live = ((await ctx.governance.listProposals({ status: LIVE })) || []).filter((p) => p?.branch === branch && LIVE.includes(p.status)); }
    catch (err) { throw new JobError(`cannot check ${branch} for an open proposal: ${err.message}`, { retryable: true }); }
    for (const p of live) {
      if (p.kind === 'learnings' || p.kind === 'tier') {
        throw new JobError(`branch ${branch} already holds an open ${p.kind === 'tier' ? 'tier' : 'learnings'} proposal (${oneLine(p.id, 60)}), which this ${job.kind} job did not come from — not run`);
      }
      const other = p.source || null;
      const differs = (a, b) => a !== undefined && a !== null && a !== '' && b !== undefined && b !== null && b !== '' && a !== b;
      if (source && other && (differs(source.id, other.id) || differs(source.sha256, other.sha256))) {
        throw new JobError(`branch ${branch} already holds an open proposal (${oneLine(p.id, 60)}) that came from a different source (${oneLine(other.id, 80)}) than this job's (${oneLine(source.id, 80)}) — not run`);
      }
    }
  }

  /**
   * A clean worktree for `branch` under worktree_dir. A reused worktree is
   * reset to the branch head first — a previous failed attempt's leftovers
   * are inspection material, not input to the next run.
   */
  async function prepareWorktree(branch) {
    await git.run(['worktree', 'prune']);
    const existed = await git.branchExists(branch);
    const dir = await git.worktreeAdd(branch, { base: config.service.git.main });
    const root = realish(config.paths.worktrees);
    if (!isInside(root, realish(dir))) {
      throw new JobError(`branch ${branch} is checked out at ${dir}, outside ${config.service.git.worktree_dir} — the runner never works in someone else's checkout`);
    }
    // Opened before the reset: a worktree kept from an earlier failed run is
    // checked too, so a `.git` an earlier agent rewrote can't aim even this
    // reset at the main checkout.
    let wt;
    try { wt = await git.openWorktree(dir); }
    catch (err) { throw err instanceof WorktreeTamperedError ? tamperedJob(err, dir) : err; }
    if (!wt) throw new JobError(`${dir} is not a registered worktree of this repository — refusing to run git in it`);
    if ((await wt.branch()) !== branch) throw new JobError(`the worktree at ${dir} is not on ${branch} — refusing to use it`);
    await wt.run(['reset', '--hard', '--quiet', 'HEAD']);
    await wt.run(['clean', '-fdq']);
    fs.rmSync(path.join(wt.path, '.almagest'), { recursive: true, force: true });
    return { worktree: wt.path, wt, startSha: await wt.revParse('HEAD'), createdBranch: !existed };
  }

  /**
   * The refs a redirected commit would have moved: `main`, and whatever the
   * main checkout has out. Read from the repo root, before and after a job.
   */
  async function watchedRefs() {
    const checkedOut = await git.currentBranch();
    const refs = {};
    for (const name of new Set([config.service.git.main, checkedOut].filter(Boolean))) {
      refs[name] = await git.revParse(name).catch(() => '');
    }
    return refs;
  }

  /**
   * After the commit: it is the head of the job's branch, the worktree is
   * still on that branch, and no watched ref moved to include it or any commit
   * of this job. `main` may move during a long job — someone merged another
   * proposal — and that alone is not this job's doing; main moving to carry
   * this job's work is a commit that skipped review, and fails the job.
   */
  async function verifyCommit(wt, branch, sha, before, job) {
    if ((await wt.branch()) !== branch) throw new JobError(`after the commit the worktree is not on ${branch} — not proposed; inspect ${wt.path}`);
    if (sha && (await git.revParse(branch)) !== sha) throw new JobError(`commit ${sha.slice(0, 7)} is not the head of ${branch} — not proposed; inspect ${wt.path}`);
    const after = await watchedRefs();
    for (const [ref, was] of Object.entries(before)) {
      const now = after[ref];
      if (!was || !now || now === was) continue;
      const contains = sha ? (await git.tryRun(['merge-base', '--is-ancestor', sha, ref])) !== null : false;
      const messages = (await git.tryRun(['log', '--format=%B', `${was}..${now}`])) || '';
      if (contains || messages.includes(`Job: ${job.id} `)) {
        throw new JobError(`${ref} moved from ${was.slice(0, 7)} to ${now.slice(0, 7)} during this job and now carries its work — a commit reached ${ref} without review. Not proposed; inspect ${wt.path} and ${ref}`);
      }
      log.warn('a watched ref moved during an ingest job, not by it', { ref, from: was, to: now, job: job.id });
    }
  }

  async function baseShaFor(branch, proposal) {
    if (proposal?.baseSha) return proposal.baseSha;
    return git.mergeBase(config.service.git.main, branch);
  }

  /**
   * Every wiki page that another open proposal adds or changes, with its text
   * at that proposal's head, written under PENDING_DIR in the worktree. Newest
   * proposal first, so two proposals on one slug come out newest first. Open
   * means a status governance still works on (policy.LIVE); the job's own
   * proposal is left out. A job that cannot read the list runs without it:
   * the cost is a duplicate page the reviewer sees, not a wrong write.
   */
  async function collectPending(job, t, wt) {
    if (job.kind !== 'ingest' && job.kind !== 'revise') return [];
    if (t.proposal?.kind === 'learnings') return [];   // a learning rests on pages on main, not on pending ones
    let proposals;
    try { proposals = await ctx.governance.listProposals({ status: LIVE }); }
    catch (err) { log.warn('could not list open proposals, running without the pending set', { job: job.id, error: err.message }); return []; }
    const others = (proposals || [])
      .filter((p) => p && p.kind !== 'tier' && p.kind !== 'learnings' && LIVE.includes(p.status) && p.id !== t.proposal?.id && p.branch !== t.branch && SAFE_NAME.test(String(p.id)))
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    const root = path.join(wt, PENDING_DIR);
    const pages = [];
    for (const p of others) {
      for (const c of p.changes || []) {
        if (pages.length >= MAX_PENDING_PAGES) return pages;
        if (c.action === 'delete' || c.pageStatus === 'rejected' || !SAFE_NAME.test(String(c.slug)) || !p.headSha || !c.path) continue;
        let text;
        try { text = await git.show(p.headSha, c.path); } catch { text = null; }
        if (typeof text !== 'string') continue;
        let data = {};
        try { data = parseFrontmatter(text).data || {}; } catch { /* a page the parser cannot read is still shown as text */ }
        const file = path.join(root, p.id, `${c.slug}.md`);
        if (!isInside(root, file)) continue;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
        pages.push({
          slug: c.slug, title: String(data.title || c.title || c.slug), aliases: asArray(data.aliases),
          proposalId: p.id, proposalTitle: String(p.title || ''), kind: c.action === 'create' ? 'new' : 'change',
          file: path.posix.join(PENDING_DIR, p.id, `${c.slug}.md`),
        });
      }
    }
    return pages;
  }

  /**
   * `extends`: each entry must name a page and a proposal that were in the
   * pending set this job was handed (a revise may also repeat what its
   * proposal already extended). Returns the entries with the proposal's title
   * filled in from the runner's own record, never from the agent.
   */
  function checkExtends(report, pending, prior) {
    if (report.extends === undefined) return [];
    const bad = (why) => new JobError(`invalid run report: ${why}`, { retryable: true });
    if (!Array.isArray(report.extends)) throw bad('extends must be an array');
    const known = new Map();
    for (const e of prior || []) known.set(pairKey(e.slug, e.proposalId), e.title || '');
    for (const p of pending) known.set(pairKey(p.slug, p.proposalId), p.proposalTitle);
    const out = [];
    report.extends.forEach((e, i) => {
      if (!e || typeof e.slug !== 'string' || typeof e.proposalId !== 'string') throw bad(`extends[${i}] needs a slug and a proposalId`);
      const key = pairKey(e.slug, e.proposalId);
      if (!known.has(key)) throw bad(`extends[${i}] names a page or proposal that was not in the pending set`);
      if (!out.some((x) => pairKey(x.slug, x.proposalId) === key)) out.push({ slug: e.slug, proposalId: e.proposalId, title: known.get(key) });
    });
    return out;
  }

  /** Step 4: the run report. Missing or malformed is a failed run, retryable — agents do flake. */
  function readReport(wt, source, placed, { pending = [], prior = [] } = {}) {
    const file = path.join(wt, RUN_REPORT_PATH);
    if (!fs.existsSync(file)) throw new JobError(`agent finished without writing ${RUN_REPORT_PATH}`, { retryable: true });
    // job.error is readable through /api/jobs, so it never echoes report
    // contents — which the agent wrote and which may quote source text. A
    // fixed message, the byte offset of a parse error, and field names only.
    const text = fs.readFileSync(file, 'utf-8');
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (err) {
      const at = /position (\d+)/.exec(err.message)?.[1];
      throw new JobError(`run report is not valid JSON (${Buffer.byteLength(text)} bytes${at ? `, error at byte ${at}` : ''})`, { retryable: true });
    }
    let report;
    try { report = validateRunReport(parsed); }
    catch (err) {
      const problems = (err.problems || []).map((p) => p.replace(/\s*\(got [\s\S]*\)$/, '')).slice(0, 8);
      throw new JobError(`invalid run report: ${problems.join('; ').slice(0, 400) || 'not an object'}`, { retryable: true });
    }
    const expected = placed?.sha256 || source?.sha256;
    if (expected && report.source.sha256 && report.source.sha256 !== expected) {
      throw new JobError(`run report fingerprints ${report.source.id} as ${report.source.sha256.slice(0, 7)}… but the runner computed ${expected.slice(0, 7)}… — the agent must use the runner's sha256`);
    }
    return { ...report, extends: checkExtends(report, pending, prior) };
  }

  /** The original leaves the drop folder for processed/ — mechanically, so the agent needs no `mv`. */
  function moveToProcessed(wt, placed) {
    const src = path.join(wt, placed.path);
    if (!fs.existsSync(src)) return null;
    const rel = path.posix.join(path.posix.dirname(placed.path), 'processed', path.posix.basename(placed.path));
    const dest = path.join(wt, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { force: true });
    fs.renameSync(src, dest);
    return rel;
  }

  /**
   * The path guard: the agent wrote only where an ingest may write, and never
   * to a canonical page. `placed` is the original the runner itself copied
   * into the drop folder; it stays there when nothing was written
   * (blocked-only), and passes only while it still holds the runner's bytes.
   */
  async function guardPaths(wt, startSha, placed = null) {
    const allowed = writablePaths(config);
    const touched = await touchedPaths(wt, startSha);
    const placedFile = placed ? path.join(wt.path, placed.path) : '';
    const own = placed && !agentInstructionPath(placed.path) && fs.existsSync(placedFile)
      && (await sha256File(placedFile)) === placed.sha256 ? placed.path : null;
    const outside = touched.filter((p) => p !== own && !allowed.allowed(p));
    if (outside.length) {
      throw new JobError(`agent wrote outside the brain's writable paths: ${outside.slice(0, 10).join(', ')}${outside.length > 10 ? ', …' : ''} — not committed (agent instruction files such as CLAUDE.md or AGENTS.md are never writable)`);
    }
    // The canonical set as it is on main now: the config list plus every page
    // whose frontmatter on main says `tier: canonical`.
    const wikiPrefix = `${config.v1.brainDir.replace(/\/+$/, '')}/wiki/`;
    const pageSlug = (p) => (p.startsWith(wikiPrefix) && p.endsWith('.md') && !p.slice(wikiPrefix.length).includes('/') ? p.slice(wikiPrefix.length, -3) : '');
    const locked = await canonicalAt(git, config);
    const canonical = touched.filter((p) => locked.has(pageSlug(p)));
    if (canonical.length) {
      throw new JobError(`agent changed canonical page(s) ${canonical.join(', ')} — canonical pages are guardrails (non-negotiable 4); not committed`);
    }
    // An agent never makes a page canonical, new or existing: that is a
    // person's decision, made in the review inbox.
    const promoted = touched.filter((p) => {
      const slug = pageSlug(p);
      const file = path.join(wt.path, p);
      return slug && !locked.has(slug) && fs.existsSync(file) && canonicalOrUnsure(fs.readFileSync(file, 'utf-8'));
    });
    if (promoted.length) {
      throw new JobError(`agent set tier: canonical on ${promoted.join(', ')} — only a person makes a page canonical, in the review inbox (non-negotiable 4); not committed`);
    }
    return touched;
  }

  /**
   * The write guard for a learnings run: a synthesize job, or a revise of a
   * learnings proposal. The brain may add new claim pages and the bookkeeping
   * they need, and nothing else. Everything is compared with `main`, so a
   * revise may still rework the claim pages its own branch added.
   *
   *   - no page on main is edited, renamed or deleted; no other file changes
   *     (the manifest, sidecars, the challenges ledger and tools included)
   *   - at most synthesis.max_claims new pages
   *   - each new page is `type: claim`, `origin: self`, not canonical, and its
   *     `## Basis` names at least two pages on main that are `origin: source`
   *     and between them cite at least two different sources
   *   - a learning has no `sources` of its own, no citation (nor the text
   *     `[source:`) and a body of at most MAX_LEARNING_CHARS: the inbox shows
   *     each learning whole, and its tie to evidence is the Basis alone
   *   - `index.md` and `log.md` only gain whole lines: no existing line is
   *     removed, changed or moved (a placeholder row may give way to a real one)
   *   - not a learning a person turned down, unless a Basis page changed since
   */
  async function guardLearnings(wt, wtPath, startSha) {
    const brain = config.v1.brainDir.replace(/\/+$/, '');
    const wikiPrefix = `${brain}/wiki/`;
    const main = config.service.git.main;
    const indexDir = String(config.v1.indexDir || `${brain}/.index`).replace(/\/+$/, '');
    const bookkeeping = new Set([`${brain}/index.md`, `${brain}/log.md`]);
    const refuse = (message) => new JobError(`${message}; not committed`);

    const changes = [];
    const named = (await wt.run(['diff', '--name-status', '-z', '--no-renames', startSha, '--'])).split('\0').filter(Boolean);
    for (let i = 0; i + 1 < named.length; i += 2) changes.push({ status: named[i][0], path: named[i + 1] });
    for (const p of (await wt.run(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) changes.push({ status: 'A', path: p });

    const edited = [];
    const deleted = [];
    const elsewhere = [];
    for (const { status, path: p } of changes) {
      const isPage = p.startsWith(wikiPrefix) && p.endsWith('.md') && !p.slice(wikiPrefix.length).includes('/');
      if (isPage) {
        const onMain = (await git.show(main, p)) !== null;
        if (status === 'D') { if (onMain) deleted.push(p); }
        else if (onMain) edited.push(p);
      } else if (bookkeeping.has(p) || (p.startsWith(`${indexDir}/`) && p.endsWith('.tsv') && !p.slice(indexDir.length + 1).includes('/'))) {
        if (status === 'D') elsewhere.push(p);
      } else {
        elsewhere.push(p);
      }
    }
    const list = (xs) => `${xs.slice(0, 10).join(', ')}${xs.length > 10 ? ', …' : ''}`;
    if (edited.length) throw refuse(`learnings run edited existing page(s) ${list(edited)} — it may only add new claim pages and may not edit, rename or delete a page that is on ${main}`);
    if (deleted.length) throw refuse(`learnings run deleted or renamed existing page(s) ${list(deleted)} — it may only add new claim pages and may not edit, rename or delete a page that is on ${main}`);
    if (elsewhere.length) throw refuse(`learnings run changed ${list(elsewhere)} — it may write only new claim pages under ${wikiPrefix} and the index, the log and the derived index; the manifest, sources and every other file are off limits`);

    for (const p of bookkeeping) {
      if (!changes.some((c) => c.path === p)) continue;
      const before = await git.show(startSha, p);
      const file = path.join(wtPath, p);
      const after = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
      const lost = typeof before === 'string' ? firstLostLine(before, after) : null;
      if (lost !== null) {
        throw refuse(`learnings run changed an existing line of ${p} (“${lost.trim().slice(0, 80)}”) — it may only add whole lines to the index and the log, because the inbox shows added lines only`);
      }
      const misplaced = appendViolation(typeof before === 'string' ? before : '', after);
      if (misplaced !== null) {
        throw refuse(`learnings run added a line to ${p} (“${misplaced.slice(0, 80)}”) among the lines that were already there — it may only add rows after the last row of a table, because the inbox shows added lines only`);
      }
    }

    const onMain = new Set((await git.run(['ls-tree', '--name-only', main, '--', wikiPrefix])).split('\n').filter((f) => f.endsWith('.md')).map((f) => path.posix.basename(f, '.md')));
    const wikiAbs = path.join(wtPath, wikiPrefix);
    const fresh = (fs.existsSync(wikiAbs) ? fs.readdirSync(wikiAbs) : []).filter((f) => f.endsWith('.md') && !onMain.has(f.slice(0, -3))).map((f) => f.slice(0, -3)).sort();
    const cap = synthesisSettings(config).maxClaims;
    if (fresh.length > cap) throw refuse(`learnings run wrote ${fresh.length} new pages (${list(fresh)}) but synthesis.max_claims is ${cap}`);

    const basisPages = new Map();
    const basisPage = async (slug) => {
      if (!basisPages.has(slug)) {
        const text = await git.show(main, `${wikiPrefix}${slug}.md`);
        let page = null;
        try { page = typeof text === 'string' ? readPage(text) : null; } catch { page = null; }
        basisPages.set(slug, page);
      }
      return basisPages.get(slug);
    };

    const claimFields = config.v1.typeFields?.claim?.fields || [];
    for (const slug of fresh) {
      const file = path.join(wikiAbs, `${slug}.md`);
      const raw = fs.readFileSync(file, 'utf-8');
      // A person reads the page in the inbox and a chat reads it through a
      // filter: a character that reorders or hides text shows one to one and
      // another to the other. Checked on the raw text, front matter and body.
      const hidden = hiddenCharacter(raw);
      if (hidden) throw refuse(`learnings run wrote ${slug}.md with ${describeHidden(hidden)} — a learning may not carry characters that change the order of text or cannot be seen`);
      let page;
      try { page = readPage(raw); }
      catch (err) { throw refuse(`learnings run wrote ${slug}.md, whose front matter cannot be read (${String(err.message).split('\n')[0].slice(0, 120)})`); }
      if (page.type !== 'claim' || page.origin !== 'self') {
        throw refuse(`learnings run wrote ${slug}.md as type: ${page.type || 'none'}, origin: ${page.origin} — a learnings run writes only claim pages with origin: self`);
      }
      const ownSources = page.data.sources;
      if ((Array.isArray(ownSources) && ownSources.length) || (!Array.isArray(ownSources) && ownSources) || page.sources.length) {
        throw refuse(`learnings run wrote ${slug}.md with a non-empty \`sources\` of its own — a learning has no sources: its tie to evidence is its Basis`);
      }
      if (findCitations(page.body).length || page.body.includes('[source:')) {
        throw refuse(`learnings run wrote ${slug}.md with a citation (or the text “[source:”) in its body — a learning carries no inline citations: its tie to evidence is its Basis`);
      }
      if (page.body.trim().length > MAX_LEARNING_CHARS) {
        throw refuse(`learnings run wrote ${slug}.md with a body of ${page.body.trim().length} characters, over the limit of ${MAX_LEARNING_CHARS} characters — a learning is one conclusion a person reads whole`);
      }
      const frontProblem = frontMatterProblem(page, { claimFields, known: onMain });
      if (frontProblem) throw refuse(`learnings run wrote ${slug}.md and ${frontProblem}`);
      if (page.tier === 'canonical') throw refuse(`learnings run wrote ${slug}.md with tier: canonical — only a person makes a page canonical, in the review inbox (non-negotiable 4)`);
      const { slugs, missing } = basisOf(page.body, onMain);
      if (missing.length) throw refuse(`learnings run wrote ${slug}.md with Basis link(s) to ${list(missing)}, which are not pages on ${main} — a Basis names pages that already exist on ${main}`);
      const sourcePages = [];
      for (const s of slugs) {
        const bp = await basisPage(s);
        if (bp?.origin === 'source') sourcePages.push({ slug: s, ...bp });
      }
      if (sourcePages.length < 2) {
        throw refuse(`learnings run wrote ${slug}.md whose Basis has ${sourcePages.length} origin: source page${sourcePages.length === 1 ? '' : 's'} on ${main} (${slugs.length ? list(slugs) : 'none'}) — a learning rests on at least two source pages, never only on other claim pages`);
      }
      if (distinctSources(sourcePages) < 2) {
        throw refuse(`learnings run wrote ${slug}.md whose Basis pages (${list(sourcePages.map((b) => b.slug))}) cite one source between them — a learning needs at least two different sources`);
      }
      const hit = await turnedDown.blocking(slugs);
      if (hit) {
        throw refuse(`learnings run wrote ${slug}.md on a Basis (${list(hit.basis)}) that a person already turned down${hit.title ? ` as “${hit.title}”` : ''}, and none of those pages has changed since`);
      }
    }
    return { changes: changes.length, pages: fresh };
  }

  async function audit(wt, write) {
    const result = await runAudit(wt, { log: write, demandFile: config.paths.demand });
    if (result.exit !== 0) {
      throw new JobError(`${auditSummary(result)} — not committed; worktree kept at ${wt}`, { patch: { audit: result } });
    }
    return result;
  }

  async function commit(wt, job, message) {
    const requester = job.requester || (job.requestedBy ? { id: job.requestedBy } : null);
    const people = [requester, job.onBehalfOf ? { id: job.onBehalfOf } : null]
      .filter((a) => a && a.id && !String(a.id).startsWith('svc:'));
    const coAuthors = [...new Map(people.map((a) => [a.id, gitIdentity(a)])).values()];
    return wt.commitAll({ message, author: gitIdentity(SVC), coAuthors });
  }

  async function propose(job, details) {
    try { return await ctx.governance.createFromJob(job, details); }
    catch (err) {
      throw new JobError(`committed ${details.headSha.slice(0, 7)} on ${details.branch}, but governance.createFromJob failed: ${err.message}`, {
        patch: { headSha: details.headSha, baseSha: details.baseSha, audit: details.audit },
      });
    }
  }

  /** Nothing to review: drop a branch this job created and never committed to. */
  async function discard(wt, branch, createdBranch, baseSha) {
    if (!createdBranch) return;
    const head = await git.revParse(branch);
    if (head !== baseSha) return;
    try {
      await git.worktreeRemove(wt, { force: true });
      await git.run(['branch', '-D', branch]);
    } catch (err) { log.warn('could not discard empty ingest branch', { branch, error: err.message }); }
  }

  async function runDriver(job, args, timeoutMs, signal, write) {
    const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
    const both = AbortSignal.any([signal, timeout]);
    const aborted = new Promise((_, reject) => {
      const fail = () => reject(timeout.aborted
        ? new JobError(`agent timed out after ${Math.round(timeoutMs / 600) / 100} min — killed`, { retryable: true })
        : Object.assign(new Error('aborted'), { aborted: true, reason: signal.reason }));
      if (both.aborted) fail();
      else both.addEventListener('abort', fail, { once: true });
    });
    // A driver that ignores its signal still loses the race; the child it
    // spawned was handed the same signal and is killed by proc.mjs.
    const result = await Promise.race([driver.run({ ...args, signal: both, timeoutMs }), aborted]);
    if (timeout.aborted) throw new JobError(`agent timed out after ${Math.round(timeoutMs / 600) / 100} min — killed`, { retryable: true });
    if (signal.aborted) throw Object.assign(new Error('aborted'), { aborted: true, reason: signal.reason });
    write(`driver ${driver.name} → ok=${result.ok}${result.costUsd !== undefined ? ` cost=$${result.costUsd}` : ''} ${result.durationMs}ms${result.error ? ` error=${result.error}` : ''}`);
    if (!result.ok) throw new JobError(`driver ${driver.name} failed: ${result.error || 'no detail'}`, { retryable: true, patch: { costUsd: result.costUsd } });
    return result;
  }

  // ── agent jobs: ingest / revise / reverify ────────────────────────────────

  async function runAgentJob(job, { signal, write, timeoutMs, patchJob }) {
    if (job.kind === 'synthesize' && !synthesisSettings(config).enabled) {
      throw new JobError('synthesis is turned off (synthesis.enabled: false) — nothing was run');
    }
    const t = await target(job);
    const learningsRun = job.kind === 'synthesize' || t.proposal?.kind === 'learnings';
    return withBranchLock(t.branch, async () => {
      write(`step 1: branch ${t.branch}${t.proposal ? ` (proposal ${t.proposal.id})` : ''}`);
      const { worktree: wt, wt: repo, startSha, createdBranch } = await prepareWorktree(t.branch);
      const refsBefore = await watchedRefs();
      const baseSha = await baseShaFor(t.branch, t.proposal);
      const created = job.createdBranch ?? createdBranch;
      job = await patchJob({ branch: t.branch, worktree: wt, baseSha, createdBranch: created });

      let placed = null;
      if (job.kind === 'ingest' && t.source && !t.proposal) {
        try { placed = await placeSource(ctx, t.source, wt); }
        catch (err) { throw new JobError(`could not place source: ${err.message}`); }
        write(`step 2: placed ${placed.path} (${placed.sha256.slice(0, 7)}…, ${placed.bytes} bytes)`);
      }

      // The agent's self-check audit: a fixed wrapper outside the worktree,
      // written fresh for this job (audit.mjs → writeAuditWrapper).
      const wrapper = await writeAuditWrapper({
        dir: path.join(config.paths.state, 'runner', job.id),
        worktree: wt,
        configFile: path.join(wt, 'brain.config.yaml'),
        demandFile: config.paths.demand,
      });
      let result;
      let pending = [];
      try {
        pending = await collectPending(job, t, wt);
        if (pending.length) write(`pending: ${pending.length} page(s) in ${new Set(pending.map((p) => p.proposalId)).size} other open proposal(s) handed to the agent under ${PENDING_DIR}`);
        const tools = claudeAllowedTools(config, { auditWrapper: wrapper.path });
        const { prompt, systemPrompt } = buildPrompt({
          job, source: t.source, placed, branch: t.branch, proposal: t.proposal,
          auditCommand: wrapper.path, allowedTools: tools, pending,
          learnings: learningsRun ? { cap: synthesisSettings(config).maxClaims, turnedDown: await turnedDown.standing() } : null,
        });
        write(`step 3: driver ${driver.name}, model ${modelFor(config, driver.name) || '(default)'}, budget $${config.ingest.budget_usd_per_job}`);
        result = await runDriver(job, {
          cwd: wt, prompt, systemPrompt, allowedTools: tools,
          model: modelFor(config, driver.name), budgetUsd: config.ingest.budget_usd_per_job,
          logStream: write.stream, job, source: t.source, sourcePath: placed?.path,
        }, timeoutMs, signal, write);
        if (!wrapperIntact(wrapper)) {
          throw new JobError('the audit wrapper changed during the run — something the agent ran could write outside the worktree; nothing committed, inspect the job log');
        }
      } finally {
        fs.rmSync(wrapper.dir, { recursive: true, force: true });
        // Other proposals' text is for the agent to read, never to commit:
        // gone as soon as the agent is, whether it finished or not.
        fs.rmSync(path.join(wt, PENDING_DIR), { recursive: true, force: true });
      }
      // First thing after the agent: is `.git` still what git wrote? Every git
      // command below checks again; this fails before anything else runs.
      repo.check();

      const report = readReport(wt, t.source, placed, { pending, prior: t.proposal?.extends });
      fs.mkdirSync(path.join(logsDir, '..', 'reports'), { recursive: true });
      fs.writeFileSync(path.join(logsDir, '..', 'reports', `${job.id}.json`), JSON.stringify(report, null, 2));
      // The report has been read; it is not part of the diff. Removing it
      // rather than trusting .gitignore means a brain whose ignore file lost
      // `.almagest/` still never commits it.
      fs.rmSync(path.join(wt, '.almagest'), { recursive: true, force: true });
      write(`step 4: run report — outcome ${report.outcome}, ${report.pages.length} page(s), ${report.blocked.length} blocked`);
      job = await patchJob({ runReport: report, costUsd: result.costUsd });

      // The full notes are in the saved report; the error carries a short, single-line excerpt.
      if (report.outcome === 'failed') throw new JobError(`agent reported failure: ${String(report.notes || 'no notes').replace(/\s+/g, ' ').slice(0, 200)}`);
      if (report.outcome === 'unchanged' && report.blocked.length === 0) {
        await discard(wt, t.branch, created, baseSha);
        return { status: 'succeeded', note: 'unchanged — nothing to review' };
      }
      // Only a local original moves. A connector snapshot already sits at its
      // committed sidecar path, which every citation points at.
      if (report.outcome === 'written' && placed && t.source.kind === 'local') {
        const moved = moveToProcessed(wt, placed);
        if (moved) write(`moved ${placed.path} → ${moved}`);
      }

      const touched = await guardPaths(repo, startSha, placed);
      write(`path guard: ${touched.length} path(s), all writable`);
      if (learningsRun) {
        const learned = await guardLearnings(repo, wt, startSha);
        write(`learnings guard: ${learned.pages.length} new claim page(s), no existing page touched`);
      }
      const auditResult = await audit(wt, write);

      const headBefore = await repo.revParse('HEAD');
      const sha = await commit(repo, job, commitMessage(job, t, report, driver.name));
      await verifyCommit(repo, t.branch, sha, refsBefore, job);
      const headSha = sha || headBefore;
      write(sha ? `step 6: committed ${sha.slice(0, 7)} on ${t.branch}` : 'step 6: nothing to commit');
      if (!sha && report.blocked.length === 0) {
        await discard(wt, t.branch, created, baseSha);
        return { status: 'succeeded', audit: auditResult, note: 'no changes — nothing to review' };
      }

      job = await patchJob({ headSha, audit: auditResult });
      const proposal = await propose(job, { worktree: wt, branch: t.branch, baseSha, headSha, audit: auditResult, runReport: report });
      write(`step 7: proposal ${proposal?.id}`);
      return {
        status: report.outcome === 'blocked-only' ? 'blocked' : 'succeeded',
        proposalId: proposal?.id || job.proposalId, headSha, audit: auditResult,
      };
    });
  }

  // ── drop-page: mechanical, no agent ───────────────────────────────────────

  async function runDropPage(job, { write, patchJob }) {
    const t = await target(job);
    const slugs = [...new Set([job.slug, ...(job.slugs || [])].filter(Boolean))];
    if (slugs.length === 0) throw new JobError('drop-page needs `slug` (or `slugs`) naming the page to drop');
    return withBranchLock(t.branch, async () => {
      const { worktree: wt, wt: repo, startSha } = await prepareWorktree(t.branch);
      const refsBefore = await watchedRefs();
      const baseSha = await baseShaFor(t.branch, t.proposal);
      job = await patchJob({ branch: t.branch, worktree: wt, baseSha });
      const brain = config.v1.brainDir;

      for (const slug of slugs) {
        const change = (t.proposal.changes || []).find((c) => c.slug === slug);
        const rel = change?.path || `${brain}/wiki/${slug}.md`;
        const before = await git.show(baseSha, rel);
        const file = path.join(wt, rel);
        if (!isInside(wt, path.resolve(file))) throw new JobError(`refusing to touch ${rel}: outside the worktree`);
        if (before !== null) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, before);
          write(`restored ${rel} to ${baseSha.slice(0, 7)}`);
        } else {
          fs.rmSync(file, { force: true });
          dropReferences(wt, slug);
          write(`removed ${rel} (created on this branch) and its index.md / manifest references`);
        }
      }
      const logFile = path.join(wt, brain, 'log.md');
      if (fs.existsSync(logFile)) {
        const actor = job.requester?.display || job.requestedBy || 'a reviewer';
        fs.writeFileSync(logFile, appendTableRow(fs.readFileSync(logFile, 'utf-8'), /^#\s+Log\b/, '| Date | Action | Details |\n|------|--------|---------|',
          `| ${nowIso().slice(0, 10)} | drop-page | ${slugs.join(', ')} dropped from \`${t.branch}\` — rejected by ${actor} |`));
      }

      await guardPaths(repo, startSha);
      const auditResult = await audit(wt, write);
      const sha = await commit(repo, job, `drop-page: ${slugs.join(', ')} from ${t.branch}\n\nJob: ${job.id} (trigger ${job.trigger})\nProposal: ${t.proposal.id}\nRestored to ${baseSha.slice(0, 7)} or removed if created on the branch.`);
      await verifyCommit(repo, t.branch, sha, refsBefore, job);
      const headSha = sha || (await repo.revParse('HEAD'));
      write(sha ? `committed ${sha.slice(0, 7)}` : 'nothing to commit — page already matched base');
      job = await patchJob({ headSha, audit: auditResult });
      const proposal = await propose(job, { worktree: wt, branch: t.branch, baseSha, headSha, audit: auditResult, runReport: null });
      return { status: 'succeeded', proposalId: proposal?.id || t.proposal.id, headSha, audit: auditResult };
    });
  }

  /** A page that no longer exists must not be listed by index.md (PROV-004) or the manifest (PROV-002). */
  function dropReferences(wt, slug) {
    const brain = config.v1.brainDir;
    const index = path.join(wt, brain, 'index.md');
    if (fs.existsSync(index)) {
      const text = fs.readFileSync(index, 'utf-8');
      const next = removeTableRowsFor(text, /^##\s+Wiki pages/i, slug);
      if (next !== text) fs.writeFileSync(index, next);
    }
    const manifest = path.join(wt, config.v1.manifestPath);
    if (fs.existsSync(manifest)) {
      const doc = YAML.parseDocument(fs.readFileSync(manifest, 'utf-8'));
      let changed = false;
      for (const item of doc.get('sources')?.items || []) {
        const pages = item?.get?.('pages');
        if (!pages?.items) continue;
        const keep = pages.items.filter((p) => String(p?.value ?? p) !== slug);
        if (keep.length !== pages.items.length) { pages.items = keep; changed = true; }
      }
      if (changed) fs.writeFileSync(manifest, doc.toString());
    }
  }

  return {
    async run(job, opts) {
      try { return await (job.kind === 'drop-page' ? runDropPage(job, opts) : runAgentJob(job, opts)); }
      catch (err) {
        if (!(err instanceof WorktreeTamperedError)) throw err;
        log.error('worktree .git tampered with — job failed, nothing committed', { job: job.id, dotGit: err.dotGit, content: String(err.content || '').slice(0, 200) });
        throw tamperedJob(err, path.dirname(err.dotGit));
      }
    },
  };
}

function commitMessage(job, t, report, driverName) {
  // Every value below can carry text a person or an agent chose: a chat's
  // source title, the agent's page summary, a decision's question. Each is
  // one line with a length cap, so none can add a line or a trailer to a
  // message whose branch becomes the second parent of a merge on main.
  const src = t.source;
  const one = (v, max = 160) => oneLine(v, max);
  const subject = job.kind === 'ingest'
    ? `ingest: ${one(src?.title || src?.id || 'source', 120)}${src?.sha256 ? ` (${one(src.sha256.slice(0, 7), 7)})` : ''}`
    : job.kind === 'synthesize'
      ? `synthesize: learnings from ${one(String(t.branch).replace(/^ingest\/learnings_/, ''), 40)}`
      : `${one(job.kind, 20)}: ${one(t.proposal?.id || src?.id || job.id, 100)}`;
  const lines = [
    subject, '',
    `Job: ${one(job.id, 60)} (trigger ${one(job.trigger, 30)}, attempt ${Number(job.attempts) || 1})`,
    `Driver: ${one(driverName, 40)}`,
    `Outcome: ${one(report.outcome, 30)} — ${report.pages.length} page(s), ${report.blocked.length} blocked`,
    ...report.pages.map((p) => `- ${one(p.action, 20)} ${one(p.slug, 100)}${p.summary ? `: ${one(p.summary, 200)}` : ''}`),
    ...report.blocked.map((b) => `- blocked (${one(b.kind, 30)}) ${one(b.slug || '', 100)}: ${one(b.question, 200)}`),
  ];
  return lines.join('\n');
}
