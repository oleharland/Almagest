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
 *
 * Defence in depth: every review action also checks HOW the actor got here
 * (trust.mjs → assertMayAct). Only a signed-in browser session, or the
 * verified Slack / GitHub paths, may act — never a bearer token, whatever
 * HTTP route or in-process caller passed it in. A browser session must also
 * have had its roles confirmed recently (`governance.session_roles_max_age_minutes`,
 * default 60): one whose roles were last checked earlier is sent to sign in
 * again rather than acting on roles the person may no longer have.
 */
import fs from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';

import { canonicalSet, TIERS, tierOfText, withTier } from '../../../tools/lib/canonical.mjs';
import { safeFrontmatter } from '../../../tools/lib/wiki-core.mjs';
import { assertCanApprove, assertCanChangeTier, AuthError, ForbiddenError, hasRole, parseTokens, serviceActor } from '../core/auth.mjs';
import { gitIdentity } from '../core/git.mjs';
import { HttpError } from '../core/http.mjs';
import { newId, nowIso, reservedBranch, ROLES } from '../core/schemas.mjs';
import { NotFoundError } from '../core/store/index.mjs';
import { attachDemand, buildChanges } from './builder.mjs';
import { canonicalAt } from './canonical.mjs';
import { basisOf, createRejectedMemory, LEARNINGS_SOURCE_PREFIX, learningMeta, readPage } from './learnings.mjs';
import { appendChallenge, challengeFrom, challengeRow } from './challenges.mjs';
import { normalizeAudit, oneLine, runAudit } from './merge.mjs';
import { listChanges, outsideFiles } from './paths.mjs';
import * as policy from './policy.mjs';
import { assertMayAct, vouchedAs } from './trust.mjs';
import { describe, learningsTitle, lookupQuestionOf, tierTitle, titleFor } from './summary.mjs';

/** Front matter is YAML and nothing else (tools/lib/wiki-core.mjs → safeFrontmatter). */
const parseFrontmatter = safeFrontmatter(matter);

/** canonical_conflict has exactly one non-dismiss effect (spec → Decision). Enforced by construction. */
export const CANONICAL_OPTIONS = [
  { id: 'record', label: 'Record it as a challenge to the locked page (the page itself stays as it is)', effect: 'append a row to brain/canonical-challenges.md' },
  { id: 'dismiss', label: 'Dismiss it — the new material is wrong', effect: 'none' },
];

const NOOP_EFFECT = /^\s*(none|no-?op|nothing)?\s*$/i;

/** Automatic "redo it on top of main" revisions per proposal before a person must step in. */
export const MAX_CONFLICT_REVISES = 2;

export const DEFAULT_SESSION_ROLES_MAX_AGE_MINUTES = 60;

/**
 * The pages a run wrote as additions to pages pending in other proposals, as
 * the runner validated and enriched them (ingest/runner.mjs). null when the
 * report says nothing about it, so a job without a report (drop-page, an
 * answered decision) leaves a proposal's list as it was.
 */
