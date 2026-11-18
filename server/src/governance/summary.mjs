/**
 * summary.mjs — proposals in plain language.
 *
 * Every channel describes a proposal the same way, and none of them uses git
 * words: "3 new facts about Alpha System from “Q3 board deck” · 1 question
 * needs you", not "ingest/q3-board-deck-abc1234: 2 files changed".
 */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The question behind a proposal that live lookup queued. The lookup keeps it
 * in the job's own `lookupQuestion` field, only when queries are stored plain;
 * otherwise there is none. It is never part of the job's instructions.
 */
export function lookupQuestionOf(job) {
  if (job?.trigger !== 'lookup') return '';
  return String(job.lookupQuestion || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** One plain sentence for a proposal that exists because someone asked a question the brain could not answer; '' for any other. */
export function lookupSentence(proposal) {
  if (proposal?.trigger !== 'lookup') return '';
  return 'Fetched by live lookup: someone asked a question the brain could not answer.';
}

/** Free text as one line: line breaks and control characters become single spaces, the length is capped. A title ends up in commit messages and notifications. */
const oneLine = (v, max = 300) => {
  const t = String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

export function sourceName(source) {
  return oneLine(source?.title) || oneLine(source?.path?.split('/').pop()) || oneLine(source?.ref) || oneLine(source?.id) || 'an unnamed source';
}

export function counts(changes = []) {
  const c = { added: 0, changed: 0, removed: 0, pagesNew: 0, pagesUpdated: 0, pagesRemoved: 0, pages: 0 };
  for (const ch of changes) {
    if (ch.pageStatus === 'rejected') continue;
    c.pages++;
    if (ch.action === 'create') c.pagesNew++;
    else if (ch.action === 'delete') c.pagesRemoved++;
    else c.pagesUpdated++;
    for (const cl of ch.claims || []) {
      if (cl.op === 'add') c.added++;
      else if (cl.op === 'change') c.changed++;
      else if (cl.op === 'remove') c.removed++;
    }
  }
  return c;
}

function listNames(names, max = 3) {
  if (names.length === 0) return '';
  if (names.length <= max) return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, max).join(', ')} and ${plural(names.length - max, 'other page')}`;
}

export function titleFor(source) {
  return `New material from “${sourceName(source)}”`;
}

/** The title of a tier proposal: "Ole wants to make “Glossary” canonical." */
export function tierTitle(who, pageTitle, to) {
  return `${oneLine(who, 100)} wants to make “${oneLine(pageTitle, 200)}” ${oneLine(to, 20)}.`;
}

/** The title of a learnings proposal: "5 things the brain concluded from what it holds". */
export function learningsTitle(n) {
  if (!n) return 'The brain has a question about what it holds';
  return `${n} ${n === 1 ? 'thing' : 'things'} the brain concluded from what it holds`;
}

/** The one sentence the proposal page gives about learnings. */
export const LEARNINGS_EXPLANATION = 'These are conclusions the brain drew from pages that were already reviewed. Each one lists the pages it rests on, and you can accept or turn down each one on its own.';

const TIER_NAME = { canonical: 'canonical', curated: 'curated', evidence: 'evidence' };

/** One line: what changed, about what. */
export function changeLine(changes = []) {
  const c = counts(changes);
  const facts = [
    c.added ? plural(c.added, 'new fact') : '',
    c.changed ? plural(c.changed, 'updated fact') : '',
    c.removed ? plural(c.removed, 'removed fact') : '',
  ].filter(Boolean);
  const names = changes.filter((ch) => ch.pageStatus !== 'rejected').map((ch) => ch.title || ch.slug);
  const about = listNames(names);
  const unread = changes.filter((ch) => ch.needsManualLook && ch.pageStatus !== 'rejected').map((ch) => ch.title || ch.slug);
  if (!facts.length) {
    if (!c.pages) return 'No page changes';
    if (unread.length) return `${unread.length === 1 ? 'A new page' : `${unread.length} new pages`} with no cited facts (${listNames(unread)}) — needs a careful read`;
    return `Small edits to ${about}`;
  }
  const pagesNote = c.pagesNew ? ` (${plural(c.pagesNew, 'new page')})` : '';
  return `${facts.join(', ')} about ${about}${pagesNote}`;
}

/** The headline sentence for notifications and the queue. */
export function describe(proposal, decisions = []) {
  const open = decisions.filter((d) => d.status === 'open').length;
  const hot = (proposal.changes || []).filter((c) => c.hot && c.pageStatus !== 'rejected').length;
  const tier = proposal.kind === 'tier' ? proposal.tier : null;
  const learnings = proposal.kind === 'learnings';
  const concluded = learnings ? counts(proposal.changes).pagesNew : 0;
  const line = learnings
    ? (concluded ? `${plural(concluded, 'conclusion')} drawn from pages already reviewed` : 'No conclusions yet')
    : tier
    ? `Changes one setting of one page, its tier, from ${TIER_NAME[tier.from] || tier.from} to ${TIER_NAME[tier.to] || tier.to}`
    : changeLine(proposal.changes);
  const bits = [line];
  if (open) bits.push(`${plural(open, 'question')} ${open === 1 ? 'needs' : 'need'} you`);
  if (hot) bits.push(`${plural(hot, 'frequently-read page')}`);
  return {
    title: proposal.title || titleFor(proposal.source),
    line,
    lookup: lookupSentence(proposal),
    tier,
    learnings,
    sentence: learnings ? `${proposal.title || learningsTitle(concluded)}${open ? ` · ${plural(open, 'question')} ${open === 1 ? 'needs' : 'need'} you` : ''}` : tier ? `${proposal.title}${open ? ` · ${plural(open, 'question')} ${open === 1 ? 'needs' : 'need'} you` : ''}` : `${line} from “${sourceName(proposal.source)}”${proposal.trigger === 'lookup' ? ' · fetched by live lookup' : ''}${open ? ` · ${plural(open, 'question')} ${open === 1 ? 'needs' : 'need'} you` : ''}`,
    openDecisions: open,
    hot,
    counts: counts(proposal.changes),
  };
}

export const OP_WORDS = { add: 'New fact', change: 'Updated fact', remove: 'Removed fact' };
export const ACTION_WORDS = { create: 'New page', update: 'Updated page', delete: 'Page removed', rename: 'Renamed page' };
export const TIER_WORDS = { canonical: 'Locked reference page', curated: 'Curated page', evidence: 'Evidence page' };
export const DECISION_WORDS = {
  contradiction: 'Two sources disagree',
  canonical_conflict: 'New material disagrees with a locked reference page',
  delete: 'The agent wants to delete a page',
  merge: 'The agent wants to combine two pages',
  rename: 'The agent wants to rename a page',
  low_confidence: "The agent isn't sure about this",
  anonymization: 'A personal name was found',
};
export const STATUS_HEADLINE = {
  open: 'Waiting for review',
  changes_requested: 'Being revised by the agent',
  approved: 'Approved — still being added',
  merged: 'Added to the knowledge base',
  merged_unaccepted: 'Merged on GitHub — not accepted here',
  rejected: 'Turned down',
  superseded: 'Replaced by a newer version',
  conflicted: 'Clashes with recent changes — being revised',
};

export function auditWords(audit) {
  if (!audit || audit.exit === null || audit.exit === undefined) return { ok: false, text: 'The automatic checks have not run yet.' };
  if (audit.exit === 0) {
    return { ok: true, text: audit.warnings ? `Automatic checks passed, with ${plural(audit.warnings, 'note')}.` : 'Automatic checks passed.' };
  }
  if (audit.exit === 1) return { ok: false, text: `Automatic checks found ${plural(audit.errors || 0, 'problem')}. This can't be added until they're fixed.` };
  return { ok: false, text: "The automatic checks couldn't run. This can't be added until they do." };
}
