/**
 * web/views.mjs — the review inbox, as HTML.
 *
 * Written for someone who has never heard of git: a proposal is "new material
 * from a source", a change is a fact next to the passage it came from, and the
 * status line says what happens next in a full sentence. The technical details
 * (branch, commit) are there, folded away, for the people who want them.
 *
 * Every value from a page, a source or a person goes through `html` and is
 * escaped. Nothing here builds markup by string concatenation.
 */
import { html, raw, safeUrl } from '../html.mjs';
import { locatorWords } from '../excerpt.mjs';
import { hintWords } from '../hints.mjs';
import { ACTION_WORDS, auditWords, counts as factCounts, DECISION_WORDS, describe, LEARNINGS_EXPLANATION, OP_WORDS, sourceName, STATUS_HEADLINE, TIER_WORDS } from '../summary.mjs';
import { frontMatterLines, layoutDiff, parseDiff, splitFront } from '../diff.mjs';
import { layout, timeAgo } from './layout.mjs';
import { groupClaims, supportFor } from './passages.mjs';
import { detailChanges, diffView, metaList, pageText, splitPage } from './pageview.mjs';
import { normalizeSources } from '../../../../tools/lib/wiki-core.mjs';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The same finding reported twice reads as two problems. Keep one, with a count. */
export function dedupeFindings(findings) {
  const out = new Map();
  for (const f of findings) {
    const k = `${f.id}|${f.slug || ''}|${f.message}`;
    if (out.has(k)) out.get(k).count = (out.get(k).count || 1) + 1;
    else out.set(k, { ...f, count: f.count && f.count > 1 ? f.count : 1 });
  }
  return [...out.values()];
}

const TIER_LIST = ['evidence', 'curated', 'canonical'];
const TIER_NAME = { evidence: 'Evidence', curated: 'Curated', canonical: 'Canonical' };
const TIER_CHOICE = { evidence: 'Make evidence', curated: 'Make curated', canonical: 'Make canonical' };

export const MESSAGES = {
  tier_changed: 'The tier was changed. This is now a new version of the proposal, so earlier approvals no longer count.',
  tier_proposed: 'The tier change is proposed. It is waiting for approval.',
  tier_done: 'Done. The tier was changed on the knowledge base.',
  hint_dismissed: 'Dismissed. It comes back only if many more documents contribute to the page.',
  approved: 'Thanks — your approval is recorded.',
  merged: 'Done — this is now part of the knowledge base.',
  page_accepted: 'Page accepted.',
  page_rejected: 'That page will be taken out. The agent is on it.',
  changes_requested: 'Sent. The agent will revise this and it will come back to you.',
  rejected: 'Turned down. Nothing from this proposal was added.',
  resolved: 'Answer recorded.',
  retried: 'Tried again.',
  confirmed: 'Confirmed.',
};

function flashBox(flash) {
  if (!flash) return '';
  return html`<div class="al-callout ${flash.error ? 'al-callout--danger' : 'al-callout--success'}" role="${flash.error ? 'alert' : 'status'}">${flash.text}</div>`;
}

function csrfField(csrf) {
  return html`<input type="hidden" name="csrf" value="${csrf}">`;
}

/** The version the person is looking at. The service refuses the action if it has moved on. */
function headField(p) {
  return html`<input type="hidden" name="headSha" value="${p.headSha}">`;
}

// ── tiers ────────────────────────────────────────────────────────────────────

/** What canonical means for a page, in plain words. Shown before anyone confirms it. */
function canonicalMeaning(title) {
  return html`<p><strong>Make “${title}” canonical?</strong></p>
    <p>Before you confirm, here is what that means for this page.</p>
    <ul>
      <li>The agent can no longer change this page.</li>
      <li>New material that contradicts it is logged as a challenge and is not merged.</li>
      <li>Only a person can edit it.</li>
    </ul>`;
}

/**
 * The choices for a page's tier, as small forms. Canonical needs one confirm
 * step with its meaning in front of it; a change to or from canonical needs
 * the role the policy names, and says so when the person lacks it.
 */
function tierChoices({ action, current, title, csrf, hidden = '', canCanonical, canonicalRole }) {
  const choices = TIER_LIST.filter((t) => t !== current);
  const touchesCanonical = (t) => t === 'canonical' || current === 'canonical';
  return html`${choices.map((t) => {
    if (touchesCanonical(t) && !canCanonical) {
      return html`<p class="al-text-tertiary">${t === 'canonical' ? `Only someone with the ${canonicalRole} role can make a page canonical.` : `Only someone with the ${canonicalRole} role can change a canonical page.`}</p>`;
    }
    if (t === 'canonical') {
      return html`<details class="al-details"><summary>${TIER_CHOICE[t]}</summary>
        <div class="al-card">${canonicalMeaning(title)}
          <form method="post" action="${action}">${csrfField(csrf)}${hidden}<input type="hidden" name="to" value="${t}"><input type="hidden" name="confirm" value="yes">
            <button class="al-btn al-btn--primary" type="submit">Yes, make it canonical</button></form>
        </div></details>`;
    }
    return html`<form method="post" action="${action}">${csrfField(csrf)}${hidden}<input type="hidden" name="to" value="${t}"><button class="al-btn al-btn--sm" type="submit">${TIER_CHOICE[t]}</button></form>`;
  })}`;
}

// ── queue ────────────────────────────────────────────────────────────────────

function statusChip(p) {
  const cls = { merged: 'al-chip--success', merged_unaccepted: 'al-chip--danger', rejected: 'al-chip--danger', conflicted: 'al-chip--warning', superseded: '', changes_requested: '', approved: 'al-chip--success' }[p.status] ?? '';
  return html`<span class="al-chip ${cls}">${STATUS_HEADLINE[p.status] || p.status}</span>`;
}

export function queuePage({ items, filters, actor, csrf, nonce, now = Date.now(), flash = null, navCounts = {} }) {
  const tab = (key, label) => html`<a class="al-segmented__item" href="/inbox?show=${key}" aria-current="${filters.show === key ? 'true' : 'false'}">${label}</a>`;
  const active = items.filter((i) => ['open', 'approved', 'conflicted', 'changes_requested'].includes(i.proposal.status));
  const waiting = active.filter((i) => i.proposal.status === 'open' || i.proposal.status === 'approved').length;
  const questions = items.reduce((n, i) => n + i.info.openDecisions, 0);
  const lede = filters.show === 'done'
    ? 'Proposals that were added or turned down.'
    : waiting
      ? `${plural(waiting, 'proposal')} waiting for you${questions ? `, with ${plural(questions, 'question')}` : ''}.`
      : 'Nothing is waiting for you right now.';

  const body = html`
    ${flashBox(flash)}
    <h1>Review inbox</h1>
    <p class="al-lede">${lede}</p>
    <div class="al-cluster al-toolbar">
      <div class="al-segmented">${tab('active', 'To review')}${tab('done', 'Done')}${tab('all', 'All')}</div>
      <div class="al-segmented">
      <a class="al-segmented__item" href="${safeUrl(`/inbox?show=${encodeURIComponent(filters.show)}${filters.questions ? '' : '&questions=1'}`)}" aria-current="${filters.questions ? 'true' : 'false'}">With questions</a>
      <a class="al-segmented__item" href="${safeUrl(`/inbox?show=${encodeURIComponent(filters.show)}${filters.hot ? '' : '&hot=1'}`)}" aria-current="${filters.hot ? 'true' : 'false'}">Frequently read pages</a>
      </div>
      <form class="al-search" method="get" action="/inbox" role="search">
        <input type="hidden" name="show" value="${filters.show}">
        <input class="al-input" type="search" name="q" value="${filters.q}" placeholder="Search by source or page" aria-label="Search">
      </form>
    </div>
    ${items.length === 0
      ? html`<div class="al-empty">${filters.show === 'done' ? 'Nothing here yet.' : 'Nothing to review. New material shows up here when the agent finishes reading a source.'}</div>`
      : html`<ul class="al-stack al-stack--sm al-queue" role="list">${items.map(({ proposal: p, info }) => {
        const name = proposalName(p, info);
        const c = info.counts;
        const facts = c.added + c.changed + c.removed;
        return html`
        <li><a class="al-card al-card--interactive al-queuerow" href="/inbox/p/${encodeURIComponent(p.id)}" title="${info.title}">
          <div class="al-queuerow__main">
            <div class="al-card__title">${name.title}</div>
            ${name.ref ? html`<div class="al-queuerow__ref al-mono">${name.ref}</div>` : ''}
            <div class="al-text-secondary">${info.line}</div>
          </div>
          <div class="al-queuerow__counts">${c.pages ? plural(c.pages, 'page') : 'No pages'}${facts ? html`<span class="al-delta"><span class="al-delta__add">+${c.added}</span> <span class="al-delta__chg">~${c.changed}</span> <span class="al-delta__del">-${c.removed}</span></span>` : ''}</div>
          <div class="al-queuerow__state al-cluster">
            ${info.openDecisions ? html`<span class="al-chip al-chip--warning">${plural(info.openDecisions, 'question')} for you</span>` : ''}
            ${info.hot ? html`<span class="al-chip al-chip--info">${info.hot === 1 ? 'Frequently read page' : `${info.hot} frequently read pages`}</span>` : ''}
            ${statusChip(p)}
          </div>
          <div class="al-queuerow__age al-text-tertiary">${timeAgo(p.createdAt, now)}</div>
        </a></li>`;
      })}</ul>`}`;
  return layout({ title: 'Review inbox', actor, nonce, csrf, current: 'inbox', body, navCounts });
}

