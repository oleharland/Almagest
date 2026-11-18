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
import { ACTION_WORDS, auditWords, DECISION_WORDS, describe, LEARNINGS_EXPLANATION, OP_WORDS, sourceName, STATUS_HEADLINE, TIER_WORDS } from '../summary.mjs';
import { layout, timeAgo } from './layout.mjs';

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
  return html`<div class="flash ${flash.error ? 'flash--err' : 'flash--ok'}" role="${flash.error ? 'alert' : 'status'}">${flash.text}</div>`;
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
      return html`<p class="faint">${t === 'canonical' ? `Only someone with the ${canonicalRole} role can make a page canonical.` : `Only someone with the ${canonicalRole} role can change a canonical page.`}</p>`;
    }
    if (t === 'canonical') {
      return html`<details class="confirm"><summary>${TIER_CHOICE[t]}</summary>
        <div class="card">${canonicalMeaning(title)}
          <form method="post" action="${action}">${csrfField(csrf)}${hidden}<input type="hidden" name="to" value="${t}"><input type="hidden" name="confirm" value="yes">
            <button class="btn btn--primary" type="submit">Yes, make it canonical</button></form>
        </div></details>`;
    }
    return html`<form method="post" action="${action}">${csrfField(csrf)}${hidden}<input type="hidden" name="to" value="${t}"><button class="btn btn--small" type="submit">${TIER_CHOICE[t]}</button></form>`;
  })}`;
}

// ── queue ────────────────────────────────────────────────────────────────────

function statusChip(p) {
  const cls = { merged: 'chip--ok', merged_unaccepted: 'chip--bad', rejected: 'chip--bad', conflicted: 'chip--warn', superseded: '', changes_requested: '', approved: 'chip--ok' }[p.status] ?? '';
  return html`<span class="chip ${cls}">${STATUS_HEADLINE[p.status] || p.status}</span>`;
}

export function queuePage({ items, filters, actor, csrf, nonce, now = Date.now(), flash = null, navCounts = {} }) {
  const tab = (key, label) => html`<a href="/inbox?show=${key}" aria-current="${filters.show === key ? 'true' : 'false'}">${label}</a>`;
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
    <p class="lede">${lede}</p>
    <div class="tabs">
      ${tab('active', 'To review')}${tab('done', 'Done')}${tab('all', 'All')}
      <form class="search" method="get" action="/inbox" role="search">
        <input type="hidden" name="show" value="${filters.show}">
        <input type="search" name="q" value="${filters.q}" placeholder="Search by source or page" aria-label="Search">
      </form>
    </div>
    <div class="tabs">
      <a href="${safeUrl(`/inbox?show=${encodeURIComponent(filters.show)}${filters.questions ? '' : '&questions=1'}`)}" aria-current="${filters.questions ? 'true' : 'false'}">With questions</a>
      <a href="${safeUrl(`/inbox?show=${encodeURIComponent(filters.show)}${filters.hot ? '' : '&hot=1'}`)}" aria-current="${filters.hot ? 'true' : 'false'}">Frequently read pages</a>
    </div>
    ${items.length === 0
      ? html`<div class="empty">${filters.show === 'done' ? 'Nothing here yet.' : 'Nothing to review. New material shows up here when the agent finishes reading a source.'}</div>`
      : html`<ul class="queue">${items.map(({ proposal: p, info }) => html`
        <li><a class="item" href="/inbox/p/${encodeURIComponent(p.id)}">
          <div class="title">${info.title}</div>
          <div class="line">${info.line}</div>
          <div class="chips">
            ${info.openDecisions ? html`<span class="chip chip--warn">${plural(info.openDecisions, 'question')} for you</span>` : ''}
            ${info.hot ? html`<span class="chip chip--hot">${info.hot === 1 ? 'Frequently read page' : `${info.hot} frequently read pages`}</span>` : ''}
            ${statusChip(p)}
            <span class="faint">${timeAgo(p.createdAt, now)}</span>
          </div>
        </a></li>`)}</ul>`}`;
  return layout({ title: 'Review inbox', actor, nonce, csrf, current: 'inbox', body, navCounts });
}

// ── one proposal ─────────────────────────────────────────────────────────────

