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
 */
import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { serviceActor } from '../core/auth.mjs';
import { modelForTier } from '../core/config.mjs';
import { gitIdentity } from '../core/git.mjs';
import { ingestBranch, nowIso, slugify, validateRunReport } from '../core/schemas.mjs';
import { AUDIT_SCRIPT, auditSummary, runAudit } from './audit.mjs';
import { allowedTools as claudeAllowedTools } from './drivers/claude-code.mjs';
import { appendTableRow, removeTableRowsFor } from './md.mjs';
import { buildPrompt, RUN_REPORT_PATH } from './prompt.mjs';
import { isInside, placeSource, realish } from './source.mjs';

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
const CLOSED_PROPOSAL = new Set(['merged', 'rejected', 'superseded']);

function modelFor(config, driverName) {
  if (config.ingest.model) return String(config.ingest.model);
  // A tier resolves through the profile of the harness the DRIVER runs, not
  // agent.harness: an instance configured for codex in the IDE can still run
  // claude-code in the background, and a codex model name would break it.
  return modelForTier({ agent: { ...config.agent, harness: driverName } }, config.ingest.model_tier || 'judgment');
}

/** Files the agent may change, relative to the worktree. Everything else fails the job. */
function writablePaths(config) {
  const brain = config.v1.brainDir.replace(/\/+$/, '');
  return {
    prefixes: [`${brain}/wiki/`, `${brain}/raw/`, `${brain}/.index/`],
    files: new Set([`${brain}/index.md`, config.v1.manifestPath, `${brain}/log.md`, config.v1.raw?.audit?.challenges_path || `${brain}/canonical-challenges.md`]),
    canonical: new Set(config.v1.canonicalPages.map((s) => `${brain}/wiki/${s}.md`)),
  };
}

/** `git status --porcelain -z` → every path touched, renames counted on both sides. */
async function touchedPaths(git, cwd) {
  const out = await git.run(['status', '--porcelain', '-z', '--untracked-files=all'], { cwd });
  const parts = out.split('\0').filter(Boolean);
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const xy = parts[i].slice(0, 2);
    paths.push(parts[i].slice(3));
    if (xy.includes('R') || xy.includes('C')) paths.push(parts[++i]);
  }
  return paths;
}