// ── one proposal ─────────────────────────────────────────────────────────────

function citationLine(claim) {
  const c = claim.citation;
  if (!c || !c.id) return html`<div class="al-source al-source--missing">No source given for this.</div>`;
  if (c.id === 'unknown') return html`<div class="al-source al-source--missing">The source for this is not known yet — it is listed as an open question.</div>`;
  return html`<div class="al-source">Source: <strong>${c.title || c.id}</strong>, ${locatorWords(c.locator)}${c.date ? html` · ${c.date}` : ''}</div>`;
}

function excerptBlock(claim) {
  switch (claim.excerptStatus) {
    case 'found':
      return html`<blockquote class="al-quote" aria-label="What the source says">${claim.excerpt}</blockquote>`;
    case 'not-found':
      return html`<div class="al-source al-source--missing">We couldn't find that spot in the source. Check it by hand before you approve.</div>`;
    case 'source-missing':
      return html`<div class="al-source al-source--missing">The source file isn't available here, so the passage can't be shown.</div>`;
    case 'unknown-source':
      return html`<div class="al-source al-source--missing">This cites a source the page doesn't list. That's worth a closer look.</div>`;
    default:
      return '';
  }
}

function hotWhy(e) {
  if (!e) return '';
  const bits = [];
  if (e.rank) bits.push(`#${e.rank} by recent reads`);
  if (e.distinctSessions) bits.push(`${plural(e.distinctSessions, 'person', 'people')} recently`);
  if (typeof e.score === 'number') bits.push(`demand score ${e.score.toFixed(1)}`);
  return bits.length ? html`<p class="al-text-tertiary">Why it counts as frequently read: ${bits.join(', ')}. Changes to it need a closer look.</p>` : '';
}

/** One sentence for a page written as an addition to a page that waits in another proposal. */
function extendsNote(e) {
  return html`<p class="al-text-tertiary">This page adds to one that is waiting in another proposal, ${e.proposalId ? html`<a href="/inbox/p/${encodeURIComponent(e.proposalId)}">${e.title || 'that proposal'}</a>` : 'that proposal'}. When both are approved, the service combines the two versions section by section. If they disagree anywhere, the agent is asked to redo this page on top of what is already there.</p>`;
}

/** A learning: the conclusion in the agent's words, and the pages it rests on as links. */
const CONFIDENCE_WORDS = { high: 'High', medium: 'Medium', low: 'Low', unknown: 'Unknown' };
const RELATION_WORDS = { supports: 'Supports', contradicts: 'Contradicts', supersedes: 'Replaces', depends_on: 'Depends on' };

/** The fields of a learning's front matter that carry meaning, open above the body: some reach chats as they are. */
function learningMeta(meta) {
  if (!meta) return '';
  const row = (label, items) => (items.length ? html`<dt>${label}</dt><dd>${items.join(', ')}</dd>` : '');
  const relations = Object.entries(meta.relations || {}).filter(([, v]) => v.length);
  return html`<dl class="al-dl al-dl--mono learning-meta">
    <dt>Title</dt><dd>${meta.title}</dd>
    ${row('Aliases', meta.aliases || [])}
    ${row('Tags', meta.tags || [])}
    <dt>Confidence</dt><dd>${CONFIDENCE_WORDS[meta.confidence] || meta.confidence || 'Not set'}</dd>
    ${row('Related pages', meta.related || [])}
    ${relations.map(([k, v]) => row(RELATION_WORDS[k] || k, v))}
  </dl>`;
}

function learningBody(change) {
  const basis = change.basis || [];
  return html`${learningMeta(change.meta)}<p class="al-text-tertiary">What it rests on</p>
    ${basis.length
      ? html`<ul class="basis al-stack al-stack--sm" role="list">${basis.map((b) => html`<li><a href="/inbox/pages/${encodeURIComponent(b.slug)}">${b.title || b.slug}</a></li>`)}</ul>`
      : html`<p class="al-source al-source--missing">This page names no pages it rests on. Do not accept it as it is.</p>`}
    ${typeof change.body === 'string'
      ? html`<p class="al-text-tertiary">The whole learning, as the brain wrote it</p><pre class="al-pre al-pre--wrap">${change.body}</pre>
        ${change.front ? html`<details class="al-details"><summary>Page details</summary><pre class="al-pre al-pre--wrap">${change.front}</pre></details>` : ''}`
      : change.preview ? html`<p class="al-text-tertiary">The conclusion (the start only)</p><pre class="al-pre al-pre--wrap al-pre--preview">${change.preview}</pre>` : ''}`;
}

// ── the page sections ────────────────────────────────────────────────────────

const MARKER_WORDS = { create: 'New', update: 'Changed', rename: 'Renamed', delete: 'Removed' };
const MARKER_CLASS = { create: 'al-chip--success', update: 'al-chip--info', rename: 'al-chip--info', delete: 'al-chip--danger' };
/** Core first: new pages, then changed ones, then renamed and removed. */
const ORDER = { create: 0, update: 1, rename: 2, delete: 3 };
const orderedChanges = (changes) => [...changes].sort((a, b) => (ORDER[a.action] ?? 1) - (ORDER[b.action] ?? 1));

const VIEWS = ['compare', 'page'];
const DIFF_MODES = ['unified', 'split'];
/** A value from the address, or the default when it is not one we offer. */
export const pickView = (v) => (VIEWS.includes(v) ? v : 'compare');
export const pickDiff = (v) => (DIFF_MODES.includes(v) ? v : 'unified');

/** The link to this proposal in a given view, optionally to a spot on the page. Both choices travel in the address. */
function reviewHref(p, { view, diff }, hash = '') {
  const q = [`view=${pickView(view)}`];
  if (pickDiff(diff) === 'split') q.push('diff=split');
  return `/inbox/p/${encodeURIComponent(p.id)}?${q.join('&')}${hash}`;
}

/** Hidden fields that carry the chosen view through a form post, so the person lands back where they were. */
function keepFields(view, diff) {
  return html`${view !== 'compare' ? html`<input type="hidden" name="view" value="${view}">` : ''}${diff === 'split' ? html`<input type="hidden" name="diff" value="${diff}">` : ''}`;
}

const SVG = (body) => raw(`<svg class="al-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`);
const ICON_PENDING = SVG('<circle cx="8" cy="8" r="5.5"/>');
const ICON_ACCEPTED = SVG('<circle cx="8" cy="8" r="5.5"/><path d="M5.5 8.2l1.7 1.7 3.3-3.6"/>');
const ICON_OUT = SVG('<circle cx="8" cy="8" r="5.5"/><path d="M5.8 8h4.4"/>');
const ICON_ASK = SVG('<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.4M8 10.6v.1"/>');

const stateOf = (change) => (change.pageStatus === 'rejected' ? { icon: ICON_OUT, words: 'Taken out', cls: 'out' }
  : change.pageStatus === 'accepted' ? { icon: ICON_ACCEPTED, words: 'Accepted', cls: 'accepted' }
    : { icon: ICON_PENDING, words: 'Not accepted yet', cls: 'pending' });

/** `+12 ~1 -0`: facts added, changed and removed on a page. */
function deltaOf(change) {
  const c = { add: 0, change: 0, remove: 0 };
  for (const cl of change.claims || []) if (cl.op in c) c[cl.op]++;
  return c;
}

function deltaHtml(change) {
  const d = deltaOf(change);
  if (!d.add && !d.change && !d.remove) return '';
  return html`<span class="al-delta"><span aria-hidden="true"><span class="al-delta__add">+${d.add}</span> <span class="al-delta__chg">~${d.change}</span> <span class="al-delta__del">-${d.remove}</span></span><span class="al-visually-hidden">${plural(d.add, 'fact')} added, ${d.change} changed, ${d.remove} removed</span></span>`;
}

