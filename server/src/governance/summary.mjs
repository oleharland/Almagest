/**
 * summary.mjs — proposals in plain language.
 *
 * Every channel describes a proposal the same way, and none of them uses git
 * words: "3 new facts about Alpha System from “Q3 board deck” · 1 question
 * needs you", not "ingest/q3-board-deck-abc1234: 2 files changed".
 */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function sourceName(source) {
  return source?.title || source?.path?.split('/').pop() || source?.ref || source?.id || 'an unnamed source';
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
  if (!facts.length) {
    if (!c.pages) return 'No page changes';
    return `Small edits to ${about}`;
  }
  const pagesNote = c.pagesNew ? ` (${plural(c.pagesNew, 'new page')})` : '';
  return `${facts.join(', ')} about ${about}${pagesNote}`;
}

/** The headline sentence for notifications and the queue. */
export function describe(proposal, decisions = []) {
  const open = decisions.filter((d) => d.status === 'open').length;
  const hot = (proposal.changes || []).filter((c) => c.hot && c.pageStatus !== 'rejected').length;
  const line = changeLine(proposal.changes);
  const bits = [line];
  if (open) bits.push(`${plural(open, 'question')} ${open === 1 ? 'needs' : 'need'} you`);
  if (hot) bits.push(`${plural(hot, 'frequently-read page')}`);
  return {
    title: proposal.title || titleFor(proposal.source),
    line,
    sentence: `${line} from “${sourceName(proposal.source)}”${open ? ` · ${plural(open, 'question')} ${open === 1 ? 'needs' : 'need'} you` : ''}`,
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