function extendsFrom(report) {
  if (!Array.isArray(report?.extends)) return null;
  const seen = new Set();
  const out = [];
  for (const e of report.extends) {
    if (!e || typeof e.slug !== 'string' || typeof e.proposalId !== 'string' || !e.slug || !e.proposalId) continue;
    const key = `${e.slug}\0${e.proposalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ slug: e.slug, proposalId: e.proposalId, title: typeof e.title === 'string' ? e.title.slice(0, 300) : '' });
  }
  return out;
}

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

/** A page slug as it can appear in a route: one plain file name, never a path. */
const PAGE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function createService(ctx, { merger, confirmations, lock, identities, allowed, hints = null }) {
  const { store, bus, git, config, log } = ctx;
  const gov = config.governance;
  const rules = policy.validateRules(gov.rules || []);
  const canonicalRole = String(gov.canonical_role || 'owner');
  if (!ROLES.includes(canonicalRole)) throw new Error(`governance.canonical_role must be one of ${ROLES.join(' | ')} (got "${canonicalRole}")`);
  const options = { separationOfDuties: Boolean(gov.separation_of_duties) };
  const requireSso = Boolean(gov.require_sso_for_approval);
  const rolesMaxAgeMs = Number(gov.session_roles_max_age_minutes ?? DEFAULT_SESSION_ROLES_MAX_AGE_MINUTES) * 60 * 1000;
  const mode = config.service.auth.provider;
  const tokens = () => parseTokens(process.env[config.service.auth.tokens_env || 'ALMAGEST_TOKENS'] || '');
  const wikiDir = `${config.v1.brainDir}/wiki`;
  const svc = serviceActor('governance');
  const turnedDown = createRejectedMemory({ store, git, config });

  const labelFor = (source) => (config.sources.connectors || []).find((c) => c.id === source?.connector)?.label || '';

  /** What a proposal needs: the rules, plus the canonical role for a tier proposal that moves a page to or from canonical. */
  const requirementsFor = (p, { changes = p.changes, decisions = [] } = {}) => policy.computeRequirements({
    changes, decisions, source: p.source, label: labelFor(p.source), rules,
    tierChange: p.kind === 'tier' ? p.tier : null, canonicalRole,
  });

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

  /** Identity-aware policy options: who the approvers and submitters are, as people. */
  async function policyOptions(p, actor = null) {
    const approvals = p.approvals || [];
    const hints = new Map(approvals.filter((a) => a.email).map((a) => [a.actorId, a.email]));
    if (actor?.email) hints.set(actor.id, actor.email);
    const subs = policy.submittersOf(p);
    const keyring = await identities.keyring([...approvals.map((a) => a.actorId), ...subs, actor?.id], hints);
    const submitterKeys = new Set(subs.flatMap((id) => [...(keyring.get(id)?.keys || [`id:${id}`])]));
    const actorKeys = actor ? keyring.get(actor.id)?.keys : null;
    const currentRoles = await identities.currentRoles(approvals.map((a) => a.actorId), { mode, tokens: mode === 'oidc' ? [] : tokens() });
    return { ...options, keyring, submitterKeys, actorKeys, allowed, currentRoles };
  }

  /**
   * A browser session acts on roles confirmed within the last
   * session_roles_max_age_minutes. Sessions re-checked on every request
   * (token sign-in) always pass; a single sign-on session past the limit gets
   * `code: 'reauth'`, which the inbox turns into "sign in again".
   */
  function assertRolesFresh(actor) {
    if (vouchedAs(actor) !== 'session') return;
    const at = Date.parse(actor.session?.rolesAt || '');
    if (Date.now() - at <= rolesMaxAgeMs) return;
    const mins = Math.round(rolesMaxAgeMs / 60000);
    const err = new AuthError(`Please sign in again. Approving or turning something down needs your roles checked within the last ${mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`}, and this sign-in is older than that.`);
    err.code = 'reauth';
    throw err;
  }

  /** The first lines of every review action: who, how they got here, and how recently their roles were checked. */
  function assertReviewer(actor, channel) {
    assertCanApprove(actor);
    assertMayAct(actor, channel);
    assertRolesFresh(actor);
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

  // ── learnings ──────────────────────────────────────────────────────────────

  /** The slugs of the pages on main, for resolving a Basis. */
  async function pagesOnMain() {
    const out = await git.tryRun(['ls-tree', '--name-only', config.service.git.main, '--', `${wikiDir}/`]);
    return new Set(String(out || '').split('\n').filter((f) => f.endsWith('.md')).map((f) => path.posix.basename(f, '.md')));
  }

  /** What each learning in a proposal rests on: its Basis pages, as slugs and titles, for the inbox to link. */
  async function attachBasis(changes, headSha) {
    const known = await pagesOnMain();
    const titles = new Map();
    const titleOf = async (slug) => {
      if (!titles.has(slug)) {
        const text = await git.show(config.service.git.main, `${wikiDir}/${slug}.md`);
        let title = slug;
        try { title = (typeof text === 'string' && readPage(text).title) || slug; } catch { /* a page the parser cannot read is still linked by name */ }
        titles.set(slug, title);
      }
      return titles.get(slug);
    };
    for (const c of changes) {
      if (c.action === 'delete') continue;
      const text = await git.show(headSha, c.path);
      let page = null;
      try { page = typeof text === 'string' ? readPage(text) : null; } catch { page = null; }
      c.basis = [];
      if (!page) continue;
      // The whole text, for the inbox: a person approves a learning from what it shows, so it shows all of it.
      c.body = page.body.trim();
      c.front = page.front.trim();
      c.meta = learningMeta(page);
      for (const slug of basisOf(page.body, known).slugs) c.basis.push({ slug, title: await titleOf(slug) });
    }
  }

  /**
   * A person turned a learning down: keep its Basis set, its title and the
   * content hash of each Basis page, so the same conclusion is not proposed
   * again until one of those pages changes. Never blocks the rejection.
   */
  async function rememberTurnedDown(p, slugs) {
    if (p.kind !== 'learnings') return;
    try {
      const known = await pagesOnMain();
      for (const slug of slugs) {
        const change = (p.changes || []).find((c) => c.slug === slug && c.action !== 'delete');
        if (!change) continue;
        const text = await git.show(p.headSha, change.path);
        if (typeof text !== 'string') continue;
        const page = readPage(text);
        const { slugs: basis } = basisOf(page.body, known);
        const entry = await turnedDown.remember({ basis, title: page.title || change.title });
        if (entry) await record('learning.turned_down', svc, p.id, 'cli', { slug, basis: entry.basis });
      }
    } catch (err) {
      log.warn('could not remember a learning that was turned down', { proposal: p.id, error: err.message });
    }
  }

  // ── proposals ──────────────────────────────────────────────────────────────

  /** createFromJob without the lock — also used to refresh after a service commit. */
  async function upsert(job, info = {}) {
    const branch = info.branch || job.branch;
    if (!branch) throw new Error('createFromJob needs the job\'s branch');
    const existing = await store.proposals.getByBranch(branch);
    const live = existing && policy.LIVE.includes(existing.status) ? existing : null;
    if (!live && existing && job.proposalId && job.proposalId === existing.id) {
      // A revise / drop-page job that finished after its proposal was merged or
      // turned down. It must not bring the proposal back.
      log.warn('ignoring a late job for a closed proposal', { proposal: existing.id, status: existing.status, job: job.id });
      return existing;
    }
    const headSha = info.headSha || (await git.revParse(branch));
    const baseSha = info.baseSha || (await git.mergeBase(config.service.git.main, headSha));

    const locked = await canonicalAt(git, config);
    const { changes, otherFiles } = await buildChanges({ git, baseSha, headSha, wikiDir, canonicalPages: config.v1.canonicalPages, locked });
    const files = await listChanges(git, baseSha, headSha);
    const outside = outsideFiles(files, allowed);
    await attachDemand(changes, ctx.demand, log);
    // A tier proposal changes the tier line of one page, which is "canonical" on
    // one side of it. The merge proves the diff is only that line; here the
    // page just must not read as a forbidden change to a locked page.
    const kind = live?.kind || (job.tierChange ? 'tier' : job.kind === 'synthesize' ? 'learnings' : '');
    const tier = live?.tier || job.tierChange || null;
    if (kind === 'tier') {
      for (const c of changes) if (c.slug === tier?.slug) { c.canonical = false; delete c.promotes; c.tierChange = { from: tier.from, to: tier.to }; }
    }
    // A page the branch makes canonical is fine only when a person chose it in
    // the inbox and the page is still exactly what they chose it on.
    const edits = live?.tierEdits || {};
    for (const c of changes.filter((x) => x.promotes)) {
      const edit = edits[c.slug];
      const blob = (await git.tryRun(['rev-parse', `${headSha}:${c.path}`]))?.trim();
      if (edit?.to === 'canonical' && edit.blob && edit.blob === blob) {
        c.canonical = false;
        c.tierSetBy = { by: edit.by, display: edit.display, at: edit.at };
        delete c.promotes;
      }
    }
    if (live) {
      for (const c of changes) {
        const prev = (live.changes || []).find((x) => x.slug === c.slug);
        if (prev?.pageStatus === 'rejected') c.pageStatus = 'rejected';
        else if (prev?.pageStatus === 'accepted' && live.headSha === headSha) c.pageStatus = 'accepted';
      }
    }

    const runReport = info.runReport || job.runReport || {};
    // A learnings proposal has no source file: it stands for the commit of main it read.
    const source = job.source || live?.source
      || (kind === 'learnings' ? { kind: 'synthesis', id: `${LEARNINGS_SOURCE_PREFIX}${String(baseSha).slice(0, 7)}`, title: 'the pages the brain already holds', sha256: baseSha } : null);
    if (kind === 'learnings') await attachBasis(changes, headSha);
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
        question: c.promotes
          ? `This proposal makes the page “${c.title}” canonical, and no person chose that in the inbox. Only a person makes a page canonical. Should the new material be recorded as a challenge instead?`
          : `This proposal changes the locked reference page “${c.title}”. Locked pages are never changed by a proposal. Should the new material be recorded as a challenge to it?`,
        claimA: c.claims.find((x) => x.before)?.before || '',
        claimB: claim?.text || `Proposed edits to ${c.slug}`,
        sourceB: claim?.citation ? `${claim.citation.id}, ${claim.citation.locator}` : source?.id || '',
      }));
    }
    for (const d of created) await store.decisions.create(d);
    const decisions = known();

    const now = nowIso();
    // How this proposal came to exist. Kept from the first job: a later
    // revise job (trigger `feedback`) must not erase that live lookup fetched it.
    const trigger = live?.trigger || job.trigger || '';
    const lookupQuestion = live?.lookupQuestion || lookupQuestionOf(job);
    const fields = {
      ...(trigger ? { trigger } : {}),
      ...(lookupQuestion ? { lookupQuestion } : {}),
      jobId: job.id || live?.jobId || '', branch, baseSha, headSha,
      worktree: info.worktree || job.worktree || live?.worktree || '',
      ...(kind === 'tier' ? { kind: 'tier', tier } : kind === 'learnings' ? { kind: 'learnings' } : {}),
      title: kind === 'tier' ? (live?.title || tierTitle(job.tierWho || 'Someone', tier.title || tier.slug, tier.to))
        : kind === 'learnings' ? learningsTitle(changes.filter((c) => c.action === 'create' && c.pageStatus !== 'rejected').length)
          : titleFor(source), source,
      audit: normalizeAudit(info.audit ?? job.audit),
      changes, otherFiles, files, outside,
      decisions: decisions.map((d) => d.id),
      notes: runReport.notes || '',
      reportPages: runReport.pages || [],
      // What a proposal extends is information for the reviewer, and it belongs to
      // the version they approved: a run that leaves the head where it was cannot
      // change it. A run that makes a new head replaces it.
      extends: live && live.headSha === headSha ? (live.extends ?? []) : (extendsFrom(runReport) ?? live?.extends ?? []),
      updatedAt: now,
    };
    fields.required = requirementsFor({ kind, tier, source }, { changes, decisions });
    fields.summary = describe(fields, decisions).sentence;

    let proposal;
    if (live) {
      proposal = await store.proposals.update(live.id, {
        ...fields, status: 'open', mergeError: null,
        revision: (live.revision || 1) + (live.headSha === headSha ? 0 : 1),
        revisedBecause: live.headSha === headSha ? live.revisedBecause || '' : ['conflict', 'audit'].includes(job.reason) || live.status === 'conflicted' ? 'conflict' : job.kind || 'revise',
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
    if (outside.length) {
      log.warn('proposal changes files outside the knowledge base — it can never be approved', { proposal: proposal.id, files: outside.map((o) => o.path) });
      await record('proposal.blocked_paths', svc, proposal.id, 'cli', { headSha, files: outside });
    }
    for (const decision of created) bus.emit('decision.created', { decision, proposal });
    return proposal;
  }

  /** A newer proposal for the same source replaces older live ones of the same kind from other branches. */
  async function supersedeOlder(p) {
    if (!p.source?.id) return;
    const live = await store.proposals.list({ status: policy.LIVE });
    for (const old of live) {
      if (old.id === p.id || old.branch === p.branch || old.source?.id !== p.source.id) continue;
      if ((old.kind || '') !== (p.kind || '')) continue;   // a chat source and a learnings proposal never replace each other
      const updated = await store.proposals.update(old.id, { status: 'superseded', supersededBy: p.id, updatedAt: nowIso() });
      await record('proposal.supersede', svc, old.id, 'cli', { by: p.id });
      await cleanupClosed(old);
      bus.emit('proposal.updated', { proposal: updated });
    }
  }

  /**
   * A turned-down or superseded proposal leaves nothing behind: its worktree is
   * removed and, unless `governance.keep_closed_branches`, its branch too.
   * The proposal record (with every approval and the audit log) stays.
   */
  async function cleanupClosed(p) {
    try {
      const wt = await git.worktreeFor(p.branch);
      if (wt) await git.tryRun(['worktree', 'remove', '--force', wt.path]);
      if (!gov.keep_closed_branches) await git.tryRun(['branch', '-D', p.branch]);
    } catch (err) {
      log.warn('could not clean up a closed proposal', { proposal: p.id, error: err.message });
    }
  }

  function createFromJob(job, info = {}) {
    return lock(() => upsert(job, info));
  }

  // ── evaluation & merge ─────────────────────────────────────────────────────

  async function evaluateProposal(p) {
    const decisions = await store.decisions.listByProposal(p.id);
    return { decisions, evaluation: policy.evaluate({ proposal: p, decisions, options: await policyOptions(p) }) };
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
          ...(result.combined?.length ? { combined: result.combined } : {}),
          audit: { exit: result.audit.exit, errors: result.audit.errors, warnings: result.audit.warnings },
        },
      });
      await record('proposal.merge', actor, p.id, channel, { sha: result.sha, headSha: p.headSha, approvers: approvers.map((a) => a.actorId), method: result.method, ...(result.combined?.length ? { combined: result.combined } : {}) });
      bus.emit('proposal.merged', { proposal: merged, actor });
      return merged;
    }

    let status = 'approved';
    let job = null;
    if (result.reason === 'tier' && result.benign) {
      // The page moved under a tier choice: this proposal can no longer merge,
      // and nothing was broken. Marked like any proposal that no longer fits.
      status = 'conflicted';
    } else if (result.reason === 'paths' || result.reason === 'canonical' || result.reason === 'tier') {
      status = p.status;
      if (!result.benign) await record('policy.violation', actor, p.id, channel, { reason: result.message, code: result.reason, files: result.files, headSha: p.headSha });
    } else if (result.reason === 'conflict' || result.reason === 'audit') {
      status = 'conflicted';
    } else if (result.reason === 'stale') {
      status = p.status;
    }

    // Conflict-driven revisions: at most one waiting per reviewed version (so
    // re-approving does not pile up jobs), and at most MAX_CONFLICT_REVISES per
    // proposal — after that a person has to look.
    let message = result.message;
    let conflictRevise = p.conflictRevise || { count: 0, headSha: '' };
    if (status === 'conflicted' && p.kind === 'tier' && result.benign) {
      message = result.message;
    } else if (status === 'conflicted' && p.kind === 'tier') {
      // A tier change has no agent to redo it: the page moved under it.
      message = 'The page changed after this was proposed, so the change no longer fits. Turn this down and make the change again.';
    } else if (status === 'conflicted') {
      const pending = conflictRevise.headSha === p.headSha;
      if (pending) {
        message = `${result.message} The agent is already redoing it.`;
      } else if (conflictRevise.count >= MAX_CONFLICT_REVISES) {
        message = `This keeps clashing with other changes (${conflictRevise.count} automatic redos so far), so it needs a person: ask for specific changes, or turn it down and add the source again.`;
      } else {
        const why = result.reason === 'conflict'
          ? `These files clash with changes merged into main since this branch was made: ${result.files.join(', ')}.`
          : `Merged with the current main, the audit fails:\n${(result.audit?.findings || []).filter((f) => f.severity === 'error').slice(0, 20).map((f) => `- ${f.id} ${f.slug || ''}: ${f.message}`).join('\n')}`;
        job = await enqueue({
          kind: 'revise', source: p.source, trigger: 'feedback', requestedBy: svc.id, proposalId: p.id, reason: result.reason,
          instructions: `${why}\n\nBring this branch up to date with main and redo the affected changes so it merges cleanly and passes the audit. Keep the reviewed content unless it conflicts.`,
        });
        if (job) {
          conflictRevise = { count: conflictRevise.count + 1, headSha: p.headSha, at: nowIso(), jobId: job.id || null };
          message = `The knowledge base changed while this waited, so it is being redone on top of the current version. ${result.message}`;
        } else {
          message = `${result.message} (The request to the agent could not be queued — ask an administrator.)`;
        }
      }
    }
    const updated = await store.proposals.update(p.id, { status, conflictRevise, mergeError: { reason: result.reason, message, at: nowIso(), ...(result.files ? { files: result.files } : {}), ...(result.slug ? { slug: result.slug } : {}) }, updatedAt: nowIso() });
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

  async function approve(prpId, actor, { scope = 'all', channel = 'web', headSha } = {}) {
    assertReviewer(actor, channel);
    return lock(async () => {
      let p = await load(prpId);
      policy.assertMayApprove(p, actor, { ...(await policyOptions(p, actor)), requireSso, scope, channel, headSha, requireHead: true });
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
    assertReviewer(actor, channel);
    return lock(async () => {
      const p = await load(prpId);
      if (!policy.APPROVABLE.includes(p.status)) throw new HttpError(409, `This proposal is ${policy.STATUS_WORDS[p.status] || p.status}.`);
      await record('proposal.retry', actor, p.id, channel, { headSha: p.headSha });
      return mergeIfReady(p, actor, channel);
    });
  }

  async function reject(prpId, actor, { reason = '', channel = 'web' } = {}) {
    assertReviewer(actor, channel);
    return lock(async () => {
      const p = await load(prpId);
      assertLive(p);
      const updated = await store.proposals.update(p.id, {
        status: 'rejected', updatedAt: nowIso(),
        rejection: { by: actor.id, display: actor.display, at: nowIso(), reason: String(reason || '').slice(0, 5000) },
      });
      await record('proposal.reject', actor, p.id, channel, { reason: String(reason || '').slice(0, 500), headSha: p.headSha });
      // Read the learnings before cleanup removes the branch they are on.
      await rememberTurnedDown(p, (p.changes || []).filter((c) => c.action === 'create' && c.pageStatus !== 'rejected').map((c) => c.slug));
      await cleanupClosed(p);
      bus.emit('proposal.rejected', { proposal: updated, actor });
      return updated;
    });
  }

  const assertNotTier = (p) => {
    if (p.kind === 'tier') throw new HttpError(409, 'This is a tier change. There is nothing for the agent to redo. Turn it down if you do not want it.');
  };

  async function rejectPage(prpId, slug, actor, { channel = 'web', reason = '' } = {}) {
    assertReviewer(actor, channel);
    return lock(async () => {
      const p = await load(prpId);
      assertLive(p);
      assertNotTier(p);
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
      const required = requirementsFor(p, { changes, decisions });
      const updated = await store.proposals.update(p.id, { changes, required, updatedAt: nowIso() });
      await record('page.reject', actor, p.id, channel, { slug, headSha: p.headSha, jobId: job.id || null });
      await rememberTurnedDown(p, [slug]);
      bus.emit('proposal.updated', { proposal: updated });
      return updated;
    });
  }

  async function requestChanges(prpId, actor, { feedback = '', channel = 'web' } = {}) {
    assertReviewer(actor, channel);
    const text = String(feedback || '').trim().slice(0, 5000);
    if (!text) throw new HttpError(400, 'Say what should change, so the agent knows what to do.');
    return lock(async () => {
      const p = await load(prpId);
      assertLive(p);
      assertNotTier(p);
      const job = await enqueue({
        kind: 'revise', source: p.source, trigger: 'feedback', requestedBy: actor.id, proposalId: p.id,
        instructions: `A reviewer (${actor.display}) asked for changes to this proposal:\n\n${text}`,
      });
      if (!job) throw new HttpError(503, "Your request couldn't be sent — the agent queue isn't reachable. Nothing was changed.");
      const updated = await store.proposals.update(p.id, {
        status: 'changes_requested', updatedAt: nowIso(),
        feedback: [...(p.feedback || []), { by: actor.id, display: actor.display, at: nowIso(), text, headSha: p.headSha, jobId: job.id || null }],
        conflictRevise: { count: 0, headSha: '' },
      });
      await record('proposal.request_changes', actor, p.id, channel, { headSha: p.headSha, jobId: job.id || null });
      bus.emit('proposal.updated', { proposal: updated });
      return updated;
    });
  }

  // ── tiers ──────────────────────────────────────────────────────────────────

  /**
   * The first lines of every tier action: who, how they got here, and which
   * role the change needs. Only a person in a signed-in browser session, in
   * the web inbox, passes: not an agent, not an API or MCP token, and none of
   * the chat, Slack, email or GitHub channels.
   */
  function assertMayChangeTier(actor, channel, { canonical = false } = {}) {
    if (channel !== 'web') throw new ForbiddenError('A tier is changed only in the signed-in review inbox, not from chat, Slack, email or GitHub.');
    assertCanChangeTier(actor, { canonical, role: canonicalRole });
    assertMayAct(actor, 'web');
    assertRolesFresh(actor);
  }

  function assertTier(to) {
    if (!TIERS.includes(to)) throw new HttpError(400, `The tier must be one of ${TIERS.join(', ')}.`);
  }

  function assertConfirmed(to, confirm) {
    if (to === 'canonical' && confirm !== true) throw new HttpError(400, 'Read what canonical means for the page, then confirm.');
  }

  const auditNote = (audit) => (audit.findings || []).filter((f) => f.severity === 'error').slice(0, 3).map((f) => `${f.id}${f.slug ? ` ${f.slug}` : ''}: ${f.message}`).join('; ') || audit.error || 'the audit did not pass';

  /**
   * Change the tier of one page in an open proposal. A human edit to the
   * proposal: a new commit on its branch that changes only the `tier:` line of
   * that page, authored by the person and committed by the service, written
   * with git plumbing so no checkout is touched. The service's own audit runs
   * on the new head first; if it fails the branch is not moved and the person
   * is told why. The reviewed version then moves to the new head the way it
   * does for a revision, so earlier approvals no longer count.
   */
  async function setPageTier(prpId, slug, to, actor, { channel = 'web', headSha, confirm = false } = {}) {
    assertMayChangeTier(actor, channel, { canonical: to === 'canonical' });
    assertTier(to);
    assertConfirmed(to, confirm);
    return lock(async () => {
      const p = await load(prpId);
      assertNotTier(p);
      policy.assertMayApprove(p, actor, { ...(await policyOptions(p, actor)), requireSso, scope: 'all', channel, headSha, requireHead: true });
      const change = (p.changes || []).find((c) => c.slug === slug && c.pageStatus !== 'rejected');
      if (!change || change.action === 'delete') throw new HttpError(400, `There is no page "${slug}" in this proposal to change the tier of.`);
      if ((p.changes || []).some((c) => c.pageStatus === 'rejected')) throw new HttpError(409, 'A page is being taken out of this proposal. Wait until that is done.');
      if ((await canonicalAt(git, config)).has(slug)) {
        throw new HttpError(409, 'This page is already canonical on the knowledge base. Change its tier from the page itself, not from a proposal.');
      }
      const file = change.path;
      const text = await git.show(p.headSha, file);
      if (text === null) throw new HttpError(409, 'The page is missing from this version of the proposal.');
      const from = tierOfText(text);
      assertMayChangeTier(actor, channel, { canonical: from === 'canonical' || to === 'canonical' });
      if (from === to) throw new HttpError(409, `This page is already ${to}.`);
      const next = withTier(text, to);
      if (next === null) throw new HttpError(409, 'The tier line of this page cannot be edited here.');

      if ((await store.jobs.list({ proposalId: p.id, status: ['queued', 'running'] })).length) {
        throw new HttpError(409, 'The agent is still working on this proposal. Try again in a minute.');
      }
      const wtPath = (await git.worktreeFor(p.branch))?.path || '';
      let handle = null;
      if (wtPath) {
        try { handle = await git.openWorktree(wtPath); } catch (err) { log.warn('proposal worktree is not usable', { proposal: p.id, error: err.message }); }
        if (!handle || (await handle.run(['status', '--porcelain'])).trim() !== '') {
          throw new HttpError(409, 'The agent is still working on this proposal. Try again in a minute.');
        }
      }

      const tree = await merger.treeWith((await git.run(['rev-parse', `${p.headSha}^{tree}`])).trim(), [[file, next]]);
      const sha = await merger.commitTree(tree, [p.headSha], `Set ${oneLine(slug, 100)} to ${oneLine(to, 20)} (${oneLine(p.id, 60)})`, gitIdentity(actor));
      const audit = await merger.auditCommit(sha);
      if (audit.exit !== 0) {
        await record('page.tier_refused', actor, p.id, channel, { slug, to, reason: auditNote(audit) });
        throw new HttpError(409, `That change was not kept, because the automatic checks failed on the result (${auditNote(audit)}).`);
      }
      await git.run(['update-ref', '-m', `almagest: tier of ${slug} to ${to}`, `refs/heads/${p.branch}`, sha, p.headSha]);
      if (handle) await handle.run(['reset', '--hard', '--quiet', sha]).catch((err) => log.warn('could not refresh the proposal worktree', { proposal: p.id, error: err.message }));

      const blob = (await git.run(['rev-parse', `${sha}:${file}`])).trim();
      const edit = { from, to, by: actor.id, display: actor.display, at: nowIso(), headSha: sha, blob };
      // The person wrote part of this version, so they count as one who sent it in: separation of
      // duties then keeps them from approving it alone, as it does for whoever proposed a tier.
      const submitters = [...new Set([...policy.submittersOf(p), actor.id])];
      await store.proposals.update(p.id, { tierEdits: { ...(p.tierEdits || {}), [slug]: edit }, submitters });
      const updated = await upsert({ id: p.jobId, kind: 'tier-edit', source: p.source, requestedBy: actor.id, runReport: { blocked: [], notes: p.notes, pages: p.reportPages } },
        { branch: p.branch, baseSha: p.baseSha, headSha: sha, audit, worktree: p.worktree });
      await record('page.tier', actor, p.id, channel, { slug, from, to, headSha: sha, previousHeadSha: p.headSha });
      return updated;
    });
  }

  /**
   * Change the tier of a page that is already on main. The service makes a
   * small proposal authored by the person: a branch holding one commit on top
   * of main that changes only the page's `tier:` line, then runs it through
   * the normal gate. If the person's own approval satisfies the policy it is
   * recorded through the ordinary approve path, so in a solo brain this is one
   * action; otherwise the proposal waits in the inbox for the others.
   */
  async function proposeTier(slug, to, actor, { channel = 'web', confirm = false } = {}) {
    assertMayChangeTier(actor, channel, { canonical: to === 'canonical' });
    assertTier(to);
    assertConfirmed(to, confirm);
    if (!PAGE_SLUG.test(String(slug))) throw new HttpError(400, 'That is not a page name.');
    const created = await lock(async () => {
      const main = config.service.git.main;
      const mainSha = await git.revParse(main);
      const file = `${wikiDir}/${slug}.md`;
      const text = await git.show(mainSha, file);
      if (text === null) throw new HttpError(404, `There is no page "${slug}" on the knowledge base.`);
      const from = tierOfText(text);
      if (!TIERS.includes(from)) throw new HttpError(409, 'This page has no tier line to change.');
      assertMayChangeTier(actor, channel, { canonical: from === 'canonical' || to === 'canonical' });
      if (from === to) throw new HttpError(409, `This page is already ${to}.`);
      const inConfig = canonicalSet({ configPages: config.v1.canonicalPages }).has(slug);
      if (inConfig) {
        throw new HttpError(409, to === 'canonical' ? 'This page is already canonical.' : 'This page is locked in brain.config.yaml. Only a person editing that file by hand can unlock it.');
      }
      for (const other of await store.proposals.list({ status: policy.LIVE })) {
        if (other.kind === 'tier' && other.tier?.slug === slug && other.status !== 'conflicted') throw new HttpError(409, 'A tier change for this page is already waiting in the inbox.');
      }
      const next = withTier(text, to);
      if (next === null) throw new HttpError(409, 'The tier line of this page cannot be edited here.');
      const pageTitle = String(parseFrontmatter(text).data?.title || slug);

      const tree = await merger.treeWith((await git.run(['rev-parse', `${mainSha}^{tree}`])).trim(), [[file, next]]);
      const sha = await merger.commitTree(tree, [mainSha], `Set ${oneLine(slug, 100)} to ${oneLine(to, 20)}`, gitIdentity(actor));
      const audit = await merger.auditCommit(sha);
      if (audit.exit !== 0) throw new HttpError(409, `That change was not made, because the automatic checks failed on the result (${auditNote(audit)}).`);

      let branch = reservedBranch('tier', slug, mainSha);
      if (await git.branchExists(branch)) branch = reservedBranch('tier', slug, '');
      await git.run(['update-ref', '-m', `almagest: tier proposal for ${slug}`, `refs/heads/${branch}`, sha]);
      try {
        const job = {
          id: newId('job'), kind: 'tier', trigger: 'tier', branch, requestedBy: actor.id, runReport: { blocked: [] },
          source: { kind: 'tier', id: `tier-${slug}`, title: pageTitle, sha256: mainSha },
          tierChange: { slug, from, to, title: pageTitle }, tierWho: actor.display || actor.id,
        };
        const proposal = await upsert(job, { branch, baseSha: mainSha, headSha: sha, audit });
        await record('page.tier_propose', actor, proposal.id, channel, { slug, from, to, headSha: sha });
        return proposal;
      } catch (err) {
        await git.tryRun(['update-ref', '-d', `refs/heads/${branch}`]);
        throw err;
      }
    });

    // The person's own approval, when it is enough. Outside the lock: approve takes it itself.
    try {
      const fresh = await store.proposals.get(created.id);
      const opts = { ...(await policyOptions(fresh, actor)), requireSso, scope: 'all', channel, headSha: fresh.headSha, requireHead: true };
      policy.assertMayApprove(fresh, actor, opts);
      const mine = approvalRecord(actor, { scope: 'all', channel, headSha: fresh.headSha });
      const { evaluation } = await evaluateProposal({ ...fresh, approvals: [...(fresh.approvals || []), mine] });
      if (evaluation.ready) return await approve(fresh.id, actor, { scope: 'all', channel, headSha: fresh.headSha });
    } catch (err) {
      log.debug('the proposer\'s own approval was not recorded', { proposal: created.id, reason: err.message });
    }
    return store.proposals.get(created.id);
  }

  /** Turn a canonical suggestion down. It returns only when the page's documents have grown by half. */
  async function dismissHint(slug, actor, { channel = 'web' } = {}) {
    // A dismissal hides the suggestion from everyone, so it takes the role that makes a page canonical.
    assertMayChangeTier(actor, channel, { canonical: true });
    if (!hints) throw new HttpError(404, 'Suggestions are not available.');
    const record_ = await hints.dismiss(String(slug), actor);
    if (!record_) throw new HttpError(404, 'That page is not on the list of suggestions.');
    await record('hint.dismiss', actor, `page:${slug}`, channel, { slug, documents: record_.documents });
    return record_;
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
      message: `Record a canonical challenge to ${oneLine(d.slug, 100) || 'a canonical page'} (${oneLine(p.id, 60)})`,
      author: gitIdentity(actor),
      committer: gitIdentity(svc),
    });
    const audit = await runAudit(wt);
    return { sha, worktree: wt, audit };
  }

  async function resolveDecision(decId, actor, { optionId, note = '', channel = 'web', headSha } = {}) {
    assertReviewer(actor, channel);
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
      policy.assertSameHead(p, headSha);   // the answer is about the version the person was shown
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
        required: requirementsFor(p, { changes: p.changes, decisions }),
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
   * A merge that happened outside the service (a merged GitHub PR). The
   * policy decides first, through the same checks as the inbox: a mapped,
   * vouched human approver, the reviewed head, separation of duties, every
   * requirement met. Only then may local main move — and only to the merge
   * commit itself, once merger.acceptExternal() has checked its parents and
   * re-run the path check and the audit. `fetch(sha)` brings that commit in
   * from the remote first; if it throws, nothing is recorded and a
   * redelivery can try again.
   *
   * Any refusal leaves main where it was and marks the proposal
   * `merged_unaccepted` with the reason (`merge.reason`: policy · head ·
   * paths · content · audit · shape · checkout · busy · error), logged as a policy
   * violation — never as a normal merge. A person reconciles it by hand.
   */
  async function recordExternalMerge(prpId, actor, { sha = '', headSha = '', channel = 'github-pr', fetch = null } = {}) {
    return lock(async () => {
      const p = await load(prpId);
      if (p.status === 'merged' || p.status === 'merged_unaccepted') return p;
      let refusal = null;
      try { assertCanApprove(actor); assertMayAct(actor, channel); } catch { refusal = { reason: 'policy', message: `${actor.display} is not a reviewer` }; }
      // The PR's head must be the reviewed version, or the merge is not an approval of it.
      if (!refusal && !(headSha && headSha === p.headSha)) {
        refusal = { reason: 'head', message: `GitHub merged version ${String(headSha).slice(0, 7) || 'unknown'}, but the reviewed version is ${String(p.headSha).slice(0, 7)}` };
      }
      if (!refusal) {
        try {
          policy.assertMayApprove(p, actor, { ...(await policyOptions(p, actor)), requireSso, scope: 'all', channel, headSha, requireHead: true });
        } catch (err) {
          refusal = { reason: 'policy', message: err.message };
        }
      }
      const counts = !refusal;
      const approvals = counts ? [...(p.approvals || []), approvalRecord(actor, { scope: 'all', channel, headSha })] : p.approvals || [];
      const { evaluation } = await evaluateProposal({ ...p, approvals });
      const met = counts && evaluation.ready;
      if (!refusal && !met) refusal = { reason: 'policy', message: evaluation.explanation };

      let result = null;
      if (!refusal) {
        if (fetch) await fetch(sha);
        try {
          result = await merger.acceptExternal(p, sha);
        } catch (err) {
          log.error('checking an external merge failed', { proposal: p.id, error: err.stack || err.message });
          result = { ok: false, reason: 'error', message: `Something went wrong while checking it: ${err.message}` };
        }
        if (!result.ok) {
          refusal = {
            reason: result.reason, message: result.message, ...(result.files ? { files: result.files } : {}),
            ...(result.audit ? { audit: { exit: result.audit.exit, errors: result.audit.errors, warnings: result.audit.warnings, findings: (result.audit.findings || []).slice(0, 20), ...(result.audit.error ? { error: result.audit.error } : {}) } } : {}),
          };
        }
      }

      const merge = { sha, at: nowIso(), by: actor.id, approvers: counts ? [actor.id] : [], method: channel, external: true, headSha, policyMet: met, ...(met ? {} : { policyGap: evaluation.explanation }) };
      if (!refusal) {
        const updated = await store.proposals.update(p.id, {
          status: 'merged', approvals, updatedAt: nowIso(), mergeError: null,
          merge: { ...merge, accepted: true, audit: { exit: result.audit.exit, errors: result.audit.errors, warnings: result.audit.warnings } },
        });
        await record('proposal.merge', actor, p.id, channel, { sha, headSha, external: true, policyMet: true, accepted: true });
        bus.emit('proposal.merged', { proposal: updated, actor });
        return updated;
      }

      log.error('merged on GitHub but not accepted — local main left as it was', { proposal: p.id, sha, reason: refusal.reason, message: refusal.message });
      const updated = await store.proposals.update(p.id, {
        status: 'merged_unaccepted', approvals, updatedAt: nowIso(),
        mergeError: { reason: refusal.reason, message: refusal.message, at: nowIso(), ...(refusal.files ? { files: refusal.files } : {}), ...(refusal.audit ? { audit: refusal.audit } : {}) },
        merge: { ...merge, accepted: false, reason: refusal.reason, message: refusal.message },
      });
      await record('proposal.merge_unaccepted', actor, p.id, channel, { sha, headSha, external: true, policyMet: met, reason: refusal.reason });
      await record('policy.violation', actor, p.id, channel, { reason: refusal.message, code: refusal.reason, sha, ...(refusal.files ? { files: refusal.files } : {}) });
      bus.emit('proposal.updated', { proposal: updated });
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
    setPageTier,
    proposeTier,
    dismissHint,
    canonicalRole,
    getDecision: (id) => store.decisions.get(id),
    listDecisions: (prpId) => store.decisions.listByProposal(prpId),
    async evaluate(prpId) {
      const p = await load(prpId);
      return { proposal: p, ...(await evaluateProposal(p)) };
    },
    /** Can `actor` approve this proposal right now? For showing or hiding buttons — the actions re-check. */
    async mayApprove(p, actor) {
      let canReview = true;
      try { assertCanApprove(actor); assertMayAct(actor, 'web'); } catch { canReview = false; }
      try {
        assertMayAct(actor, 'web');
        policy.assertMayApprove(p, actor, { ...(await policyOptions(p, actor)), requireSso, scope: 'all', channel: 'web' });
        return { ok: true, canReview, why: '' };
      } catch (err) {
        return { ok: false, canReview, why: err.message };
      }
    },
    /** Is `actor` a person in a signed-in browser who could review at all? For showing or hiding controls — the actions re-check. */
    canReview(actor) {
      try { assertCanApprove(actor); assertMayAct(actor, 'web'); return true; } catch { return false; }
    },
    rules,
    options: { ...options, requireSso },
  };
}