// ── compare: each fact next to its passage ───────────────────────────────────

function factCard(claim, slug, n) {
  return html`<div class="al-claim al-claim--${claim.op}" id="fact-${slug}-${n}" data-fact tabindex="-1">
    <div class="al-claim__op">${OP_WORDS[claim.op] || claim.op}</div>
    ${claim.op === 'change' && claim.before && claim.before !== claim.text ? html`<div class="al-claim__was">Was: <del>${claim.before}</del></div>` : ''}
    <p class="al-claim__text">${claim.text}</p>
    ${claim.op === 'change' && claim.before === claim.text ? html`<div class="al-claim__was">Same wording — the source it points to changed.</div>` : ''}
  </div>`;
}

/** The right side of one fact's row: the part of the passage that supports it, or the warning that there is none. */
function supportCell(group, claim) {
  if (group.status !== 'found' || group.passage === null) return html`${citationLine(claim)}${excerptBlock(claim)}`;
  const s = supportFor(claim.excerpt ?? group.passage, claim.text);
  return s.matched
    ? html`<p class="al-compare__support">${s.html}</p>`
    : html`<p class="al-compare__support al-compare__support--none">${s.html}</p><p class="al-text-tertiary">No sentence in this passage clearly matches. Read the whole passage.</p>`;
}

/** One row per fact. The source and spot are named once above its group, and the whole passage is one fold below it. */
function compareView(change) {
  const groups = groupClaims(change.claims);
  let n = 0;
  return html`<div class="al-compare">
    <div class="al-compare__head"><span>What gets written</span><span>Where it comes from</span></div>
    ${groups.map((g) => {
      const found = g.status === 'found' && g.passage !== null;
      return html`<div class="al-compare__group">
        ${found ? html`<div class="al-compare__src">${citationLine(g.items[0].claim)}</div>` : ''}
        ${g.items.map((it) => html`<div class="al-compare__row">
          <div class="al-compare__facts"><p class="al-compare__label">What gets written</p>${factCard(it.claim, change.slug, n++)}</div>
          <div class="al-compare__source"><div class="al-compare__passage"><p class="al-compare__label">Where it comes from</p>${supportCell(g, it.claim)}</div></div>
        </div>`)}
        ${found ? html`<details class="al-details al-compare__whole"><summary>Show the whole passage</summary><blockquote class="al-quote" aria-label="What the source says">${g.passage}</blockquote></details>` : ''}
      </div>`;
    })}
  </div>`;
}

// ── whole page: what the wiki will say ───────────────────────────────────────