function citationLine(claim) {
  const c = claim.citation;
  if (!c || !c.id) return html`<div class="cite missing">No source given for this.</div>`;
  if (c.id === 'unknown') return html`<div class="cite missing">The source for this is not known yet — it is listed as an open question.</div>`;
  return html`<div class="cite">Source: <strong>${c.title || c.id}</strong>, ${locatorWords(c.locator)}${c.date ? html` · ${c.date}` : ''}</div>`;
}

function excerptBlock(claim) {
  switch (claim.excerptStatus) {
    case 'found':
      return html`<blockquote class="excerpt" aria-label="What the source says">${claim.excerpt}</blockquote>`;
    case 'not-found':
      return html`<div class="cite missing">We couldn't find that spot in the source. Check it by hand before you approve.</div>`;
    case 'source-missing':
      return html`<div class="cite missing">The source file isn't available here, so the passage can't be shown.</div>`;
    case 'unknown-source':
      return html`<div class="cite missing">This cites a source the page doesn't list. That's worth a closer look.</div>`;
    default:
      return '';
  }
}

function claimCard(claim) {
  return html`<div class="claim claim--${claim.op}">
    <div class="op">${OP_WORDS[claim.op] || claim.op}</div>
    ${claim.op === 'change' && claim.before && claim.before !== claim.text ? html`<div class="was">Was: <del>${claim.before}</del></div>` : ''}
    <p class="text">${claim.text}</p>
    ${claim.op === 'change' && claim.before === claim.text ? html`<div class="was">Same wording — the source it points to changed.</div>` : ''}
    ${citationLine(claim)}
    ${excerptBlock(claim)}
  </div>`;
}

function hotWhy(e) {
  if (!e) return '';
  const bits = [];
  if (e.rank) bits.push(`#${e.rank} by recent reads`);
  if (e.distinctSessions) bits.push(`${plural(e.distinctSessions, 'person', 'people')} recently`);
  if (typeof e.score === 'number') bits.push(`demand score ${e.score.toFixed(1)}`);
  return bits.length ? html`<p class="faint">Why it counts as frequently read: ${bits.join(', ')}. Changes to it need a closer look.</p>` : '';
}

/** One sentence for a page written as an addition to a page that waits in another proposal. */
function extendsNote(e) {
  return html`<p class="faint">This page adds to one that is waiting in another proposal, ${e.proposalId ? html`<a href="/inbox/p/${encodeURIComponent(e.proposalId)}">${e.title || 'that proposal'}</a>` : 'that proposal'}. When both are approved, the service combines the two versions section by section. If they disagree anywhere, the agent is asked to redo this page on top of what is already there.</p>`;
}

/** A learning: the conclusion in the agent's words, and the pages it rests on as links. */
function learningBody(change) {
  const basis = change.basis || [];
  return html`<p class="faint">What it rests on</p>
    ${basis.length
      ? html`<ul class="basis">${basis.map((b) => html`<li><a href="/inbox/pages/${encodeURIComponent(b.slug)}">${b.title || b.slug}</a></li>`)}</ul>`
      : html`<p class="missing">This page names no pages it rests on. Do not accept it as it is.</p>`}
    ${change.preview ? html`<p class="faint">The conclusion</p><pre class="preview">${change.preview}</pre>` : ''}`;
}