export function createRunner(ctx, { driver, logsDir }) {
  const { config, git, log } = ctx;
  const branchLocks = new Map();

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
    const source = job.source || { id: `${job.kind}-${slugify(job.slug || job.instructions || 'pages')}`, sha256: (await git.revParse(config.service.git.main)).slice(0, 12) };
    return { proposal: null, branch: job.branch || ingestBranch(source), source: job.source || null };
  }

  /**
   * A clean worktree for `branch` under worktree_dir. A reused worktree is
   * reset to the branch head first — a previous failed attempt's leftovers
   * are inspection material, not input to the next run.
   */
  async function prepareWorktree(branch) {
    await git.run(['worktree', 'prune']);
    const existed = await git.branchExists(branch);
    const wt = await git.worktreeAdd(branch, { base: config.service.git.main });
    const root = realish(config.paths.worktrees);
    if (!isInside(root, realish(wt))) {
      throw new JobError(`branch ${branch} is checked out at ${wt}, outside ${config.service.git.worktree_dir} — the runner never works in someone else's checkout`);
    }
    await git.run(['reset', '--hard', '--quiet', 'HEAD'], { cwd: wt });
    await git.run(['clean', '-fdq'], { cwd: wt });
    fs.rmSync(path.join(wt, '.almagest'), { recursive: true, force: true });
    return { worktree: wt, createdBranch: !existed };
  }

  async function baseShaFor(branch, proposal) {
    if (proposal?.baseSha) return proposal.baseSha;
    return git.mergeBase(config.service.git.main, branch);
  }

  /** Step 4: the run report. Missing or malformed is a failed run, retryable — agents do flake. */
  function readReport(wt, source, placed) {
    const file = path.join(wt, RUN_REPORT_PATH);
    if (!fs.existsSync(file)) throw new JobError(`agent finished without writing ${RUN_REPORT_PATH}`, { retryable: true });
    let report;
    try { report = validateRunReport(JSON.parse(fs.readFileSync(file, 'utf-8'))); }
    catch (err) { throw new JobError(`invalid run report: ${err.message}`, { retryable: true }); }
    const expected = placed?.sha256 || source?.sha256;
    if (expected && report.source.sha256 && report.source.sha256 !== expected) {
      throw new JobError(`run report fingerprints ${report.source.id} as ${report.source.sha256.slice(0, 7)}… but the runner computed ${expected.slice(0, 7)}… — the agent must use the runner's sha256`);
    }
    return report;
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

  /** The path guard: the agent wrote only where an ingest may write, and never to a canonical page. */
  async function guardPaths(wt) {
    const allowed = writablePaths(config);
    const touched = await touchedPaths(git, wt);
    const outside = touched.filter((p) => !allowed.files.has(p) && !allowed.prefixes.some((pre) => p.startsWith(pre)));
    if (outside.length) {
      throw new JobError(`agent wrote outside the brain's writable paths: ${outside.slice(0, 10).join(', ')}${outside.length > 10 ? ', …' : ''} — not committed`);
    }
    const canonical = touched.filter((p) => allowed.canonical.has(p));
    if (canonical.length) {
      throw new JobError(`agent changed canonical page(s) ${canonical.join(', ')} — canonical pages are guardrails (non-negotiable 4); not committed`);
    }
    return touched;
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
    return git.commitAll(wt, { message, author: gitIdentity(SVC), coAuthors });
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
    const t = await target(job);
    return withBranchLock(t.branch, async () => {
      write(`step 1: branch ${t.branch}${t.proposal ? ` (proposal ${t.proposal.id})` : ''}`);
      const { worktree: wt, createdBranch } = await prepareWorktree(t.branch);
      const baseSha = await baseShaFor(t.branch, t.proposal);
      const created = job.createdBranch ?? createdBranch;
      job = await patchJob({ branch: t.branch, worktree: wt, baseSha, createdBranch: created });

      let placed = null;
      if (job.kind === 'ingest' && t.source && !t.proposal) {
        try { placed = await placeSource(ctx, t.source, wt); }
        catch (err) { throw new JobError(`could not place source: ${err.message}`); }
        write(`step 2: placed ${placed.path} (${placed.sha256.slice(0, 7)}…, ${placed.bytes} bytes)`);
      }

      const tools = claudeAllowedTools(config);
      const { prompt, systemPrompt } = buildPrompt({
        job, source: t.source, placed, branch: t.branch, proposal: t.proposal,
        auditCommand: `node ${AUDIT_SCRIPT} --repo ${wt}`, allowedTools: tools,
      });
      write(`step 3: driver ${driver.name}, model ${modelFor(config, driver.name) || '(default)'}, budget $${config.ingest.budget_usd_per_job}`);
      const result = await runDriver(job, {
        cwd: wt, prompt, systemPrompt, allowedTools: tools,
        model: modelFor(config, driver.name), budgetUsd: config.ingest.budget_usd_per_job,
        logStream: write.stream, job, source: t.source, sourcePath: placed?.path,
      }, timeoutMs, signal, write);

      const report = readReport(wt, t.source, placed);
      fs.mkdirSync(path.join(logsDir, '..', 'reports'), { recursive: true });
      fs.writeFileSync(path.join(logsDir, '..', 'reports', `${job.id}.json`), JSON.stringify(report, null, 2));
      // The report has been read; it is not part of the diff. Removing it
      // rather than trusting .gitignore means a brain whose ignore file lost
      // `.almagest/` still never commits it.
      fs.rmSync(path.join(wt, '.almagest'), { recursive: true, force: true });
      write(`step 4: run report — outcome ${report.outcome}, ${report.pages.length} page(s), ${report.blocked.length} blocked`);
      job = await patchJob({ runReport: report, costUsd: result.costUsd });

      if (report.outcome === 'failed') throw new JobError(`agent reported failure: ${report.notes || 'no notes'}`);
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

      const touched = await guardPaths(wt);
      write(`path guard: ${touched.length} path(s), all writable`);
      const auditResult = await audit(wt, write);

      const headBefore = await git.revParse('HEAD', { cwd: wt });
      const sha = await commit(wt, job, commitMessage(job, t, report, driver.name));
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
      const { worktree: wt } = await prepareWorktree(t.branch);
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

      await guardPaths(wt);
      const auditResult = await audit(wt, write);
      const sha = await commit(wt, job, `drop-page: ${slugs.join(', ')} from ${t.branch}\n\nJob: ${job.id} (trigger ${job.trigger})\nProposal: ${t.proposal.id}\nRestored to ${baseSha.slice(0, 7)} or removed if created on the branch.`);
      const headSha = sha || (await git.revParse('HEAD', { cwd: wt }));
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
      return job.kind === 'drop-page' ? runDropPage(job, opts) : runAgentJob(job, opts);
    },
  };
}

function commitMessage(job, t, report, driverName) {
  const src = t.source;
  const subject = job.kind === 'ingest'
    ? `ingest: ${src?.title || src?.id || 'source'}${src?.sha256 ? ` (${src.sha256.slice(0, 7)})` : ''}`
    : `${job.kind}: ${t.proposal?.id || src?.id || job.id}`;
  const lines = [
    subject, '',
    `Job: ${job.id} (trigger ${job.trigger}, attempt ${job.attempts || 1})`,
    `Driver: ${driverName}`,
    `Outcome: ${report.outcome} — ${report.pages.length} page(s), ${report.blocked.length} blocked`,
    ...report.pages.map((p) => `- ${p.action} ${p.slug}${p.summary ? `: ${p.summary}` : ''}`),
    ...report.blocked.map((b) => `- blocked (${b.kind}) ${b.slug || ''}: ${b.question}`),
  ];
  return lines.join('\n');
}