const lineList = (text) => {
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

function sizeNote(shown, total, what) {
  return html`<div class="al-callout al-callout--warning" role="note">${what} is ${size(total)}. Only the first ${size(shown)} is shown here. The rest is not shown. Approving still adds all of it.</div>`;
}

/** In the whole page view the facts sit inside the text, so those without a checked source are listed above it, with their warnings. */
function checkList(change) {
  const bad = (change.claims || []).filter((cl) => cl.excerptStatus !== 'found');
  if (!bad.length) return '';
  return html`<details class="al-details" open><summary>${plural(bad.length, 'fact')} without a checked source</summary>
    <div class="al-flow">${bad.map((cl) => html`<div class="al-claim al-claim--${cl.op}"><div class="al-claim__op">${OP_WORDS[cl.op] || cl.op}</div><p class="al-claim__text">${cl.text}</p>${citationLine(cl)}${excerptBlock(cl)}</div>`)}</div></details>`;
}

function wholePageView(change, rv) {
  const entry = rv.texts?.[change.slug];
  if (!entry?.text) return html`<p class="al-source al-source--missing">The text of this page could not be read here. Read it another way before you approve.</p>`;
  const t = entry.text;
  const removed = change.action === 'delete';
  const parts = splitPage(t.text);
  const ptitles = new Map(normalizeSources(parts.data.sources).map((x) => [x.id, x.title]));
  const note = t.truncated ? sizeNote(t.shownBytes, t.bytes, 'This page') : '';
  if (removed || change.action === 'create') {
    return html`${removed ? html`<div class="al-callout al-callout--danger" role="note">This page would be removed. This is what it says now.</div>` : ''}
      ${note}
      ${parts.ok ? metaList(parts.data, { tier: change.tier }) : html`<p class="al-source al-source--missing">The details at the top of this page could not be read, so the whole text is shown below.</p>`}
      ${pageText(parts.body, { titles: ptitles, single: pageSingle(parts.data), removed })}`;
  }
  // A changed page: git's diff between the version the branch started from and the one being reviewed.
  if (!entry.diff) {
    return html`<p class="al-source al-source--missing">The changes to this page could not be read here, so the whole page is shown.</p>${note}${pageText(parts.body, { titles: ptitles, single: pageSingle(parts.data) })}`;
  }
  const parsed = parseDiff(entry.diff.text);
  const file = parsed.files[0];
  const mode = rv.diffMode;
  const label = `Changes to ${change.title}`;
  const newLines = lineList(t.text);
  const before = entry.base ? splitPage(entry.base.text) : null;
  const split = Boolean(file && file.hunks.length && before?.ok && parts.ok);
  const front = split ? splitFront(file, frontMatterLines(entry.base.text), frontMatterLines(t.text)) : null;
  const tools = html`<div class="al-difftools">
    <span class="al-difftools__counts"><span class="al-delta__add">+${parsed.added}</span> <span class="al-delta__del">-${parsed.removed}</span> <span class="al-text-tertiary">${entry.diff.truncated ? 'lines in the part shown' : plural(parsed.added + parsed.removed, 'line') + ' changed'}</span></span>
    <nav class="al-segmented al-difftools__mode" aria-label="How to show the changes">
      <a class="al-segmented__item" data-diff="unified" aria-current="${mode === 'unified' ? 'true' : 'false'}" href="${safeUrl(reviewHref(rv.p, { view: 'page', diff: 'unified' }, `#page-${change.slug}`))}">One column</a>
      <a class="al-segmented__item" data-diff="split" aria-current="${mode === 'split' ? 'true' : 'false'}" href="${safeUrl(reviewHref(rv.p, { view: 'page', diff: 'split' }, `#page-${change.slug}`))}">Side by side</a>
    </nav></div>`;
  const sizeNotes = html`${note}${entry.diff.truncated ? sizeNote(entry.diff.shownBytes, entry.diff.bytes, 'The list of changes to this page') : ''}`;
  const renamed = change.from ? html`<p class="al-text-secondary">Renamed from “${change.from}”.</p>` : '';
  if (!file || !file.hunks.length) {
    return html`${renamed}${sizeNotes}<p class="al-text-secondary">${file?.renamed ? 'Only the name of this page changes. Its text stays the same.' : 'No lines of this page change.'}</p>`;
  }
  if (!split) {
    return html`${renamed}${sizeNotes}<p class="al-source al-source--missing">The details at the top of this page could not be read on one side, so the raw changes to the whole file are shown.</p>${tools}${diffView(layoutDiff(file, newLines, { newTotal: entry.lines }), mode, label)}`;
  }
  const oldFront = frontMatterLines(entry.base.text);
  const newFront = frontMatterLines(t.text);
  const said = detailChanges(before.data, parts.data);
  return html`${renamed}${sizeNotes}
    <section class="al-detailchanges" aria-labelledby="dc-${change.slug}">
      <h4 id="dc-${change.slug}">What changed in the page's details</h4>
      ${said.length ? html`<ul class="al-detailchanges__list">${said.map((x) => html`<li>${x}</li>`)}</ul>` : html`<p class="al-text-secondary">The details at the top of the page did not change.</p>`}
      ${front.front.hunks.length ? html`<details class="al-details"><summary>Show the raw details block</summary>${diffView(layoutDiff(front.front, newLines, { newTotal: newFront }), mode, `${label}, details block`)}</details>` : ''}
    </section>
    <h4>What changed in the text</h4>
    ${tools}
    ${front.body.hunks.length
      ? diffView(layoutDiff(front.body, newLines, { newTotal: entry.lines, from: { old: oldFront + 1, new: newFront + 1 } }), mode, label)
      : html`<p class="al-text-secondary">The text of the page did not change.</p>`}`;
}

/** True when a page names one source or none: its citation chips then say only the locator. */
function pageSingle(data) { return normalizeSources(data.sources).length <= 1; }

// ── one page of the proposal ─────────────────────────────────────────────────

function pageSection(change, rv) {
  const { p, canAct, csrf, required, tiers, keep } = rv;
  const req = required?.pages?.[change.slug];
  const rejected = change.pageStatus === 'rejected';
  const accepted = change.pageStatus === 'accepted';
  const action = change.action === 'rename' && change.from ? `Renamed from “${change.from}”` : ACTION_WORDS[change.action] || change.action;
  const id = encodeURIComponent(p.id);
  const slugId = encodeURIComponent(change.slug);
  const normal = p.kind !== 'learnings' && p.kind !== 'tier';
  const showTier = tiers && !rejected && change.action !== 'delete' && p.kind !== 'tier' && !(change.canonical && !change.promotes);
  const st = stateOf(change);
  const body = p.kind === 'learnings'
    ? learningBody(change)
    : rv.view === 'page' && normal ? wholePageView(change, rv) : null;

  return html`<section class="al-pagesec${rejected ? ' al-pagesec--out' : ''}" id="page-${change.slug}" data-page aria-labelledby="title-${change.slug}">
    <div class="al-pagesec__head">
      <div class="al-pagesec__title">
        <span class="al-pagesec__state al-pagesec__state--${st.cls}">${st.icon}<span class="al-visually-hidden">${st.words}: </span></span>
        <h3 id="title-${change.slug}">${change.title}</h3>
        <span class="al-chip ${MARKER_CLASS[change.action] || ''}">${action}</span>
        ${deltaHtml(change)}
      </div>
      <div class="al-pagesec__tools">
        ${normal ? html`<nav class="al-segmented" aria-label="View of this page">
          <a class="al-segmented__item" data-view="compare" aria-current="${rv.view === 'compare' ? 'true' : 'false'}" href="${safeUrl(reviewHref(p, { view: 'compare', diff: rv.diffMode }, `#page-${change.slug}`))}">Compare</a>
          <a class="al-segmented__item" data-view="page" aria-current="${rv.view === 'page' ? 'true' : 'false'}" href="${safeUrl(reviewHref(p, { view: 'page', diff: rv.diffMode }, `#page-${change.slug}`))}">Whole page</a>
        </nav>` : ''}
        ${showTier ? html`<details class="al-menu"><summary class="al-btn al-btn--sm">Change the tier</summary>
          <div class="al-menu__panel al-stack al-stack--sm"><p class="al-text-tertiary">Now: <strong>${TIER_NAME[change.tier] || change.tier}</strong></p>${tierChoices({
            action: `/inbox/p/${id}/page/${slugId}/tier`, current: change.tier, title: change.title,
            csrf, hidden: html`${headField(p)}${keep}`, canCanonical: tiers.canCanonical, canonicalRole: tiers.canonicalRole,
          })}</div></details>` : ''}
        ${canAct.canReview && !rejected ? html`
          ${accepted || !canAct.ok ? '' : html`<form method="post" action="/inbox/p/${id}/page/${slugId}/accept">${csrfField(csrf)}${headField(p)}${keep}<button class="al-btn al-btn--sm" type="submit">Accept page</button></form>`}
          <form method="post" action="/inbox/p/${id}/page/${slugId}/reject" data-confirm="Take this page out of the proposal?">${csrfField(csrf)}${keep}<button class="al-btn al-btn--sm al-btn--danger" type="submit">Take this page out</button></form>` : ''}
      </div>
    </div>
    <div class="al-pagesec__body al-flow">
      <div class="al-cluster">
        <span class="al-tier al-tier--${change.tier}">${TIER_WORDS[change.tier] || change.tier}</span>
        ${change.canonical && !change.promotes ? html`<span class="al-chip al-chip--danger">Locked — can't be changed here</span>` : ''}
        ${change.promotes ? html`<span class="al-chip al-chip--danger">Made canonical without a person choosing it</span>` : ''}
        ${change.tierSetBy ? html`<span class="al-chip al-chip--success">Made canonical by ${change.tierSetBy.display || change.tierSetBy.by}</span>` : ''}
        ${change.hot ? html`<span class="al-chip al-chip--info">Frequently read</span>` : ''}
        ${change.owner ? html`<span class="al-chip">Owned by ${change.owner}</span>` : ''}
        ${req?.explicit && !rejected ? html`<span class="al-chip al-chip--warning">Needs its own approval</span>` : ''}
        ${accepted ? html`<span class="al-chip al-chip--success">Accepted</span>` : ''}
        ${rejected ? html`<span class="al-chip al-chip--danger">Taken out</span>` : ''}
      </div>
      ${(p.extends || []).filter((e) => e.slug === change.slug).map(extendsNote)}
      ${change.hot ? hotWhy(rv.why) : ''}
      ${body !== null && p.kind === 'learnings' ? body : ''}
      ${p.kind === 'learnings' ? '' : change.needsManualLook ? html`<p class="al-source al-source--missing">This new page has no facts the inbox could pair with a source, so nothing below has been checked for you. Read the whole page before you approve.</p>
        ${rv.view === 'page' && normal ? '' : html`<pre class="al-pre al-pre--wrap al-pre--preview">${change.preview || ''}</pre>`}` : ''}
      ${p.kind === 'learnings' ? '' : (change.fields || []).length ? html`<details class="al-details"><summary>${plural(change.fields.length, 'detail')} changed</summary>
        <dl class="al-dl al-dl--mono">${change.fields.map((f) => html`<dt>${f.label}</dt><dd>${f.before || '—'} → ${f.after || '—'}</dd>`)}</dl></details>` : ''}
      ${p.kind === 'learnings' ? '' : rv.view === 'page' && normal
        ? html`${checkList(change)}${body}`
        : change.needsManualLook ? '' : change.claims.length === 0 && !(change.fields || []).length
          ? html`<p class="al-text-secondary">${change.action === 'delete' ? 'The whole page would be removed.' : 'No facts changed — only formatting or wording without a source.'}</p>`
          : change.claims.length ? compareView(change) : ''}
    </div>
  </section>`;
}


/** "alpha-pdf, p.3" → "Alpha System Overview, page 3", using the titles the proposal's pages give their sources. */
function sourceTitles(p) {
  const titles = new Map();
  if (p.source?.id && p.source.title) titles.set(p.source.id, p.source.title);
  // What the pages call a source wins: that is the name the reviewer sees on every fact.
  for (const ch of p.changes || []) {
    for (const cl of ch.claims || []) for (const c of [cl.citation, ...(cl.citations || [])]) if (c?.id && c.title) titles.set(c.id, c.title);
  }
  return titles;
}

function sourceWords(text, titles) {
  const m = String(text || '').match(/^\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*,\s*(.+)$/);
  if (!m) return titles.get(String(text || '').trim()) || text;
  return `${titles.get(m[1]) || m[1]}, ${locatorWords(m[2].trim())}`;
}

function decisionCard(p, d, { canAct, csrf, keep = '' }) {
  const c = d.context || {};
  const titles = sourceTitles(p);
  if (d.status !== 'open') {
    return html`<div class="al-decision al-decision--resolved"><h3>${DECISION_WORDS[d.kind] || d.kind}</h3>
      <p class="al-text-secondary">${d.question}</p>
      <p>Answered by ${d.resolution?.display || d.resolution?.actorId}: <strong>${d.resolution?.label || d.resolution?.optionId}</strong>${d.resolution?.note ? html` — “${d.resolution.note}”` : ''}</p></div>`;
  }
  return html`<div class="al-decision" id="decision-${d.id}">
    <h3>${DECISION_WORDS[d.kind] || d.kind}</h3>
    <p>${d.question}</p>
    ${c.claimA || c.claimB ? html`<div class="al-decision__vs">
      ${c.claimA ? html`<div class="al-decision__side"><div class="al-text-tertiary">The knowledge base says</div>${c.claimA}${c.sourceA ? html`<div class="al-source">Source: ${sourceWords(c.sourceA, titles)}</div>` : ''}</div>` : ''}
      ${c.claimB ? html`<div class="al-decision__side"><div class="al-text-tertiary">The new material says</div>${c.claimB}${c.sourceB ? html`<div class="al-source">Source: ${sourceWords(c.sourceB, titles)}</div>` : ''}</div>` : ''}
    </div>` : ''}
    ${canAct.canReview ? html`<form class="al-stack al-stack--sm" method="post" action="/inbox/d/${encodeURIComponent(d.id)}/resolve">
      ${csrfField(csrf)}${headField(p)}${keep}
      <label class="al-label" for="note-${d.id}">Note for the agent (optional)</label>
      <input class="al-input" type="text" id="note-${d.id}" name="note" maxlength="2000">
      <div class="al-decision__options">${d.options.map((o) => html`<button class="al-btn al-btn--block" type="submit" name="optionId" value="${o.id}">${o.label}</button>`)}</div>
    </form>` : html`<p class="al-text-tertiary">${canAct.why}</p>`}
  </div>`;
}

function needsBox(evaluation, p) {
  if (p.status === 'merged') {
    return html`<div class="al-panel al-panel--success"><h2>Added to the knowledge base</h2><p>${p.merge?.at ? `On ${p.merge.at.slice(0, 10)}` : ''}${p.merge?.approvers?.length ? `, approved by ${p.approvals.filter((a) => p.merge.approvers.includes(a.actorId)).map((a) => a.display).filter((v, i, a) => a.indexOf(v) === i).join(', ')}` : ''}.</p>${p.merge?.combined?.length ? html`<p>${plural(p.merge.combined.length, 'page')} (${p.merge.combined.join(', ')}) ${p.merge.combined.length === 1 ? 'was' : 'were'} combined with what was already there, section by section.</p>` : ''}</div>`;
  }
  if (p.status === 'merged_unaccepted') {
    return html`<div class="al-panel"><h2>Merged on GitHub, not accepted here</h2><p>${p.merge?.by ? `Merged by ${p.merge.by}` : 'Merged'}${p.merge?.at ? ` on ${p.merge.at.slice(0, 10)}` : ''}, but the knowledge base was not updated: ${p.merge?.message || p.mergeError?.message || 'it could not be verified.'}</p><p>An administrator has to reconcile it by hand. This is recorded as a policy violation.</p></div>`;
  }
  if (p.status === 'rejected') {
    return html`<div class="al-panel"><h2>Turned down</h2><p>${p.rejection?.display ? `By ${p.rejection.display}` : ''}${p.rejection?.reason ? html`: “${p.rejection.reason}”` : '.'}</p></div>`;
  }
  if (evaluation.ready) return html`<div class="al-panel al-panel--success"><h2>Ready</h2><p>${evaluation.explanation}</p></div>`;
  const items = [...evaluation.blockers, ...evaluation.missing];
  return html`<div class="al-panel"><h2>Before this can be added</h2><ul>${items.map((x) => html`<li>${x.message}</li>`)}</ul></div>`;
}

const FILE_STATUS = { A: 'New file', M: 'Changed', D: 'Removed', R: 'Renamed' };

function size(bytes) {
  return bytes < 1024 ? plural(bytes, 'byte') : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

/** Files the service keeps by itself: new ones of these need no close reading. */
const BOOKKEEPING = /(^|\/)(index\.md|log\.md|manifest\.yaml|canonical-challenges\.md)$|(^|\/)\.index\/|(^|\/)raw\/(extracted|processed)\//;

/**
 * Every file the proposal changes outside the wiki, with what it says — the
 * bookkeeping, and anything under raw/. Approving the proposal approves these
 * too, so they are shown, not just named. Each is folded, except a new file
 * that is not one of the usual bookkeeping files: that one starts open.
 */
function otherFilesSection(files) {
  if (!files.length) return '';
  return html`<div id="other-files" class="al-flow"><h2>Other files</h2>
    <p class="al-text-secondary">Approving also adds these. Read anything you didn't expect.</p>
    ${files.map((f, i) => html`<details class="al-filecard" id="file-${i}"${f.status === 'A' && !BOOKKEEPING.test(f.path) ? raw(' open') : ''}>
      <summary class="al-filecard__head">
        <strong class="al-filecard__path">${f.path}</strong>
        <span class="al-cluster"><span class="al-chip">${FILE_STATUS[f.status] || f.status}${f.from ? ` from ${f.from}` : ''}</span>${f.bytes != null ? html`<span class="al-chip">${size(f.bytes)}${f.lines != null ? `, ${plural(f.lines, 'line')}` : ''}</span>` : ''}</span>
      </summary>
      <div class="al-filecard__body al-flow">
        ${f.binary ? html`<p class="al-source al-source--missing">A binary file — it can't be shown here.</p>`
          : f.preview != null ? html`<p class="al-text-tertiary">${f.previewOf === 'added' ? 'Lines this adds' : 'Content'}${f.previewTruncated ? ' (the start only)' : ''}:</p><pre class="al-pre al-pre--wrap al-pre--preview">${f.preview}</pre>`
          : html`<p class="al-text-tertiary">Nothing to show for this file.</p>`}
      </div>
    </details>`)}</div>`;
}

// ── the name of a proposal ───────────────────────────────────────────────────

/**
 * What to call a proposal on screen: the document's own name, with the path or
 * reference under it. The stored `proposal.title` is not touched: commit
 * messages, the log and notifications keep using it.
 */
export function proposalName(p, info = null) {
  const i = info || describe(p, []);
  if (p.kind === 'learnings' || p.kind === 'tier' || !p.source) return { title: i.title, ref: '' };
  const src = p.source;
  const looksLikePath = (t) => /\//.test(t) && !/\s/.test(t);
  // What the pages call this document: matched by the snapshot path, then by id.
  const named = new Map();
  for (const ch of p.changes || []) {
    for (const cl of ch.claims || []) {
      const c = cl.citation;
      if (!c?.title) continue;
      if (src.path && c.path === src.path) named.set('path', named.get('path') || c.title);
      if (src.id && c.id === src.id) named.set('id', named.get('id') || c.title);
      if (cl.op !== 'remove') named.set(`n:${c.title}`, (named.get(`n:${c.title}`) || 0) + 1);
    }
  }
  // The source's own title, when it has a real one. A title that is only a path says little: then the pages' name for it, or the name most new facts cite.
  const ownTitle = src.title && !looksLikePath(src.title) ? sourceName(src) : '';
  let title = ownTitle || named.get('path') || named.get('id') || '';
  if (!title && (!src.title || looksLikePath(src.title))) {
    const best = [...named].filter(([k]) => k.startsWith('n:') && k !== 'n:unknown').sort((a, b) => b[1] - a[1])[0];
    if (best) title = best[0].slice(2);
  }
  title = title || sourceName(src);
  const ref = src.connector && src.ref ? `${src.label || src.connector} · ${src.ref}` : String(src.path || src.ref || src.id || '').trim();
  return { title, ref: ref === title ? '' : ref };
}

// ── the review page ──────────────────────────────────────────────────────────

/** The line under the title: how much changes, and when it was sent. */
function summaryLine(p, info, now) {
  const when = `Sent ${timeAgo(p.createdAt, now)}${p.revision > 1 ? `, revised ${plural(p.revision - 1, 'time')}` : ''}`;
  if (p.kind === 'learnings' || p.kind === 'tier') return `${info.line}. ${when}.`;
  const c = info.counts;
  const pages = [c.pagesNew ? plural(c.pagesNew, 'new page') : '', c.pagesUpdated ? plural(c.pagesUpdated, 'changed page') : '', c.pagesRemoved ? plural(c.pagesRemoved, 'removed page') : ''].filter(Boolean).join(', ');
  const total = c.added + c.changed + c.removed;
  const facts = total ? `${plural(total, 'fact')}: ${[c.added ? `${c.added} added` : '', c.changed ? `${c.changed} changed` : '', c.removed ? `${c.removed} removed` : ''].filter(Boolean).join(', ')}` : '';
  return `${[pages || 'No pages change', facts].filter(Boolean).join(' · ')} · ${when}`;
}

function railHtml(p, changes, open, done, files) {
  const live = changes.filter((c) => c.pageStatus !== 'rejected');
  const accepted = live.filter((c) => c.pageStatus === 'accepted').length;
  const item = (c) => {
    const st = stateOf(c);
    return html`<li><a class="al-rail__link" href="#page-${c.slug}" data-rail="page-${c.slug}">
      <span class="al-rail__state al-rail__state--${st.cls}">${st.icon}<span class="al-visually-hidden">${st.words}: </span></span>
      <span class="al-rail__name">${c.title}</span>
      <span class="al-rail__meta"><span class="al-rail__kind">${MARKER_WORDS[c.action] || c.action}</span><span class="al-tier al-tier--${c.tier}">${TIER_NAME[c.tier] || c.tier}</span>${deltaHtml(c)}</span>
    </a></li>`;
  };
  return html`<nav class="al-rail" aria-label="Contents of this proposal">
    ${open.length ? html`<h2>First</h2><ul class="al-rail__list" role="list"><li><a class="al-rail__link al-rail__link--ask" href="#questions" data-rail="questions"><span class="al-rail__state">${ICON_ASK}</span><span class="al-rail__name">${plural(open.length, 'question')} to answer first</span></a></li></ul>` : ''}
    ${changes.length ? html`<h2>Pages</h2>
      <p class="al-rail__progress"><progress class="al-progress" max="${live.length}" value="${accepted}">${accepted} of ${live.length}</progress><span>${accepted} of ${plural(live.length, 'page')} accepted</span></p>
      <ul class="al-rail__list" role="list">${orderedChanges(changes).map(item)}</ul>` : ''}
    ${done.length ? html`<ul class="al-rail__list" role="list"><li><a class="al-rail__link" href="#answered" data-rail="answered"><span class="al-rail__name">Answered questions (${done.length})</span></a></li></ul>` : ''}
    ${files.length ? html`<details class="al-rail__group"><summary>Other files (${files.length})</summary>
      <ul class="al-rail__list" role="list">${files.map((f, i) => html`<li><a class="al-rail__link" href="#file-${i}" data-rail="file-${i}"><span class="al-rail__name al-mono">${f.path.split('/').pop()}</span><span class="al-rail__meta"><span class="al-rail__kind">${FILE_STATUS[f.status] || f.status}</span></span></a></li>`)}</ul></details>` : ''}
  </nav>`;
}

/**
 * One compact strip under the header: the result of the automatic checks and
 * what is still needed, on a line or two. A failed or missing check is a red
 * alert, never a quiet line. Outcomes that are not about review (added, merged
 * elsewhere, turned down) keep their own panel.
 */
function statusStrip(evaluation, p, audit, findings, live) {
  if (!live) return html`<p class="al-text-secondary"><strong>${STATUS_HEADLINE[p.status] || p.status}.</strong> ${audit.text}</p>${needsBox(evaluation, p)}`;
  const items = [...(evaluation.blockers || []), ...(evaluation.missing || [])];
  const notes = findings.length ? html`<details class="al-details al-strip__notes"><summary>${audit.ok ? 'See the notes' : 'What the checks found'}</summary><ul>${findings.slice(0, 50).map((f) => html`<li>${f.slug ? html`<strong>${f.slug}</strong>: ` : ''}${f.message}${f.count > 1 ? ` (×${f.count})` : ''}</li>`)}</ul></details>` : '';
  return html`<div class="al-strip${audit.ok ? '' : ' al-strip--fail'}" id="needs"${audit.ok ? '' : raw(' role="alert"')}>
    <p class="al-strip__line"><strong>${STATUS_HEADLINE[p.status] || p.status}.</strong> <span class="${audit.ok ? '' : 'al-strip__fail'}">${audit.text}</span></p>
    ${evaluation.ready
      ? html`<p class="al-strip__line"><strong>Ready.</strong> ${evaluation.explanation}</p>`
      : html`<div class="al-strip__line"><strong>Before this can be added:</strong> <ul class="al-strip__list">${items.map((x) => html`<li>${x.message}</li>`)}</ul></div>`}
    ${notes}
  </div>`;
}

const KEYS_HELP = [['j', 'Next fact'], ['k', 'Previous fact'], ['n', 'Next page'], ['p', 'Previous page'], ['v', 'Switch between compare and whole page'], ['?', 'Show or hide this list']];

export function proposalPage({ proposal: p, decisions, evaluation, actor, csrf, nonce, canAct, flash = null, now = Date.now(), why = {}, chat = null, navCounts = {}, tiers = null, view = 'compare', diffMode = 'unified', pageTexts = null }) {
  view = pickView(view);
  diffMode = pickDiff(diffMode);
  const info = describe(p, decisions);
  const name = proposalName(p, info);
  const open = decisions.filter((d) => d.status === 'open');
  const done = decisions.filter((d) => d.status !== 'open');
  const audit = auditWords(p.audit);
  const live = ['open', 'approved', 'conflicted', 'changes_requested'].includes(p.status);
  const mine = (p.approvals || []).filter((a) => a.actorId === actor.id && a.headSha === p.headSha && a.scope === 'all').length > 0;
  const stale = (p.approvals || []).some((a) => a.actorId === actor.id && a.headSha !== p.headSha);
  // Approvals for an earlier version: shown by name, so everyone sees whose no longer count.
  const lapsed = [...new Set((p.approvals || []).filter((a) => a.headSha !== p.headSha && !(p.approvals || []).some((b) => b.actorId === a.actorId && b.headSha === p.headSha)).map((a) => a.display || a.actorId))];
  const findings = dedupeFindings(p.audit?.findings || []);
  const approveBlocked = open.length ? 'Answer the questions above first — answering them changes the proposal.' : '';
  const id = encodeURIComponent(p.id);
  const keep = keepFields(view, diffMode);
  const changes = p.changes || [];
  const files = p.otherFiles || [];
  const rv = { p, canAct: live ? canAct : { ok: false }, csrf, required: p.required, tiers: live && canAct.canReview ? tiers : null, keep, view, diffMode, texts: pageTexts, titles: sourceTitles(p) };
  const items = [...evaluation.blockers || [], ...evaluation.missing || []];
  const needsShort = !live ? '' : open.length ? `${plural(open.length, 'question')} to answer first`
    : mine ? 'You approved this version' : evaluation.ready ? 'Ready to add' : `${plural(items.length || 1, 'thing')} still needed`;

  const header = html`<header class="al-reviewhead">
    <div class="al-reviewhead__main" title="${name.title}">
      <a class="al-link-arrow al-link-arrow--back al-reviewhead__back" href="/inbox">All proposals</a>
      <h1>${name.title}</h1>
      <p class="al-reviewhead__meta">${summaryLine(p, info, now)}</p>
      ${name.ref ? html`<p class="al-reviewhead__ref al-mono" title="${name.ref}">${name.ref}</p>` : ''}
    </div>
    <div class="al-reviewhead__side">
      <div class="al-reviewhead__actions">
      ${statusChip(p)}
      ${needsShort ? html`<a class="al-reviewhead__needs" href="#needs">${needsShort}</a>` : ''}
      ${live && canAct.canReview ? html`<details class="al-menu al-menu--end"><summary class="al-btn al-btn--quiet">More</summary>
        <div class="al-menu__panel al-stack al-stack--sm"><a href="#request-changes">Ask for changes</a><a href="#turn-down">Turn down</a></div></details>` : ''}
      ${live && canAct.ok && p.status === 'approved' ? html`<form method="post" action="/inbox/p/${id}/retry">${csrfField(csrf)}${keep}<button class="al-btn" type="submit">Try again</button></form>` : ''}
      ${live && canAct.ok && !mine ? html`<form method="post" action="/inbox/p/${id}/approve">${csrfField(csrf)}${headField(p)}${keep}${chat?.action === 'approve' ? html`<input type="hidden" name="confirm" value="${chat.code}">` : ''}<input type="hidden" name="scope" value="all"><button class="al-btn al-btn--primary" type="submit"${approveBlocked ? raw(' disabled') : ''}>Approve all</button></form>` : ''}
      </div>
      ${live ? html`<p class="al-reviewhead__decide" id="decide">${canAct.ok ? (approveBlocked || (mine ? 'You approved this version.' : evaluation.ready ? 'Ready to add.' : 'Approving adds it once everything above is in place.')) : canAct.why}</p>` : ''}
    </div>
  </header>`;

  const body = html`
    <div class="al-review">
    ${header}
    <div class="al-twopane al-twopane--left al-review__grid">
    <aside class="al-twopane__side">${railHtml(p, changes, open, done, files)}</aside>
    <div class="al-twopane__main al-review__main al-flow">
    ${flashBox(flash)}
    ${p.kind === 'learnings' ? html`<p class="al-text-secondary">${LEARNINGS_EXPLANATION}</p>` : ''}
    ${statusStrip(evaluation, p, audit, findings, live)}
    ${info.lookup ? html`<p class="al-text-secondary">${info.lookup}${p.lookupQuestion ? html` The question was “${p.lookupQuestion}”.` : ''}</p>` : ''}
    ${p.mergeError ? html`<div class="al-callout al-callout--danger" role="alert">${p.mergeError.message}${p.mergeError.slug ? html` <a href="/inbox/pages/${encodeURIComponent(p.mergeError.slug)}">Open the page</a>` : ''}</div>` : ''}
    ${chat ? html`<div class="al-callout al-callout--success" role="status">A chat assistant asked${chat.onBehalfOf ? ` on behalf of ${chat.onBehalfOf.display}` : ''} for this to be ${chat.action === 'reject' ? 'turned down' : 'approved'}. It can't do that itself — read it below and decide.${chat.headSha && chat.headSha !== p.headSha ? ' The proposal changed after the chat asked; this is the current version.' : ''}</div>` : ''}
    ${lapsed.length && live && p.status !== 'conflicted' ? html`<div class="al-callout al-callout--success" role="status">${p.revisedBecause === 'conflict'
      ? 'The knowledge base changed while this waited, so it was redone on top of the current version.'
      : 'This proposal changed since it was approved.'} ${lapsed.length === 1 ? `${lapsed[0]}'s approval was for the earlier version and no longer counts` : `Approvals from ${lapsed.join(', ')} were for the earlier version and no longer count`}${stale ? ' — please look again.' : '.'}</div>` : ''}
    ${p.notes ? html`<details class="al-details" open><summary>The agent's notes</summary><p>${p.notes}</p></details>` : ''}

    ${open.length ? html`<section id="questions" class="al-flow"><h2>${plural(open.length, 'question')} for you</h2>${open.map((d) => decisionCard(p, d, { canAct, csrf, keep }))}</section>` : ''}

    <h2 id="pages">What would change</h2>
    ${changes.length === 0 ? html`<p class="al-text-secondary">No pages change — only the knowledge base's own records.</p>` : ''}
    ${orderedChanges(changes).map((c) => pageSection(c, { ...rv, why: why[c.slug] }))}
    ${otherFilesSection(files)}

    ${done.length ? html`<section id="answered" class="al-flow"><h2>Answered questions</h2>${done.map((d) => decisionCard(p, d, { canAct, csrf, keep }))}</section>` : ''}

    ${live && canAct.canReview ? html`<section class="al-section al-stack" id="request-changes">
      <h2>Something not right?</h2>
      <form class="al-field" method="post" action="/inbox/p/${id}/request-changes">
        ${csrfField(csrf)}${keep}
        <label for="feedback" class="al-label">Tell the agent what to change. It will revise and send it back.</label>
        <textarea class="al-textarea" id="feedback" name="feedback" required maxlength="5000"></textarea>
        <p class="al-cluster"><button class="al-btn" type="submit">Ask for changes</button></p>
      </form>
      <form class="al-field" id="turn-down" method="post" action="/inbox/p/${id}/reject" data-confirm="Turn this down? Nothing from it will be added.">
        ${csrfField(csrf)}${keep}${chat?.action === 'reject' ? html`<input type="hidden" name="confirm" value="${chat.code}">` : ''}
        <label for="reason" class="al-label">Or turn the whole thing down (optional reason)</label>
        <input class="al-input" type="text" id="reason" name="reason" maxlength="2000">
        <p class="al-cluster"><button class="al-btn al-btn--danger" type="submit">Turn down</button></p>
      </form>
    </section>` : ''}

    <details class="al-details"><summary>Technical details</summary><dl class="al-dl al-dl--mono">
      <dt>Proposal</dt><dd>${p.id}</dd>
      <dt>Source</dt><dd>${sourceName(p.source)}${p.source?.id ? ` (${p.source.id})` : ''}</dd>
      <dt>Branch</dt><dd>${p.branch}</dd>
      <dt>Reviewed version</dt><dd>${String(p.headSha || '').slice(0, 12)}</dd>
      <dt>Based on</dt><dd>${String(p.baseSha || '').slice(0, 12)}</dd>
      ${p.merge?.sha ? html`<dt>Merged as</dt><dd>${p.merge.sha.slice(0, 12)}</dd>` : ''}
      <dt>Approvals</dt><dd>${(p.approvals || []).length ? p.approvals.map((a) => `${a.display} (${a.scope === 'all' ? 'everything' : a.scope}, ${a.channel}${a.headSha === p.headSha ? '' : ', earlier version'})`).join('; ') : 'none yet'}</dd>
    </dl></details>
    </div>
    </div>
    </div>
    <dialog class="al-dialog" id="keys" aria-labelledby="keys-title">
      <h2 id="keys-title">Keyboard shortcuts</h2>
      <dl class="al-dl">${KEYS_HELP.map(([k, w]) => html`<dt><kbd class="al-kbd">${k}</kbd></dt><dd>${w}</dd>`)}</dl>
      <p class="al-text-tertiary">None of these accept, take out, approve or turn down anything. Those are always a click.</p>
      <form method="dialog"><button class="al-btn" type="submit">Close</button></form>
    </dialog>`;

  return layout({ title: name.title, actor, nonce, csrf, current: 'inbox', body, navCounts, width: 'wide' });
}

// ── side pages ───────────────────────────────────────────────────────────────

export function reverifyPage({ items, error, actor, csrf, nonce, navCounts = {} }) {
  const body = html`<h1>Pages to re-check</h1>
    <p class="al-lede">Pages people read often, whose facts haven't been checked against their sources for a while.</p>
    ${error ? html`<div class="al-empty">${error}</div>` : items.length === 0 ? html`<div class="al-empty">Nothing is due for a re-check.</div>` : html`
    <div class="al-table-wrap"><table class="al-table"><thead><tr><th>Page</th><th>Last checked</th><th>Overdue</th></tr></thead><tbody>
    ${items.map((i) => html`<tr><td><strong>${i.title || i.slug}</strong><div class="al-text-tertiary">${i.slug}</div>${i.reason ? html`<div class="al-source">${i.reason}</div>` : ''}</td><td>${i.lastVerified || 'never'}</td><td>${i.overdueDays != null ? plural(i.overdueDays, 'day') : ''}</td></tr>`)}
    </tbody></table></div>`}`;
  return layout({ title: 'Re-check', actor, nonce, csrf, current: 'reverify', body, navCounts });
}

/** What live lookup did for a gap, for a reviewer. */
function lookupWords(l) {
  const from = l.lastStep === 'connectors' && l.connectors?.length ? `from ${l.connectors.join(', ')}`
    : l.lastStep === 'staged' ? 'from documents waiting for review' : l.lastStep === 'sources' ? 'from sources already added' : 'from outside the knowledge base';
  return `Answered ${plural(l.served, 'time')} by looking it up live ${from}. ${l.jobs?.length ? 'The document has been sent for review.' : 'Nothing has been sent for review.'}`;
}

export function gapsPage({ items, error, actor, csrf, nonce, now = Date.now(), navCounts = {} }) {
  const open = items.filter((g) => !g.coveredBy?.length);
  const covered = items.filter((g) => g.coveredBy?.length);
  const row = (g, { answered = false } = {}) => html`<tr><td><strong>${g.representative || (g.tokens || []).join(' ') || 'An unanswered question'}</strong>${(g.queries || []).length ? html`<div class="al-text-tertiary">${g.queries.slice(0, 3).map((q) => (typeof q === 'string' ? `“${q}”` : `“${q.text}”${q.count > 1 ? ` ×${q.count}` : ''}`)).join(' · ')}</div>` : ''}${answered ? html`<div class="al-source">The wiki can probably answer this now: <a href="/inbox/pages/${encodeURIComponent(g.coveredBy[0].slug)}">${g.coveredBy[0].title}</a></div>` : html`${g.lookup?.served && !/\bServed \d+ times?\b/.test(typeof g.suggestion === 'string' ? g.suggestion : '') ? html`<div class="al-source">${lookupWords(g.lookup)}</div>` : ''}${g.suggestion ? html`<div class="al-source">Suggestion: ${typeof g.suggestion === 'string' ? g.suggestion : g.suggestion.text || g.suggestion.label || ''}</div>` : ''}`}</td><td>${plural(g.count || 0, 'time')}${g.distinctSessions ? html`<div class="al-text-tertiary">by ${plural(g.distinctSessions, 'person', 'people')}</div>` : ''}</td><td>${timeAgo(g.lastSeen, now)}</td></tr>`;
  const body = html`<h1>Questions the knowledge base couldn't answer</h1>
    <p class="al-lede">What people asked for and didn't find. Each one is a hint about which source to add next.</p>
    ${error ? html`<div class="al-empty">${error}</div>` : items.length === 0 ? html`<div class="al-empty">No unanswered questions recorded.</div>` : html`
    ${open.length ? html`<div class="al-table-wrap"><table class="al-table"><thead><tr><th>Topic</th><th>Asked</th><th>Last asked</th></tr></thead><tbody>
    ${open.map((g) => row(g))}
    </tbody></table></div>` : ''}
    ${covered.length ? html`<h3>Probably answered since</h3>
    <div class="al-table-wrap"><table class="al-table"><thead><tr><th>Topic</th><th>Asked</th><th>Last asked</th></tr></thead><tbody>
    ${covered.map((g) => row(g, { answered: true }))}
    </tbody></table></div>` : ''}`}`;
  return layout({ title: 'Unanswered', actor, nonce, csrf, current: 'gaps', body, navCounts });
}

const ACTIVITY_WORDS = {
  'proposal.create': 'new proposal arrived',
  'proposal.update': 'proposal was revised',
  'proposal.approve': 'approved',
  'proposal.reject': 'turned down',
  'proposal.merge': 'added to the knowledge base',
  'proposal.merge_failed': "couldn't be added yet",
  'proposal.request_changes': 'asked for changes',
  'proposal.retry': 'tried adding again',
  'proposal.supersede': 'replaced by a newer version',
  'page.reject': 'took a page out',
  'decision.resolve': 'answered a question',
  'confirmation.create': 'asked from a chat for confirmation',
  'policy.violation': 'POLICY NOT MET',
  'page.tier': 'changed the tier of a page in',
  'page.tier_refused': 'tried to change the tier of a page, but the checks failed, in',
  'page.tier_propose': 'proposed a tier change',
  'hint.dismiss': 'dismissed a canonical suggestion',
};

export function activityPage({ entries, titles, actor, csrf, nonce, now = Date.now(), navCounts = {} }) {
  const body = html`<h1>Activity</h1>
    <p class="al-lede">Every review action, newest first. This record can't be edited.</p>
    ${entries.length === 0 ? html`<div class="al-empty">Nothing has happened yet.</div>` : html`
    <div class="al-table-wrap"><table class="al-table"><tbody>${entries.map((e) => html`<tr>
      <td><strong>${e.detail?.actor || e.actorId}</strong> ${ACTIVITY_WORDS[e.action] || e.action}${e.detail?.scope && e.detail.scope !== 'all' ? html` (page ${e.detail.scope})` : ''}
        ${titles.get(e.target) ? html` — <a href="/inbox/p/${encodeURIComponent(e.target)}">${titles.get(e.target)}</a>` : ''}
        ${e.action === 'proposal.merge' && e.detail?.combined?.length ? html`<div class="al-source">Combined with what was already there: ${e.detail.combined.join(', ')}.</div>` : ''}
        ${e.action === 'policy.violation' ? html`<div class="al-source al-source--missing">${e.detail?.reason || ''}</div>` : ''}</td>
      <td class="al-text-tertiary">${e.channel}</td><td class="al-text-tertiary">${timeAgo(e.ts, now)}</td></tr>`)}</tbody></table></div>`}`;
  return layout({ title: 'Activity', actor, nonce, csrf, current: 'activity', body, navCounts });
}

// ── pages worth fixing as canonical, and a page's tier on main ───────────────

const countsLine = (h) => hintWords(h).map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(', ');

export function canonicalPage({ items, enabled = true, error = '', actor, csrf, nonce, canReview = false, canCanonical = false, canonicalRole = 'owner', flash = null, navCounts = {} }) {
  const body = html`${flashBox(flash)}<h1>Pages worth fixing as canonical</h1>
    <p class="al-lede">Pages that many documents contribute to or that many other pages link to. A canonical page is a locked definition: the agent cannot change it, and anything that contradicts it is logged for you to review.</p>
    ${!enabled ? html`<div class="al-empty">Suggestions are turned off.</div>`
      : error ? html`<div class="al-empty">${error}</div>`
        : items.length === 0 ? html`<div class="al-empty">No page stands out right now.</div>`
          : html`<ul class="al-stack al-stack--sm" role="list">${items.map((h) => html`<li class="al-card al-stack al-stack--sm">
            <div class="al-card__title"><a href="/inbox/pages/${encodeURIComponent(h.slug)}">${h.title}</a></div>
            <ul class="al-text-secondary">${hintWords(h).map((w) => html`<li>${w.charAt(0).toUpperCase() + w.slice(1)}</li>`)}</ul>
            ${canReview ? html`<div class="al-cluster">
              ${canCanonical
                ? canonicalOnly({ slug: h.slug, title: h.title, csrf })
                : html`<span class="al-text-tertiary">Only someone with the ${canonicalRole} role can make a page canonical.</span>`}
              ${canCanonical ? html`<form method="post" action="/inbox/canonical/${encodeURIComponent(h.slug)}/dismiss">${csrfField(csrf)}<button class="al-btn al-btn--sm" type="submit">Dismiss</button></form>` : ''}
            </div>` : ''}
          </li>`)}</ul>`}
    <p class="al-text-tertiary"><a href="/inbox/pages">See every page and its tier</a></p>`;
  return layout({ title: 'Canonical suggestions', actor, nonce, csrf, current: 'canonical', body, navCounts });
}

/** Only the canonical choice, with its meaning and confirm step. */
function canonicalOnly({ slug, title, csrf }) {
  return html`<details class="al-details"><summary>Make canonical</summary>
    <div class="al-card">${canonicalMeaning(title)}
      <form method="post" action="/inbox/pages/${encodeURIComponent(slug)}/tier">${csrfField(csrf)}<input type="hidden" name="to" value="canonical"><input type="hidden" name="confirm" value="yes">
        <button class="al-btn al-btn--primary" type="submit">Yes, make it canonical</button></form>
    </div></details>`;
}

export function pagesPage({ pages, q = '', actor, csrf, nonce, navCounts = {}, truncated = false }) {
  const body = html`<h1>Pages</h1>
    <p class="al-lede">Every page on the knowledge base and its tier. Open one to change its tier.</p>
    <form class="al-search" method="get" action="/inbox/pages" role="search"><input class="al-input" type="search" name="q" value="${q}" placeholder="Search by name" aria-label="Search"></form>
    ${pages.length === 0 ? html`<div class="al-empty">No page matches.</div>` : html`<div class="al-table-wrap"><table class="al-table"><thead><tr><th>Page</th><th>Tier</th></tr></thead><tbody>
      ${pages.map((pg) => html`<tr><td><a href="/inbox/pages/${encodeURIComponent(pg.slug)}">${pg.title}</a><div class="al-text-tertiary">${pg.slug}</div></td><td>${TIER_NAME[pg.tier] || pg.tier}</td></tr>`)}
    </tbody></table></div>${truncated ? html`<p class="al-text-tertiary">Showing the first ${pages.length}. Search to narrow the list.</p>` : ''}`}`;
  return layout({ title: 'Pages', actor, nonce, csrf, current: 'canonical', body, navCounts });
}

export function pageEntryPage({ page, configLocked = false, waiting = null, hint = null, canReview, canCanonical, canonicalRole, actor, csrf, nonce, flash = null, navCounts = {} }) {
  const tier = page.tier;
  const body = html`${flashBox(flash)}<a class="al-text-tertiary" href="/inbox/pages">← All pages</a>
    <h1>${page.title}</h1>
    <p class="al-lede">Tier: <strong>${TIER_NAME[tier] || tier}</strong>${tier === 'canonical' ? '. The agent cannot change this page, and anything that contradicts it is logged as a challenge.' : '.'}</p>
    ${hint ? html`<p class="al-text-secondary">${countsLine(hint)}.</p>` : ''}
    ${waiting ? html`<div class="al-callout al-callout--success" role="status">A tier change for this page is already waiting: <a href="/inbox/p/${encodeURIComponent(waiting.id)}">${waiting.title}</a></div>` : ''}
    ${configLocked ? html`<p class="al-text-secondary">This page is locked in brain.config.yaml. Only a person editing that file by hand can unlock it.</p>` : ''}
    ${!canReview ? html`<p class="al-text-secondary">You can read this page's tier. Changing it needs a reviewer.</p>`
      : waiting || configLocked ? ''
        : html`<h2>Change the tier</h2><p class="al-text-secondary">The change is a small proposal that goes through the usual checks and approval, and it is logged.</p>
          <div class="al-cluster">${tierChoices({ action: `/inbox/pages/${encodeURIComponent(page.slug)}/tier`, current: tier, title: page.title, csrf, canCanonical, canonicalRole })}</div>`}`;
  return layout({ title: page.title, actor, nonce, csrf, current: 'canonical', body, navCounts });
}

export function messagePage({ title, text, actor = null, csrf = '', nonce, link = null }) {
  const body = html`<div class="al-narrow al-card"><h1>${title}</h1><p>${text}</p>${link ? html`<p><a class="al-btn" href="${safeUrl(link.href)}">${link.label}</a></p>` : ''}</div>`;
  return layout({ title, actor, nonce, csrf, body });
}

export function continueAsPage({ display, code, csrf, nonce }) {
  const body = html`<div class="al-narrow al-card">
    <h1>Continue as ${display}?</h1>
    <p class="al-lede">This link was sent to you by email. It works once.</p>
    <form method="post" action="/inbox/l/${encodeURIComponent(code)}">${csrfField(csrf)}<button class="al-btn al-btn--primary" type="submit">Continue</button></form>
  </div>`;
  return layout({ title: 'Continue', nonce, csrf, body });
}