function pageCard(p, change, { canAct, csrf, required, why = null, tiers = null }) {
  const req = required?.pages?.[change.slug];
  const rejected = change.pageStatus === 'rejected';
  const action = change.action === 'rename' && change.from ? `Renamed from “${change.from}”` : ACTION_WORDS[change.action] || change.action;
  const accepted = change.pageStatus === 'accepted';
  return html`<section class="page${rejected ? ' rejected' : ''}" id="page-${change.slug}">
    <div class="head">
      <div class="grow">
        <h3>${change.title}</h3>
        <div class="chips">
          <span class="chip">${action}</span>
          <span class="chip">${TIER_WORDS[change.tier] || change.tier}</span>
          ${change.canonical && !change.promotes ? html`<span class="chip chip--bad">Locked — can't be changed here</span>` : ''}
          ${change.promotes ? html`<span class="chip chip--bad">Made canonical without a person choosing it</span>` : ''}
          ${change.tierSetBy ? html`<span class="chip chip--ok">Made canonical by ${change.tierSetBy.display || change.tierSetBy.by}</span>` : ''}
          ${change.hot ? html`<span class="chip chip--hot">Frequently read</span>` : ''}
          ${change.owner ? html`<span class="chip">Owned by ${change.owner}</span>` : ''}
          ${req?.explicit && !rejected ? html`<span class="chip chip--warn">Needs its own approval</span>` : ''}
          ${accepted ? html`<span class="chip chip--ok">Accepted</span>` : ''}
          ${rejected ? html`<span class="chip chip--bad">Taken out</span>` : ''}
        </div>
      </div>
      ${canAct.canReview && !rejected ? html`<div class="row">
        ${accepted || !canAct.ok ? '' : html`<form method="post" action="/inbox/p/${encodeURIComponent(p.id)}/page/${encodeURIComponent(change.slug)}/accept">${csrfField(csrf)}${headField(p)}<button class="btn btn--small" type="submit">Accept page</button></form>`}
        <form method="post" action="/inbox/p/${encodeURIComponent(p.id)}/page/${encodeURIComponent(change.slug)}/reject" data-confirm="Take this page out of the proposal?">${csrfField(csrf)}<button class="btn btn--small btn--danger" type="submit">Take this page out</button></form>
      </div>` : ''}
    </div>
    <div class="body">
      ${tiers && !rejected && change.action !== 'delete' && p.kind !== 'tier' && !(change.canonical && !change.promotes)
        ? html`<div class="tier"><span class="faint">Tier</span> <strong>${TIER_NAME[change.tier] || change.tier}</strong>
          <details><summary>Change the tier</summary>
            ${tierChoices({
              action: `/inbox/p/${encodeURIComponent(p.id)}/page/${encodeURIComponent(change.slug)}/tier`, current: change.tier, title: change.title,
              csrf, hidden: headField(p), canCanonical: tiers.canCanonical, canonicalRole: tiers.canonicalRole,
            })}
          </details></div>` : ''}
      ${(p.extends || []).filter((e) => e.slug === change.slug).map(extendsNote)}
      ${change.hot ? hotWhy(why) : ''}
      ${p.kind === 'learnings' ? learningBody(change) : ''}
      ${p.kind === 'learnings' ? '' : change.needsManualLook ? html`<p class="missing">This new page has no facts the inbox could pair with a source, so nothing below has been checked for you. Read the whole page before you approve.</p>
        <pre class="preview">${change.preview || ''}</pre>` : ''}
      ${p.kind === 'learnings' || change.needsManualLook ? '' : change.claims.length === 0 && !(change.fields || []).length
        ? html`<p class="muted">${change.action === 'delete' ? 'The whole page would be removed.' : 'No facts changed — only formatting or wording without a source.'}</p>`
        : change.claims.map(claimCard)}
      ${(change.fields || []).length ? html`<details><summary>${plural(change.fields.length, 'detail')} changed</summary>
        <dl class="facts">${change.fields.map((f) => html`<dt>${f.label}</dt><dd>${f.before || '—'} → ${f.after || '—'}</dd>`)}</dl></details>` : ''}
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

function decisionCard(p, d, { canAct, csrf }) {
  const c = d.context || {};
  const titles = sourceTitles(p);
  if (d.status !== 'open') {
    return html`<div class="decision resolved"><h3>${DECISION_WORDS[d.kind] || d.kind}</h3>
      <p class="muted">${d.question}</p>
      <p>Answered by ${d.resolution?.display || d.resolution?.actorId}: <strong>${d.resolution?.label || d.resolution?.optionId}</strong>${d.resolution?.note ? html` — “${d.resolution.note}”` : ''}</p></div>`;
  }
  return html`<div class="decision" id="decision-${d.id}">
    <h3>${DECISION_WORDS[d.kind] || d.kind}</h3>
    <p>${d.question}</p>
    ${c.claimA || c.claimB ? html`<div class="vs">
      ${c.claimA ? html`<div><div class="faint">The knowledge base says</div>${c.claimA}${c.sourceA ? html`<div class="cite">Source: ${sourceWords(c.sourceA, titles)}</div>` : ''}</div>` : ''}
      ${c.claimB ? html`<div><div class="faint">The new material says</div>${c.claimB}${c.sourceB ? html`<div class="cite">Source: ${sourceWords(c.sourceB, titles)}</div>` : ''}</div>` : ''}
    </div>` : ''}
    ${canAct.canReview ? html`<form method="post" action="/inbox/d/${encodeURIComponent(d.id)}/resolve">
      ${csrfField(csrf)}${headField(p)}
      <label class="faint" for="note-${d.id}">Note for the agent (optional)</label>
      <input type="text" id="note-${d.id}" name="note" maxlength="2000">
      <div class="options">${d.options.map((o) => html`<button class="btn" type="submit" name="optionId" value="${o.id}">${o.label}</button>`)}</div>
    </form>` : html`<p class="faint">${canAct.why}</p>`}
  </div>`;
}

function needsBox(evaluation, p) {
  if (p.status === 'merged') {
    return html`<div class="needs ready"><h2>Added to the knowledge base</h2><p>${p.merge?.at ? `On ${p.merge.at.slice(0, 10)}` : ''}${p.merge?.approvers?.length ? `, approved by ${p.approvals.filter((a) => p.merge.approvers.includes(a.actorId)).map((a) => a.display).filter((v, i, a) => a.indexOf(v) === i).join(', ')}` : ''}.</p>${p.merge?.combined?.length ? html`<p>${plural(p.merge.combined.length, 'page')} (${p.merge.combined.join(', ')}) ${p.merge.combined.length === 1 ? 'was' : 'were'} combined with what was already there, section by section.</p>` : ''}</div>`;
  }
  if (p.status === 'merged_unaccepted') {
    return html`<div class="needs"><h2>Merged on GitHub, not accepted here</h2><p>${p.merge?.by ? `Merged by ${p.merge.by}` : 'Merged'}${p.merge?.at ? ` on ${p.merge.at.slice(0, 10)}` : ''}, but the knowledge base was not updated: ${p.merge?.message || p.mergeError?.message || 'it could not be verified.'}</p><p>An administrator has to reconcile it by hand. This is recorded as a policy violation.</p></div>`;
  }
  if (p.status === 'rejected') {
    return html`<div class="needs"><h2>Turned down</h2><p>${p.rejection?.display ? `By ${p.rejection.display}` : ''}${p.rejection?.reason ? html`: “${p.rejection.reason}”` : '.'}</p></div>`;
  }
  if (evaluation.ready) return html`<div class="needs ready"><h2>Ready</h2><p>${evaluation.explanation}</p></div>`;
  const items = [...evaluation.blockers, ...evaluation.missing];
  return html`<div class="needs"><h2>Before this can be added</h2><ul>${items.map((x) => html`<li>${x.message}</li>`)}</ul></div>`;
}

const FILE_STATUS = { A: 'New file', M: 'Changed', D: 'Removed', R: 'Renamed' };

function size(bytes) {
  return bytes < 1024 ? plural(bytes, 'byte') : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

/**
 * Every file the proposal changes outside the wiki, with what it says — the
 * bookkeeping, and anything under raw/. Approving the proposal approves these
 * too, so they are shown, not just named.
 */
function otherFilesSection(files) {
  if (!files.length) return '';
  return html`<h2>Other files</h2>
    <p class="muted">Approving also adds these. Read anything you didn't expect.</p>
    ${files.map((f) => html`<section class="page">
      <div class="head"><div class="grow">
        <strong>${f.path}</strong>
        <div class="chips"><span class="chip">${FILE_STATUS[f.status] || f.status}${f.from ? ` from ${f.from}` : ''}</span>${f.bytes != null ? html`<span class="chip">${size(f.bytes)}${f.lines != null ? `, ${plural(f.lines, 'line')}` : ''}</span>` : ''}</div>
      </div></div>
      <div class="body">
        ${f.binary ? html`<p class="missing">A binary file — it can't be shown here.</p>`
          : f.preview != null ? html`<p class="faint">${f.previewOf === 'added' ? 'Lines this adds' : 'Content'}${f.previewTruncated ? ' (the start only)' : ''}:</p><pre class="preview">${f.preview}</pre>`
          : ''}
      </div>
    </section>`)}`;
}

export function proposalPage({ proposal: p, decisions, evaluation, actor, csrf, nonce, canAct, flash = null, now = Date.now(), why = {}, chat = null, navCounts = {}, tiers = null }) {
  const info = describe(p, decisions);
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

  const body = html`
    <a class="faint" href="/inbox">← All proposals</a>
    ${flashBox(flash)}
    <h1>${info.title}</h1>
    <p class="lede">${info.line}. Sent ${timeAgo(p.createdAt, now)}${p.revision > 1 ? ` · revised ${plural(p.revision - 1, 'time')}` : ''}.</p>
    ${p.kind === 'learnings' ? html`<p class="status">${LEARNINGS_EXPLANATION}</p>` : ''}
    <p class="status"><strong>${STATUS_HEADLINE[p.status] || p.status}.</strong> ${audit.text}
      ${findings.length ? html`<details><summary>${audit.ok ? 'See the notes' : 'What the checks found'}</summary><ul>${findings.slice(0, 50).map((f) => html`<li>${f.slug ? html`<strong>${f.slug}</strong>: ` : ''}${f.message}${f.count > 1 ? ` (×${f.count})` : ''}</li>`)}</ul></details>` : ''}
    </p>
    ${info.lookup ? html`<p class="status">${info.lookup}${p.lookupQuestion ? html` The question was “${p.lookupQuestion}”.` : ''}</p>` : ''}
    ${p.mergeError ? html`<div class="flash flash--err" role="alert">${p.mergeError.message}</div>` : ''}
    ${chat ? html`<div class="flash flash--ok" role="status">A chat assistant asked${chat.onBehalfOf ? ` on behalf of ${chat.onBehalfOf.display}` : ''} for this to be ${chat.action === 'reject' ? 'turned down' : 'approved'}. It can't do that itself — read it below and decide.${chat.headSha && chat.headSha !== p.headSha ? ' The proposal changed after the chat asked; this is the current version.' : ''}</div>` : ''}
    ${lapsed.length && live && p.status !== 'conflicted' ? html`<div class="flash flash--ok" role="status">${p.revisedBecause === 'conflict'
      ? 'The knowledge base changed while this waited, so it was redone on top of the current version.'
      : 'This proposal changed since it was approved.'} ${lapsed.length === 1 ? `${lapsed[0]}'s approval was for the earlier version and no longer counts` : `Approvals from ${lapsed.join(', ')} were for the earlier version and no longer count`}${stale ? ' — please look again.' : '.'}</div>` : ''}
    ${needsBox(evaluation, p)}
    ${p.notes ? html`<details><summary>The agent's notes</summary><p>${p.notes}</p></details>` : ''}

    ${open.length ? html`<h2>${plural(open.length, 'question')} for you</h2>${open.map((d) => decisionCard(p, d, { canAct, csrf }))}` : ''}

    <h2>What would change</h2>
    ${(p.changes || []).length === 0 ? html`<p class="muted">No pages change — only the knowledge base's own records.</p>` : ''}
    ${(p.changes || []).map((c) => pageCard(p, c, { canAct: live ? canAct : { ok: false }, csrf, required: p.required, why: why[c.slug], tiers: live && canAct.canReview ? tiers : null }))}
    ${otherFilesSection(p.otherFiles || [])}

    ${done.length ? html`<h2>Answered questions</h2>${done.map((d) => decisionCard(p, d, { canAct, csrf }))}` : ''}

    ${live && canAct.canReview ? html`<section class="actions" id="request-changes">
      <h2>Something not right?</h2>
      <form method="post" action="/inbox/p/${id}/request-changes">
        ${csrfField(csrf)}
        <label for="feedback" class="faint">Tell the agent what to change. It will revise and send it back.</label>
        <textarea id="feedback" name="feedback" required maxlength="5000"></textarea>
        <p class="row"><button class="btn" type="submit">Ask for changes</button></p>
      </form>
      <form method="post" action="/inbox/p/${id}/reject" data-confirm="Turn this down? Nothing from it will be added.">
        ${csrfField(csrf)}${chat?.action === 'reject' ? html`<input type="hidden" name="confirm" value="${chat.code}">` : ''}
        <label for="reason" class="faint">Or turn the whole thing down (optional reason)</label>
        <input type="text" id="reason" name="reason" maxlength="2000">
        <p class="row"><button class="btn btn--danger" type="submit">Turn down</button></p>
      </form>
    </section>` : ''}

    <details><summary>Technical details</summary><dl class="facts">
      <dt>Proposal</dt><dd>${p.id}</dd>
      <dt>Source</dt><dd>${sourceName(p.source)}${p.source?.id ? ` (${p.source.id})` : ''}</dd>
      <dt>Branch</dt><dd>${p.branch}</dd>
      <dt>Reviewed version</dt><dd>${String(p.headSha || '').slice(0, 12)}</dd>
      <dt>Based on</dt><dd>${String(p.baseSha || '').slice(0, 12)}</dd>
      ${p.merge?.sha ? html`<dt>Merged as</dt><dd>${p.merge.sha.slice(0, 12)}</dd>` : ''}
      <dt>Approvals</dt><dd>${(p.approvals || []).length ? p.approvals.map((a) => `${a.display} (${a.scope === 'all' ? 'everything' : a.scope}, ${a.channel}${a.headSha === p.headSha ? '' : ', earlier version'})`).join('; ') : 'none yet'}</dd>
    </dl></details>`;

  const footer = live ? html`<div class="actionbar"><div class="wrap">
    <div class="msg">${canAct.ok ? (approveBlocked || (mine ? 'You approved this version.' : evaluation.ready ? 'Ready to add.' : 'Approving adds it once everything above is in place.')) : canAct.why}</div>
    ${canAct.ok && p.status === 'approved' ? html`<form method="post" action="/inbox/p/${id}/retry">${csrfField(csrf)}<button class="btn" type="submit">Try again</button></form>` : ''}
    ${canAct.ok && !mine ? html`<form method="post" action="/inbox/p/${id}/approve">${csrfField(csrf)}${headField(p)}${chat?.action === 'approve' ? html`<input type="hidden" name="confirm" value="${chat.code}">` : ''}<input type="hidden" name="scope" value="all"><button class="btn btn--primary" type="submit"${approveBlocked ? raw(' disabled') : ''}>Approve all</button></form>` : ''}
  </div></div>` : null;

  return layout({ title: info.title, actor, nonce, csrf, current: 'inbox', body, footer, navCounts });
}

// ── side pages ───────────────────────────────────────────────────────────────

export function reverifyPage({ items, error, actor, csrf, nonce, navCounts = {} }) {
  const body = html`<h1>Pages to re-check</h1>
    <p class="lede">Pages people read often, whose facts haven't been checked against their sources for a while.</p>
    ${error ? html`<div class="empty">${error}</div>` : items.length === 0 ? html`<div class="empty">Nothing is due for a re-check.</div>` : html`
    <table class="list"><thead><tr><th>Page</th><th>Last checked</th><th>Overdue</th></tr></thead><tbody>
    ${items.map((i) => html`<tr><td><strong>${i.title || i.slug}</strong><div class="faint">${i.slug}</div>${i.reason ? html`<div class="cite">${i.reason}</div>` : ''}</td><td>${i.lastVerified || 'never'}</td><td>${i.overdueDays != null ? plural(i.overdueDays, 'day') : ''}</td></tr>`)}
    </tbody></table>`}`;
  return layout({ title: 'Re-check', actor, nonce, csrf, current: 'reverify', body, navCounts });
}

/** What live lookup did for a gap, for a reviewer. */
function lookupWords(l) {
  const from = l.lastStep === 'connectors' && l.connectors?.length ? `from ${l.connectors.join(', ')}`
    : l.lastStep === 'staged' ? 'from documents waiting for review' : l.lastStep === 'sources' ? 'from sources already added' : 'from outside the knowledge base';
  return `Answered ${plural(l.served, 'time')} by looking it up live ${from}. ${l.jobs?.length ? 'The document has been sent for review.' : 'Nothing has been sent for review.'}`;
}

export function gapsPage({ items, error, actor, csrf, nonce, now = Date.now(), navCounts = {} }) {
  const body = html`<h1>Questions the knowledge base couldn't answer</h1>
    <p class="lede">What people asked for and didn't find. Each one is a hint about which source to add next.</p>
    ${error ? html`<div class="empty">${error}</div>` : items.length === 0 ? html`<div class="empty">No unanswered questions recorded.</div>` : html`
    <table class="list"><thead><tr><th>Topic</th><th>Asked</th><th>Last asked</th></tr></thead><tbody>
    ${items.map((g) => html`<tr><td><strong>${g.representative || (g.tokens || []).join(' ') || 'An unanswered question'}</strong>${(g.queries || []).length ? html`<div class="faint">${g.queries.slice(0, 3).map((q) => (typeof q === 'string' ? `“${q}”` : `“${q.text}”${q.count > 1 ? ` ×${q.count}` : ''}`)).join(' · ')}</div>` : ''}${g.lookup?.served && !/\bServed \d+ times?\b/.test(typeof g.suggestion === 'string' ? g.suggestion : '') ? html`<div class="cite">${lookupWords(g.lookup)}</div>` : ''}${g.suggestion ? html`<div class="cite">Suggestion: ${typeof g.suggestion === 'string' ? g.suggestion : g.suggestion.text || g.suggestion.label || ''}</div>` : ''}</td><td>${plural(g.count || 0, 'time')}${g.distinctSessions ? html`<div class="faint">by ${plural(g.distinctSessions, 'person', 'people')}</div>` : ''}</td><td>${timeAgo(g.lastSeen, now)}</td></tr>`)}
    </tbody></table>`}`;
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
    <p class="lede">Every review action, newest first. This record can't be edited.</p>
    ${entries.length === 0 ? html`<div class="empty">Nothing has happened yet.</div>` : html`
    <table class="list"><tbody>${entries.map((e) => html`<tr>
      <td><strong>${e.detail?.actor || e.actorId}</strong> ${ACTIVITY_WORDS[e.action] || e.action}${e.detail?.scope && e.detail.scope !== 'all' ? html` (page ${e.detail.scope})` : ''}
        ${titles.get(e.target) ? html` — <a href="/inbox/p/${encodeURIComponent(e.target)}">${titles.get(e.target)}</a>` : ''}
        ${e.action === 'proposal.merge' && e.detail?.combined?.length ? html`<div class="cite">Combined with what was already there: ${e.detail.combined.join(', ')}.</div>` : ''}
        ${e.action === 'policy.violation' ? html`<div class="cite missing">${e.detail?.reason || ''}</div>` : ''}</td>
      <td class="faint">${e.channel}</td><td class="faint">${timeAgo(e.ts, now)}</td></tr>`)}</tbody></table>`}`;
  return layout({ title: 'Activity', actor, nonce, csrf, current: 'activity', body, navCounts });
}

// ── pages worth fixing as canonical, and a page's tier on main ───────────────

const countsLine = (h) => hintWords(h).map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(', ');

export function canonicalPage({ items, enabled = true, error = '', actor, csrf, nonce, canReview = false, canCanonical = false, canonicalRole = 'owner', flash = null, navCounts = {} }) {
  const body = html`${flashBox(flash)}<h1>Pages worth fixing as canonical</h1>
    <p class="lede">Pages that many documents contribute to or that many other pages link to. A canonical page is a locked definition: the agent cannot change it, and anything that contradicts it is logged for you to review.</p>
    ${!enabled ? html`<div class="empty">Suggestions are turned off.</div>`
      : error ? html`<div class="empty">${error}</div>`
        : items.length === 0 ? html`<div class="empty">No page stands out right now.</div>`
          : html`<ul class="queue">${items.map((h) => html`<li class="card">
            <div class="title"><a href="/inbox/pages/${encodeURIComponent(h.slug)}">${h.title}</a></div>
            <ul class="counts">${hintWords(h).map((w) => html`<li>${w.charAt(0).toUpperCase() + w.slice(1)}</li>`)}</ul>
            ${canReview ? html`<div class="row">
              ${canCanonical
                ? canonicalOnly({ slug: h.slug, title: h.title, csrf })
                : html`<span class="faint">Only someone with the ${canonicalRole} role can make a page canonical.</span>`}
              <form method="post" action="/inbox/canonical/${encodeURIComponent(h.slug)}/dismiss">${csrfField(csrf)}<button class="btn btn--small" type="submit">Dismiss</button></form>
            </div>` : ''}
          </li>`)}</ul>`}
    <p class="faint"><a href="/inbox/pages">See every page and its tier</a></p>`;
  return layout({ title: 'Canonical suggestions', actor, nonce, csrf, current: 'canonical', body, navCounts });
}

/** Only the canonical choice, with its meaning and confirm step. */
function canonicalOnly({ slug, title, csrf }) {
  return html`<details class="confirm"><summary>Make canonical</summary>
    <div class="card">${canonicalMeaning(title)}
      <form method="post" action="/inbox/pages/${encodeURIComponent(slug)}/tier">${csrfField(csrf)}<input type="hidden" name="to" value="canonical"><input type="hidden" name="confirm" value="yes">
        <button class="btn btn--primary" type="submit">Yes, make it canonical</button></form>
    </div></details>`;
}

export function pagesPage({ pages, q = '', actor, csrf, nonce, navCounts = {}, truncated = false }) {
  const body = html`<h1>Pages</h1>
    <p class="lede">Every page on the knowledge base and its tier. Open one to change its tier.</p>
    <form class="search" method="get" action="/inbox/pages" role="search"><input type="search" name="q" value="${q}" placeholder="Search by name" aria-label="Search"></form>
    ${pages.length === 0 ? html`<div class="empty">No page matches.</div>` : html`<table class="list"><thead><tr><th>Page</th><th>Tier</th></tr></thead><tbody>
      ${pages.map((pg) => html`<tr><td><a href="/inbox/pages/${encodeURIComponent(pg.slug)}">${pg.title}</a><div class="faint">${pg.slug}</div></td><td>${TIER_NAME[pg.tier] || pg.tier}</td></tr>`)}
    </tbody></table>${truncated ? html`<p class="faint">Showing the first ${pages.length}. Search to narrow the list.</p>` : ''}`}`;
  return layout({ title: 'Pages', actor, nonce, csrf, current: 'canonical', body, navCounts });
}

export function pageEntryPage({ page, configLocked = false, waiting = null, hint = null, canReview, canCanonical, canonicalRole, actor, csrf, nonce, flash = null, navCounts = {} }) {
  const tier = page.tier;
  const body = html`${flashBox(flash)}<a class="faint" href="/inbox/pages">← All pages</a>
    <h1>${page.title}</h1>
    <p class="lede">Tier: <strong>${TIER_NAME[tier] || tier}</strong>${tier === 'canonical' ? '. The agent cannot change this page, and anything that contradicts it is logged as a challenge.' : '.'}</p>
    ${hint ? html`<p class="muted">${countsLine(hint)}.</p>` : ''}
    ${waiting ? html`<div class="flash flash--ok" role="status">A tier change for this page is already waiting: <a href="/inbox/p/${encodeURIComponent(waiting.id)}">${waiting.title}</a></div>` : ''}
    ${configLocked ? html`<p class="muted">This page is locked in brain.config.yaml. Only a person editing that file by hand can unlock it.</p>` : ''}
    ${!canReview ? html`<p class="muted">You can read this page's tier. Changing it needs a reviewer.</p>`
      : waiting || configLocked ? ''
        : html`<h2>Change the tier</h2><p class="muted">The change is a small proposal that goes through the usual checks and approval, and it is logged.</p>
          <div class="row">${tierChoices({ action: `/inbox/pages/${encodeURIComponent(page.slug)}/tier`, current: tier, title: page.title, csrf, canCanonical, canonicalRole })}</div>`}`;
  return layout({ title: page.title, actor, nonce, csrf, current: 'canonical', body, navCounts });
}

export function messagePage({ title, text, actor = null, csrf = '', nonce, link = null }) {
  const body = html`<div class="login card"><h1>${title}</h1><p>${text}</p>${link ? html`<p><a class="btn" href="${safeUrl(link.href)}">${link.label}</a></p>` : ''}</div>`;
  return layout({ title, actor, nonce, csrf, body });
}

export function continueAsPage({ display, code, csrf, nonce }) {
  const body = html`<div class="login card">
    <h1>Continue as ${display}?</h1>
    <p class="lede">This link was sent to you by email. It works once.</p>
    <form method="post" action="/inbox/l/${encodeURIComponent(code)}">${csrfField(csrf)}<button class="btn btn--primary" type="submit">Continue</button></form>
  </div>`;
  return layout({ title: 'Continue', nonce, csrf, body });
}
