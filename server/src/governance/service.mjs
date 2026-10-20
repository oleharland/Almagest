/**
 * service.mjs — ctx.governance: proposals, decisions, approvals, merges.
 *
 * Every mutation runs under one mutex (proposal documents are read-modify-
 * write, and merges must be serialised anyway), writes an append-only audit
 * entry, and emits a bus event that channels turn into notifications.
 *
 * The order inside each action is deliberate: identity checks first
 * (assertCanApprove — agents never get past the first line), then policy, then
 * side effects that can fail (enqueueing a job), and only then the state
 * change. A request that cannot be carried out leaves nothing half-done.
 */
import fs from 'node:fs';
import path from 'node:path';

import { assertCanApprove, ForbiddenError, hasRole, serviceActor } from '../core/auth.mjs';
import { gitIdentity } from '../core/git.mjs';
import { HttpError } from '../core/http.mjs';
import { newId, nowIso } from '../core/schemas.mjs';
import { NotFoundError } from '../core/store/index.mjs';
import { attachDemand, buildChanges } from './builder.mjs';
import { appendChallenge, challengeFrom, challengeRow } from './challenges.mjs';
import { normalizeAudit, runAudit } from './merge.mjs';
import * as policy from './policy.mjs';
import { describe, titleFor } from './summary.mjs';

/** canonical_conflict has exactly one non-dismiss effect (spec → Decision). Enforced by construction. */
export const CANONICAL_OPTIONS = [
  { id: 'record', label: 'Record it as a challenge to the locked page (the page itself stays as it is)', effect: 'append a row to brain/canonical-challenges.md' },
  { id: 'dismiss', label: 'Dismiss it — the new material is wrong', effect: 'none' },
];

const NOOP_EFFECT = /^\s*(none|no-?op|nothing)?\s*$/i;

function submittersFromJob(job) {
  const ids = [job.requestedBy, job.onBehalfOf?.id ?? job.onBehalfOf, job.requestedFor, job.source?.submittedBy];
  return [...new Set(ids.filter((v) => typeof v === 'string' && v))];
}

function approvalRecord(actor, { scope, channel, headSha }) {
  return {
    actorId: actor.id, display: actor.display || actor.id, email: actor.email || '', kind: actor.kind,
    roles: [...(actor.roles || [])], teams: [...(actor.teams || [])], idp: actor.idp || '',
    at: nowIso(), scope, channel, headSha,
  };
}

export function createService(ctx, { merger, confirmations, lock }) {
  const { store, bus, git, config, log } = ctx;
  const gov = config.governance;
  const rules = policy.validateRules(gov.rules || []);
  const options = { separationOfDuties: Boolean(gov.separation_of_duties) };
  const requireSso = Boolean(gov.require_sso_for_approval);
  const wikiDir = `${config.v1.brainDir}/wiki`;
  const svc = serviceActor('governance');

  const labelFor = (source) => (config.sources.connectors || []).find((c) => c.id === source?.connector)?.label || '';

  // Audit ids sort by time; keep them strictly increasing so two entries in
  // the same millisecond still list in the order they happened.
  let lastAuditMs = 0;
  async function record(action, actor, target, channel, detail = {}) {
    lastAuditMs = Math.max(Date.now(), lastAuditMs + 1);
    try {
      await store.audit.append({
        id: newId('aud', lastAuditMs), ts: nowIso(), actorId: actor?.id || 'unknown', action, target,
        channel: channel || 'web', detail: { actor: actor?.display || actor?.id || '', ...detail },
      });
    } catch (err) {
      log.error('governance audit append failed', { action, target, error: err.message });
      throw err;
    }
  }

  async function load(id) {
    const p = await store.proposals.get(id);
    if (!p) throw new NotFoundError('proposal', id);
    return p;
  }

  function assertLive(p) {
    if (!policy.LIVE.includes(p.status)) {
      throw new HttpError(409, `This proposal is ${policy.STATUS_WORDS[p.status] || p.status} — there is nothing left to do on it.`);
    }
  }

  async function enqueue(spec) {
    if (!ctx.ingest?.enqueue) return null;
    try {
      return await ctx.ingest.enqueue(spec);
    } catch (err) {
      log.error('could not enqueue governance job', { kind: spec.kind, proposal: spec.proposalId, error: err.message });
      return null;
    }
  }

  function makeDecision(proposalId, b) {
    return {
      id: newId('dec'), proposalId, kind: b.kind, slug: b.slug || '', question: b.question,
      context: { claimA: b.claimA || '', sourceA: b.sourceA || '', claimB: b.claimB || '', sourceB: b.sourceB || '' },
      options: b.kind === 'canonical_conflict' ? CANONICAL_OPTIONS.map((o) => ({ ...o })) : (b.options || []).map((o) => ({ id: String(o.id), label: String(o.label), effect: String(o.effect || '') })),
      status: 'open', createdAt: nowIso(), ...(b.auto ? { auto: true } : {}),
    };
  }

  // ── proposals ──────────────────────────────────────────────────────────────

  /** createFromJob without the lock — also used to refresh after a service commit. */
  async function upsert(job, info = {}) {
    const branch = info.branch || job.branch;
    if (!branch) throw new Error('createFromJob needs the job\'s branch');
    const headSha = info.headSha || (await git.revParse(branch));
    const baseSha = info.baseSha || (await git.mergeBase(config.service.git.main, headSha));
    const existing = await store.proposals.getByBranch(branch);
    const live = existing && policy.LIVE.includes(existing.status) ? existing : null;
    if (!live && existing && job.proposalId && job.proposalId === existing.id) {
      // A revise / drop-page job that finished after its proposal was merged or
      // turned down. It must not bring the proposal back.
      log.warn('ignoring a late job for a closed proposal', { proposal: existing.id, status: existing.status, job: job.id });
      return existing;
    }

    const { changes, otherFiles } = await buildChanges({ git, baseSha, headSha, wikiDir, canonicalPages: config.v1.canonicalPages });
    await attachDemand(changes, ctx.demand, log);
    if (live) {
      for (const c of changes) {
        const prev = (live.changes || []).find((x) => x.slug === c.slug);
        if (prev?.pageStatus === 'rejected') c.pageStatus = 'rejected';
        else if (prev?.pageStatus === 'accepted' && live.headSha === headSha) c.pageStatus = 'accepted';
      }
    }

    const runReport = info.runReport || job.runReport || {};
    const source = job.source || live?.source || null;
    const proposalId = live?.id || newId('prp');
    const prior = live ? await store.decisions.listByProposal(live.id) : [];
    const created = [];
    const known = () => [...prior, ...created];
    for (const b of runReport.blocked || []) {
      if (known().some((d) => d.kind === b.kind && (d.slug || '') === (b.slug || '') && d.question === b.question)) continue;
      created.push(makeDecision(proposalId, b));
    }
    // A proposal that edits a canonical page gets a challenge card of its own:
    // the page change can never merge, but the evidence must not vanish (rule 3).
    for (const c of changes.filter((x) => x.canonical && x.pageStatus !== 'rejected')) {
      if (known().some((d) => d.kind === 'canonical_conflict' && d.slug === c.slug)) continue;
      const claim = c.claims.find((x) => x.op !== 'remove');
      created.push(makeDecision(proposalId, {
        kind: 'canonical_conflict', slug: c.slug, auto: true,
        question: `This proposal changes the locked reference page “${c.title}”. Locked pages are never changed by a proposal. Should the new material be recorded as a challenge to it?`,
        claimA: c.claims.find((x) => x.before)?.before || '',
        claimB: claim?.text || `Proposed edits to ${c.slug}`,
        sourceB: claim?.citation ? `${claim.citation.id}, ${claim.citation.locator}` : source?.id || '',
      }));
    }
    for (const d of created) await store.decisions.create(d);
    const decisions = known();

    const now = nowIso();
    const fields = {
      jobId: job.id || live?.jobId || '', branch, baseSha, headSha,
      worktree: info.worktree || job.worktree || live?.worktree || '',
      title: titleFor(source), source,
      audit: normalizeAudit(info.audit ?? job.audit),
      changes, otherFiles,
      decisions: decisions.map((d) => d.id),
      notes: runReport.notes || '',
      reportPages: runReport.pages || [],
      updatedAt: now,
    };
    fields.required = policy.computeRequirements({ changes, decisions, source, label: labelFor(source), rules });
    fields.summary = describe(fields, decisions).sentence;

    let proposal;
    if (live) {
      proposal = await store.proposals.update(live.id, {
        ...fields, status: 'open', mergeError: null,
        revision: (live.revision || 1) + (live.headSha === headSha ? 0 : 1),
      });
      await record('proposal.update', { id: job.requestedBy || svc.id }, proposal.id, 'cli', { headSha, jobId: fields.jobId });
      bus.emit('proposal.updated', { proposal });
    } else {
      proposal = await store.proposals.create({
        id: proposalId, ...fields, status: 'open',
        submittedBy: job.requestedBy || 'unknown', submitters: submittersFromJob(job),
        approvals: [], revision: 1, createdAt: now,
      });
      await record('proposal.create', { id: job.requestedBy || svc.id }, proposal.id, 'cli', { headSha, jobId: fields.jobId });
      await supersedeOlder(proposal);
      bus.emit('proposal.created', { proposal });
    }
    for (const decision of created) bus.emit('decision.created', { decision, proposal });
    return proposal;
  }

  /** A newer proposal for the same source replaces older live ones from other branches. */
  async function supersedeOlder(p) {
    if (!p.source?.id) return;
    const live = await store.proposals.list({ status: policy.LIVE });
    for (const old of live) {
      if (old.id === p.id || old.branch === p.branch || old.source?.id !== p.source.id) continue;
      const updated = await store.proposals.update(old.id, { status: 'superseded', supersededBy: p.id, updatedAt: nowIso() });
      await record('proposal.supersede', svc, old.id, 'cli', { by: p.id });
      bus.emit('proposal.updated', { proposal: updated });
    }
  }

  function createFromJob(job, info = {}) {
    return lock(() => upsert(job, info));
  }

  // ── evaluation & merge ─────────────────────────────────────────────────────

  async function evaluateProposal(p) {
    const decisions = await store.decisions.listByProposal(p.id);
    return { decisions, evaluation: policy.evaluate({ proposal: p, decisions, options }) };
  }

  async function doMerge(p, actor, evaluation, channel) {
    const approvers = evaluation.approvers;
    let result;
    try {
      result = await merger.merge(p, { approvers, author: gitIdentity(actor) });
    } catch (err) {
      log.error('merge failed', { proposal: p.id, error: err.stack || err.message });
      result = { ok: false, reason: 'error', message: `Something went wrong while adding this: ${err.message}` };
    }

    if (result.ok) {
      const merged = await store.proposals.update(p.id, {
        status: 'merged', mergeError: null, updatedAt: nowIso(),
        merge: {
          sha: result.sha, at: nowIso(), by: actor.id, approvers: approvers.map((a) => a.actorId),
          method: result.method, pushed: result.pushed, headSha: p.headSha,
          audit: { exit: result.audit.exit, errors: result.audit.errors, warnings: result.audit.warnings },
        },
      });
      await record('proposal.merge', actor, p.id, channel, { sha: result.sha, headSha: p.headSha, approvers: approvers.map((a) => a.actorId), method: result.method });
      bus.emit('proposal.merged', { proposal: merged, actor });
      return merged;
    }

    let status = 'approved';
    let job = null;
    if (result.reason === 'conflict' || result.reason === 'audit') {
      status = 'conflicted';
      const why = result.reason === 'conflict'
        ? `These files clash with changes merged into main since this branch was made: ${result.files.join(', ')}.`
        : `Merged with the current main, the audit fails:\n${(result.audit?.findings || []).filter((f) => f.severity === 'error').slice(0, 20).map((f) => `- ${f.id} ${f.slug || ''}: ${f.message}`).join('\n')}`;
      job = await enqueue({
        kind: 'revise', source: p.source, trigger: 'feedback', requestedBy: svc.id, proposalId: p.id, reason: result.reason,
        instructions: `${why}\n\nBring this branch up to date with main and redo the affected changes so it merges cleanly and passes the audit. Keep the reviewed content unless it conflicts.`,
      });
    } else if (result.reason === 'stale') {
      status = p.status;
    }
    const message = job || !['conflict', 'audit'].includes(result.reason)
      ? result.message
      : `${result.message} (The request to the agent could not be queued — ask an administrator.)`;
    const updated = await store.proposals.update(p.id, { status, mergeError: { reason: result.reason, message, at: nowIso(), ...(result.files ? { files: result.files } : {}) }, updatedAt: nowIso() });
    await record('proposal.merge_failed', actor, p.id, channel, { reason: result.reason, headSha: p.headSha, jobId: job?.id || null });
    bus.emit('proposal.updated', { proposal: updated });
    return updated;
  }

  async function mergeIfReady(p, actor, channel) {
    const { evaluation } = await evaluateProposal(p);
    if (!evaluation.ready) return p;
    return doMerge(p, actor, evaluation, channel);
  }

  // ── actions ────────────────────────────────────────────────────────────────

  async function approve(prpId, actor, { scope = 'all', channel = 'web' } = {}) {
    assertCanApprove(actor);
    return lock(async () => {
      let p = await load(prpId);
      policy.assertMayApprove(p, actor, { ...options, requireSso, scope, channel });
      const rec = approvalRecord(actor, { scope, channel, headSha: p.headSha });
      const approvals = [...(p.approvals || []).filter((a) => !(a.actorId === rec.actorId && a.scope === scope && a.headSha === p.headSha)), rec];
      const changes = scope === 'all' ? p.changes : p.changes.map((c) => (c.slug === scope ? { ...c, pageStatus: 'accepted' } : c));
      p = await store.proposals.update(p.id, { approvals, changes, updatedAt: nowIso() });
      await record('proposal.approve', actor, p.id, channel, { scope, headSha: p.headSha });
      bus.emit('proposal.approved', { proposal: p, actor });
      return mergeIfReady(p, actor, channel);
    });
  }

  async function retryMerge(prpId, actor, { channel = 'web' } = {}) {
    assertCanApprove(actor);
    return lock(async () => {
      const p = await load(prpId);
      if (!policy.APPROVABLE.includes(p.status)) throw new HttpError(409, `This proposal is ${policy.STATUS_WORDS[p.status] || p.status}.`);
      await record('proposal.retry', actor, p.id, channel, { headSha: p.headSha });
      return mergeIfReady(p, actor, channel);
    });
  }

  async function reject(prpId, actor, { reason = '', channel = 'web' } = {}) {
    assertCanApprove(actor);
    return lock(async () => {
      const p = await load(prpId);
      assertLive(p);
      const updated = await store.proposals.update(p.id, {
        status: 'rejected', updatedAt: nowIso(),
        rejection: { by: actor.id, display: actor.display, at: nowIso(), reason: String(reason || '').slice(0, 5000) },
      });
      await record('proposal.reject', actor, p.id, channel, { reason: String(reason || '').slice(0, 500), headSha: p.headSha });
      bus.emit('proposal.rejected', { proposal: updated, actor });
      return updated;
    });
  }

  async function rejectPage(prpId, slug, actor, { channel = 'web', reason = '' } = {}) {
    assertCanApprove(actor);
    return lock(async () => {
      const p = await load(prpId);
      assertLive(p);
      const change = (p.changes || []).find((c) => c.slug === slug);
      if (!change) throw new HttpError(400, `There is no page "${slug}" in this proposal.`);
      if (change.pageStatus === 'rejected') return p;
      const job = await enqueue({
        kind: 'drop-page', source: p.source, trigger: 'feedback', requestedBy: actor.id, proposalId: p.id, slug,
        instructions: `A reviewer took the page "${slug}" out of this proposal${reason ? `: ${reason}` : '.'} Remove every change to brain/wiki/${slug}.md from this branch (restore it as it is on main, or delete it if it is new) and update index.md, manifest.yaml and log.md to match.`,
      });
      if (!job) throw new HttpError(503, "The page couldn't be taken out right now — the agent queue isn't reachable. Nothing was changed.");
      const changes = p.changes.map((c) => (c.slug === slug ? { ...c, pageStatus: 'rejected' } : c));
      const decisions = await store.decisions.listByProposal(p.id);
      const required = policy.computeRequirements({ changes, decisions, source: p.source, label: labelFor(p.source), rules });
      const updated = await store.proposals.update(p.id, { changes, required, updatedAt: nowIso() });
      await record('page.reject', actor, p.id, channel, { slug, headSha: p.headSha, jobId: job.id || null });
      bus.emit('proposal.updated', { proposal: updated });
      return updated;
    });
  }

  async function requestChanges(prpId, actor, { feedback = '', channel = 'web' } = {}) {
    assertCanApprove(actor);
    const text = String(feedback || '').trim().slice(0, 5000);
    if (!text) throw new HttpError(400, 'Say what should change, so the agent knows what to do.');
    return lock(async () => {
      const p = await load(prpId);
      assertLive(p);
      const job = await enqueue({
        kind: 'revise', source: p.source, trigger: 'feedback', requestedBy: actor.id, proposalId: p.id,
        instructions: `A reviewer (${actor.display}) asked for changes to this proposal:\n\n${text}`,
      });
      if (!job) throw new HttpError(503, "Your request couldn't be sent — the agent queue isn't reachable. Nothing was changed.");
      const updated = await store.proposals.update(p.id, {
        status: 'changes_requested', updatedAt: nowIso(),
        feedback: [...(p.feedback || []), { by: actor.id, display: actor.display, at: nowIso(), text, headSha: p.headSha, jobId: job.id || null }],
      });
      await record('proposal.request_changes', actor, p.id, channel, { headSha: p.headSha, jobId: job.id || null });
      bus.emit('proposal.updated', { proposal: updated });
      return updated;
    });
  }

  /** Append to the challenges ledger on the proposal's branch — a service commit, outside brain/wiki/. */
  async function recordChallenge(p, d, actor) {
    const rel = config.v1.challengesPath;
    if (rel.startsWith(`${wikiDir}/`)) throw new Error('audit.challenges_path points inside the wiki — refusing to write there');
    const wt = await git.worktreeAdd(p.branch);
    if (!(await git.isClean(wt))) throw new HttpError(409, 'The agent is still working on this proposal. Try again in a minute.');
    const file = path.join(wt, rel);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    const row = challengeRow(challengeFrom(d, { date: nowIso().slice(0, 10), fallbackSource: p.source?.id || '' }));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, appendChallenge(before, row));
    const sha = await git.commitAll(wt, {
      message: `Record a canonical challenge to ${d.slug || 'a canonical page'} (${p.id})`,
      author: gitIdentity(actor),
      committer: gitIdentity(svc),
    });
    const audit = await runAudit(wt);
    return { sha, worktree: wt, audit };
  }

  async function resolveDecision(decId, actor, { optionId, note = '', channel = 'web' } = {}) {
    assertCanApprove(actor);
    return lock(async () => {
      const d = await store.decisions.get(decId);
      if (!d) throw new NotFoundError('decision', decId);
      if (d.status !== 'open') throw new HttpError(409, 'This question has already been answered.');
      const roles = policy.decisionRoles(d.kind, rules);
      if (roles.length && !hasRole(actor, ...roles)) {
        throw new ForbiddenError(`Answering this needs someone with the ${roles.join(' or ')} role.`);
      }
      const option = (d.options || []).find((o) => o.id === optionId);
      if (!option) throw new HttpError(400, 'Pick one of the offered answers.');
      let p = await load(d.proposalId);
      assertLive(p);
      const cleanNote = String(note || '').trim().slice(0, 2000);
      const detail = { optionId, headSha: p.headSha };

      if (d.kind === 'canonical_conflict') {
        const touches = (p.changes || []).find((c) => c.slug === d.slug && c.canonical && c.pageStatus !== 'rejected');
        if (touches) {
          const job = await enqueue({
            kind: 'drop-page', source: p.source, trigger: 'decision', requestedBy: actor.id, proposalId: p.id, slug: d.slug,
            instructions: `"${d.slug}" is a canonical page. Proposals never change canonical pages. Restore brain/wiki/${d.slug}.md exactly as it is on main.`,
          });
          if (!job) throw new HttpError(503, "This couldn't be done right now — the agent queue isn't reachable. Nothing was changed.");
          detail.jobId = job.id || null;
          p = await store.proposals.update(p.id, { changes: p.changes.map((c) => (c.slug === d.slug ? { ...c, pageStatus: 'rejected' } : c)) });
        }
        if (option.id === 'record') {
          const out = await recordChallenge(p, d, actor);
          detail.challengeCommit = out.sha;
          if (out.sha) {
            p = await upsert({ id: p.jobId, source: p.source, requestedBy: p.submittedBy, runReport: { blocked: [] } },
              { branch: p.branch, baseSha: p.baseSha, headSha: out.sha, audit: out.audit, worktree: out.worktree });
          }
        }
      } else if (!NOOP_EFFECT.test(option.effect || '')) {
        const job = await enqueue({
          kind: 'revise', source: p.source, trigger: 'decision', requestedBy: actor.id, proposalId: p.id, decisionId: d.id,
          instructions: `A reviewer answered the question "${d.question}" with: ${option.label}.\n\nDo this: ${option.effect}${cleanNote ? `\n\nReviewer's note: ${cleanNote}` : ''}`,
        });
        if (!job) throw new HttpError(503, "Your answer couldn't be passed on — the agent queue isn't reachable. Nothing was changed.");
        detail.jobId = job.id || null;
      }

      const resolved = await store.decisions.update(d.id, {
        status: 'resolved',
        resolution: { optionId, label: option.label, note: cleanNote, actorId: actor.id, display: actor.display, at: nowIso(), channel },
      });
      await record('decision.resolve', actor, d.id, channel, { ...detail, proposalId: p.id });
      // Refresh requirements and summary: the open-decision count changed.
      const decisions = await store.decisions.listByProposal(p.id);
      p = await store.proposals.update(p.id, {
        required: policy.computeRequirements({ changes: p.changes, decisions, source: p.source, label: labelFor(p.source), rules }),
        summary: describe(p, decisions).sentence,
        updatedAt: nowIso(),
      });
      bus.emit('decision.resolved', { decision: resolved, proposal: p });
      return resolved;
    });
  }

  async function createConfirmation(prpId, onBehalfOf, action = 'approve') {
    const p = await load(prpId);
    assertLive(p);
    const out = await confirmations.create({ proposalId: p.id, action, onBehalfOf, headSha: p.headSha });
    await record('confirmation.create', onBehalfOf || { id: 'unknown' }, p.id, 'mcp', { action, expiresAt: out.expiresAt });
    return out;
  }

  /**
   * A merge that happened outside the service (a merged GitHub PR). Recorded
   * as what it was — including when it did not meet the policy, which shows
   * up in the activity log as a violation rather than being papered over.
   */
  async function recordExternalMerge(prpId, actor, { sha = '', headSha = '', channel = 'github-pr' } = {}) {
    return lock(async () => {
      const p = await load(prpId);
      if (p.status === 'merged') return p;
      let allowed = true;
      try { assertCanApprove(actor); } catch { allowed = false; }
      const approvals = allowed ? [...(p.approvals || []), approvalRecord(actor, { scope: 'all', channel, headSha: headSha || p.headSha })] : p.approvals || [];
      const draft = { ...p, approvals };
      const { evaluation } = await evaluateProposal(draft);
      const met = allowed && headSha === p.headSha && evaluation.blockers.filter((b) => b.code !== 'status').length === 0 && evaluation.missing.length === 0;
      const updated = await store.proposals.update(p.id, {
        status: 'merged', approvals, updatedAt: nowIso(), mergeError: null,
        merge: { sha, at: nowIso(), by: actor.id, approvers: allowed ? [actor.id] : [], method: channel, external: true, headSha, policyMet: met, ...(met ? {} : { policyGap: evaluation.explanation }) },
      });
      await record('proposal.merge', actor, p.id, channel, { sha, headSha, external: true, policyMet: met });
      if (!met) await record('policy.violation', actor, p.id, channel, { reason: allowed ? evaluation.explanation : `${actor.display} is not a reviewer`, sha });
      bus.emit('proposal.merged', { proposal: updated, actor });
      return updated;
    });
  }

  return {
    // spec surface
    listProposals: (filter = {}) => store.proposals.list(filter),
    getProposal: (id) => store.proposals.get(id),
    createFromJob,
    approve,
    reject,
    rejectPage,
    requestChanges,
    resolveDecision,
    createConfirmation,
    // extras (documented in docs/v2/governance.md)
    retryMerge,
    recordExternalMerge,
    getDecision: (id) => store.decisions.get(id),
    listDecisions: (prpId) => store.decisions.listByProposal(prpId),
    async evaluate(prpId) {
      const p = await load(prpId);
      return { proposal: p, ...(await evaluateProposal(p)) };
    },
    rules,
    options: { ...options, requireSso },
  };
}
