/**
 * The review page: facts next to the passages they cite, the page as it will
 * be written, its diff, the contents list, and the view choice in the address.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { capText, frontMatterLines, hunkRows, layoutDiff, MAX_LINE_CHARS, PAGE_TEXT_LIMIT, parseDiff, splitFront, wordDiff } from '../../src/governance/diff.mjs';
import { escapeHtml } from '../../src/governance/html.mjs';
import { groupClaims, markWords, mergePassages, splitUnits, supportFor, factWords } from '../../src/governance/web/passages.mjs';
import { detailChanges, pageText } from '../../src/governance/web/pageview.mjs';
import { proposalName, proposalPage, queuePage } from '../../src/governance/web/views.mjs';
import { ada, ALPHA_V2, CLEAN_AUDIT, cleanup, client, govApp, job, page, proposalBranch, repo } from './fixtures.mjs';

const TOKENS = 'ada:owner:ada-secret-1;bob:reviewer:bob-secret-2';
const LOGINS = 'ada:ada-signin-1;bob:bob-signin-2';
let saved;
const live = [];
before(() => { saved = process.env.ALMAGEST_TOKENS; process.env.ALMAGEST_TOKENS = TOKENS; process.env.ALMAGEST_LOGINS = LOGINS; process.env.ALMAGEST_SECRET_KEY = 'test-secret'; });
after(async () => {
  for (const a of live) await a.stop().catch(() => {});
  process.env.ALMAGEST_TOKENS = saved;
  cleanup();
});

async function serve(files) {
  const app = await govApp(repo(), { overrides: { service: { http: { port: 0 } } } });
  const server = await app.start();
  live.push(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const b = await proposalBranch(app, 'ingest/q3-board-deck-abcdef1', files);
  const p = await app.ctx.governance.createFromJob(job(b.branch), { ...b, audit: CLEAN_AUDIT });
  const c = client(base);
  const lp = await c.get('/inbox/login');
  await c.post('/inbox/login', { form: { csrf: c.csrfFrom(lp.text), secret: 'ada-signin-1', next: '/inbox' } });
  return { app, c, p, base };
}

const stripScripts = (t) => t.replace(/<script[\s\S]*?<\/script>/g, '');

// ── grouping ─────────────────────────────────────────────────────────────────

const claim = (text, locator, excerpt, id = 'doc', status = 'found') => ({ op: 'add', text, citation: { id, locator }, excerptStatus: status, ...(excerpt === undefined ? {} : { excerpt }) });

describe('facts that share a passage', () => {
  const A = 'Alpha retries failed jobs on a fixed backoff and never more than five times in a row.';
  const B = 'Beta reads the same queue but drops any job older than a day without telling anyone.';
  const C = 'Gamma keeps a copy of every dropped job in a log so that people can look at them later.';

  it('become one group with one merged passage', () => {
    const groups = groupClaims([
      claim('Alpha retries on a fixed backoff', 'p.3', `${A} ${B}`),
      claim('Beta drops old jobs', 'p.3', `${A} ${B} ${C}`),
      claim('Gamma logs dropped jobs', 'p.3', `${B} ${C}`),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].items.length, 3);
    assert.equal(groups[0].passage, `${A} ${B} ${C}`);
  });

  it('joins two excerpts that only overlap at the edge, and keeps the ellipsis marks', () => {
    const merged = mergePassages(`… ${A} ${B} …`, `${B} ${C} …`);
    assert.equal(merged, `… ${A} ${B} ${C} …`);
  });

  it('stay apart when the spot differs, the source differs, the passages do not overlap, or the passage was not found', () => {
    assert.equal(groupClaims([claim('x', 'p.3', A), claim('y', 'p.4', A)]).length, 2);
    assert.equal(groupClaims([claim('x', 'p.3', A, 'one'), claim('y', 'p.3', A, 'two')]).length, 2);
    assert.equal(groupClaims([claim('x', 'p.3', A), claim('y', 'p.3', C)]).length, 2);
    const gaps = groupClaims([claim('x', 'p.3', undefined, 'doc', 'not-found'), claim('y', 'p.3', undefined, 'doc', 'not-found')]);
    assert.equal(gaps.length, 2, 'every unsupported fact keeps its own visible gap');
    assert.equal(groupClaims([claim('x', 'p.3', A), claim('y', 'p.4', C), claim('z', 'p.3', A)]).length, 3, 'only consecutive facts group');
  });

  it('are printed with one passage in the page, and each fact stays on the left', async () => {
    const sentences = Array.from({ length: 14 }, (_, i) => `Sentence number ${i + 1} says something particular about the thing named item${i + 1} in this long page.`);
    const sidecar = `=== page 3 ===\n${sentences.join(' ')}\n`;
    const body = `## Details\n\nThe thing named item2 is described. [source: alpha-pdf, p.3]\n\nThe thing named item5 is described. [source: alpha-pdf, p.3]\n\nThe thing named item8 is described. [source: alpha-pdf, p.3]\n`;
    const { c, p } = await serve({ 'brain/wiki/zeta.md': page({ title: 'Zeta', body }), 'brain/raw/extracted/alpha.pdf.txt': sidecar });
    const res = await c.get(`/inbox/p/${p.id}`);
    assert.equal(res.status, 200);
    const alphaSection = res.text.slice(res.text.indexOf('id="page-zeta"'));
    assert.equal((alphaSection.match(/<blockquote class="al-quote"/g) || []).length, 1, 'one passage for three facts');
    assert.equal((alphaSection.match(/class="al-claim al-claim--/g) || []).length, 3);
    assert.match(alphaSection, /What gets written/);
    assert.match(alphaSection, /Where it comes from/);
  });
});

// ── marked words ─────────────────────────────────────────────────────────────

describe('the part of a passage that supports a fact', () => {
  const PASSAGE = 'Intro sentence about nothing much. The scheduler retries failed jobs on a fixed backoff. Parked jobs wait a week. Closing remark that is unrelated.';

  it('splits a passage into sentences and Markdown lines', () => {
    assert.deepEqual(splitUnits('First one. Second one!\n## A heading\n- an item. with more\n| a | b |'), ['First one.', 'Second one!', '## A heading', '- an item. with more', '| a | b |']);
    assert.ok(splitUnits('x '.repeat(400) + '| a | b | - Item Two').length > 1, 'a long flattened line is cut');
  });

  it('shows the best sentence for the fact, and only that fact\'s words marked', () => {
    const r = supportFor(PASSAGE, 'The scheduler retries jobs with a fixed backoff.');
    assert.equal(r.matched, true);
    const out = String(r.html);
    assert.match(out, /<mark>scheduler retries<\/mark>/);
    assert.match(out, /<mark>fixed backoff<\/mark>/);
    assert.ok(!out.includes('Closing remark'), 'only the supporting sentence');
    assert.ok(!out.includes('Parked jobs'), 'a neighbour that shares nothing is left out');
  });

  it('never marks a stopword and never bridges across one', () => {
    const out = String(markWords('The scheduler retries on a fixed backoff and the rest.', factWords('scheduler retries on a fixed backoff and the rest')));
    assert.ok(!/<mark>[^<]*\b(the|on|a|and)\b[^<]*<\/mark>/i.test(out), out);
    assert.match(out, /<mark>scheduler retries<\/mark> on a <mark>fixed backoff<\/mark> and the <mark>rest<\/mark>/);
  });

  it('claims nothing when no sentence shares two meaningful words', () => {
    const r = supportFor(PASSAGE, 'Completely unrelated words entirely');
    assert.equal(r.matched, false);
    assert.ok(!String(r.html).includes('<mark>'));
    assert.ok(String(r.html).startsWith('Intro sentence'));
  });

  it('is built from escaped pieces: markup in a passage or a fact is text', () => {
    const r = supportFor('The <script>alert(1)</script> value & the <b>rate</b> limit is high.', 'A <script>alert(1)</script> value & rate limit.');
    const out = String(r.html);
    assert.ok(!out.includes('<script>') && !out.includes('<b>'), out);
    assert.ok(out.includes('&lt;') && out.includes('&amp;'));
    assert.equal(out.replace(/<\/?mark>/g, ''), escapeHtml('The <script>alert(1)</script> value & the <b>rate</b> limit is high.'));
  });

  it('shows on the page as one row per fact, with one named source and one fold for the whole passage', async () => {
    const sidecar = '=== page 3 ===\nThe scheduler retries failed jobs on a fixed backoff. Parked jobs wait a whole week before they go. Alerts go to the on call person.\n';
    const body = '## Details\n\nThe scheduler retries failed jobs with a fixed backoff. [source: alpha-pdf, p.3]\n\nParked jobs wait a week before they go. [source: alpha-pdf, p.3]\n\nThe moon is made of cheese. [source: alpha-pdf, p.3]\n';
    const { c, p } = await serve({ 'brain/wiki/zeta.md': page({ title: 'Zeta', body }), 'brain/raw/extracted/alpha.pdf.txt': sidecar });
    const res = await c.get(`/inbox/p/${p.id}`);
    const sec = res.text.slice(res.text.indexOf('id="page-zeta"'));
    assert.equal((sec.match(/class="al-compare__row"/g) || []).length, 3, 'a row per fact');
    assert.equal((sec.match(/class="al-compare__group"/g) || []).length, 1);
    assert.equal((sec.match(/class="al-source">Source: /g) || []).length, 1, 'the source is named once');
    assert.equal((sec.match(/Show the whole passage/g) || []).length, 1);
    assert.match(sec, /<p class="al-compare__support">The <mark>scheduler retries failed jobs<\/mark>/);
    assert.match(sec, /No sentence in this passage clearly matches\. Read the whole passage\./);
    assert.ok(!/data-f=/.test(res.text), 'no per-fact emphasis hooks');
  });

  it('shows on the page without letting a hostile passage or fact become markup', async () => {
    const hostile = 'The value is <script>alert("x")</script> high & rising today.';
    const body = '## Details\n\nThe value is <script>alert("x")</script> high & rising. [source: alpha-pdf, p.3]\n';
    const { c, p } = await serve({ 'brain/wiki/evil.md': page({ title: 'Evil', body }), 'brain/raw/extracted/alpha.pdf.txt': `=== page 3 ===\n${hostile}\n` });
    const res = await c.get(`/inbox/p/${p.id}`);
    assert.ok(!res.text.includes('<script>alert'));
    assert.equal((res.text.match(/<script/g) || []).length, 1, 'only ours');
    assert.match(res.text, /<p class="al-compare__support">[^]*?<mark>[^<]*<\/mark>[^]*?&lt;script&gt;/);
    assert.match(res.text, /&amp; rising/);
  });
});

// ── the diff parser ──────────────────────────────────────────────────────────

describe('diff parser', () => {
  const header = 'diff --git a/w/a.md b/w/a.md\nindex 111..222 100644\n--- a/w/a.md\n+++ b/w/a.md\n';

  it('reads added, removed and changed lines with their numbers', () => {
    const d = parseDiff(`${header}@@ -1,4 +1,5 @@ ## Heading\n one\n-two old words here\n+two new words here\n+extra\n three\n four\n`);
    assert.equal(d.files.length, 1);
    assert.equal(d.added, 2);
    assert.equal(d.removed, 1);
    const h = d.files[0].hunks[0];
    assert.equal(h.header, '## Heading');
    assert.deepEqual(h.lines.map((l) => [l.type, l.oldNo, l.newNo, l.text]), [
      ['ctx', 1, 1, 'one'], ['del', 2, null, 'two old words here'], ['add', null, 2, 'two new words here'], ['add', null, 3, 'extra'], ['ctx', 3, 4, 'three'], ['ctx', 4, 5, 'four'],
    ]);
    const rows = hunkRows(h);
    const changed = rows.find((r) => r.left?.type === 'del');
    assert.ok(changed.left.parts.some((p) => p.changed && p.text === 'old'), 'the changed word is marked');
    assert.ok(changed.right.parts.some((p) => p.changed && p.text === 'new'));
    assert.equal(rows.find((r) => r.right?.text === 'extra').left, null, 'an added line with no partner');
  });

  it('keeps a deleted line that begins with dashes as a line, not a file header', () => {
    const d = parseDiff(`${header}@@ -1,2 +1,1 @@\n--- not a header\n keep\n`);
    assert.equal(d.removed, 1);
    assert.equal(d.files[0].hunks[0].lines[0].text, '-- not a header');
  });

  it('notes a file with no newline at the end', () => {
    const d = parseDiff(`${header}@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n`);
    const [del, add] = d.files[0].hunks[0].lines;
    assert.equal(del.noEol, true);
    assert.equal(add.noEol, true);
    assert.equal(d.added, 1);
  });

  it('reads a rename, with and without changes', () => {
    const only = parseDiff('diff --git a/w/old.md b/w/new.md\nsimilarity index 100%\nrename from w/old.md\nrename to w/new.md\n');
    assert.equal(only.files[0].renamed, true);
    assert.equal(only.files[0].oldPath, 'w/old.md');
    assert.equal(only.files[0].newPath, 'w/new.md');
    assert.equal(only.files[0].hunks.length, 0);
    const edited = parseDiff('diff --git a/w/old.md b/w/new.md\nsimilarity index 80%\nrename from w/old.md\nrename to w/new.md\nindex 1..2 100644\n--- a/w/old.md\n+++ b/w/new.md\n@@ -1 +1 @@\n-a\n+b\n');
    assert.equal(edited.files[0].renamed, true);
    assert.equal(edited.files[0].hunks[0].lines.length, 2);
  });

  it('copes with an empty hunk, an empty diff and several files', () => {
    const empty = parseDiff(`${header}@@ -3,0 +3,0 @@\n`);
    assert.equal(empty.files[0].hunks[0].lines.length, 0);
    assert.equal(layoutDiff(empty.files[0], null).find((i) => i.kind === 'hunk').empty, true);
    assert.deepEqual(parseDiff(''), { files: [], added: 0, removed: 0 });
    assert.equal(parseDiff(`${header}@@ -1 +1 @@\n-a\n+b\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-c\n+d\n`).files.length, 2);
  });

  it('cuts very long lines and skips word-by-word comparison for them', () => {
    const long = 'word '.repeat(5000);
    const d = parseDiff(`${header}@@ -1 +1 @@\n-${long}\n+${long}x\n`);
    const [del, add] = d.files[0].hunks[0].lines;
    assert.equal(del.cut, true);
    assert.equal(del.text.length, MAX_LINE_CHARS);
    assert.equal(wordDiff(long, `${long}x`), null);
    const rows = hunkRows(d.files[0].hunks[0]);
    assert.equal(rows[0].left.parts, undefined);
    assert.equal(add.cut, true);
  });

  it('works out the unchanged stretches between hunks, and fills them from the new text', () => {
    const d = parseDiff(`${header}@@ -5,3 +5,3 @@\n five\n-six\n+SIX\n seven\n@@ -20,2 +20,2 @@\n twenty\n-x\n+y\n`);
    const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const items = layoutDiff(d.files[0], text, { newTotal: 30 });
    assert.deepEqual(items.map((i) => (i.kind === 'fold' ? `fold ${i.count}` : 'hunk')), ['fold 4', 'hunk', 'fold 12', 'hunk', 'fold 9']);
    assert.equal(items[0].lines[0].text, 'line 1');
    assert.equal(layoutDiff(d.files[0], null, { newTotal: 30 })[0].lines, null, 'no text, a fold that cannot be opened');
  });
});

describe('capText', () => {
  it('leaves small text alone and cuts large text at a line end, saying how large it was', () => {
    const small = capText('abc\n');
    assert.deepEqual(small, { text: 'abc\n', bytes: 4, shownBytes: 4, truncated: false });
    const big = capText('line of text\n'.repeat(30000));
    assert.equal(big.truncated, true);
    assert.equal(big.bytes, 13 * 30000);
    assert.ok(big.shownBytes <= PAGE_TEXT_LIMIT);
    assert.ok(big.text.endsWith('\n'));
    assert.equal(PAGE_TEXT_LIMIT, 200 * 1024);
  });
});

// ── the whole page, as text ──────────────────────────────────────────────────

describe('the page as text', () => {
  it('shows Markdown as text: headings by style, lists as lines, citations as chips, markup as text', () => {
    const out = String(pageText('## Heading <b>x</b>\n\n- item one [source: a, p.1]\n  - nested\n\nA paragraph with <script>alert(1)</script> in it.\n', { titles: new Map([['a', 'The A']]) }));
    assert.match(out, /al-doc__h al-doc__h--2/);
    assert.match(out, /al-doc__li al-doc__li--1/);
    assert.match(out, /<span class="al-cite" title="The A">a · p\.1<\/span>/);
    assert.ok(!out.includes('<b>x</b>'));
    assert.ok(!out.includes('<script>'));
    assert.ok(!out.includes('<h2'), 'Markdown is not rendered');
  });

  it('never interprets page text, front matter included, when served', async () => {
    const body = `## Details <img src=x onerror=alert(1)>\n\nThe text says <script>alert("page")</script> here. [source: alpha-pdf, p.3]\n`;
    const text = page({ title: 'Evil <img src=x onerror=alert(2)>', body });
    const { c, p } = await serve({ 'brain/wiki/evil.md': text });
    const res = await c.get(`/inbox/p/${p.id}?view=page`);
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('<script>alert'));
    assert.ok(!res.text.includes('<img src=x'));
    assert.equal((res.text.match(/<script/g) || []).length, 1);
    assert.match(res.text, /The text says &lt;script&gt;alert\(&quot;page&quot;\)&lt;\/script&gt; here\./);
    assert.match(res.text, /al-docmeta/);
    assert.match(res.text, /<span class="al-cite" title="Alpha System Overview">p\.3<\/span>/, 'one source: the chip says only the locator');
  });

  it('prints a diff for a changed page, one column by default and side by side on request', async () => {
    const { c, p } = await serve({ 'brain/wiki/alpha.md': ALPHA_V2 });
    const one = await c.get(`/inbox/p/${p.id}?view=page`);
    assert.match(one.text, /class="al-diff"/);
    assert.match(one.text, /al-diff__line--add/);
    assert.match(one.text, /al-diff__line--del/);
    assert.match(one.text, /<ins class="al-diff__ins">45<\/ins>/, 'the changed word is marked');
    assert.match(one.text, /unchanged line/);
    const split = await c.get(`/inbox/p/${p.id}?view=page&diff=split`);
    assert.match(split.text, /class="al-diff al-diff--split"/);
    assert.match(split.text, /al-diff__row/);
    assert.match(split.text, /href="\/inbox\/p\/[^"]+\?view=page&amp;diff=split#page-alpha"/);
  });

  it('says plainly when a page is too large to show whole, and still lets the person approve', () => {
    const p = { id: 'prp_1', status: 'open', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), createdAt: new Date().toISOString(), source: { id: 's', title: 'S' }, branch: 'x', approvals: [], audit: CLEAN_AUDIT,
      changes: [{ slug: 'big', path: 'brain/wiki/big.md', action: 'create', title: 'Big page', tier: 'curated', claims: [], fields: [], pageStatus: 'pending' }] };
    const out = String(proposalPage({ proposal: p, decisions: [], evaluation: { ready: true, blockers: [], missing: [], explanation: 'ok' }, actor: ada, csrf: 'c', nonce: 'n', canAct: { ok: true, canReview: true }, view: 'page',
      pageTexts: { big: { text: { text: '---\ntitle: Big\n---\nbody\n', bytes: 312 * 1024, shownBytes: 200 * 1024, truncated: true }, lines: 9000 } } }));
    assert.match(out, /This page is 312 KB\. Only the first 200 KB is shown here\. The rest is not shown\./);
    assert.match(out, /name="scope" value="all"><button class="al-btn al-btn--primary" type="submit">Approve all/, 'approval is unchanged');
  });
});

// ── the view in the address, through a form post ─────────────────────────────

describe('view and diff mode survive a form post', () => {
  it('carries both through the redirect, and only known values', async () => {
    const { c, p } = await serve({ 'brain/wiki/alpha.md': ALPHA_V2, 'brain/wiki/delta.md': page({ title: 'Delta', body: '## A\n\nDelta is new. [source: alpha-pdf, p.1]\n' }) });
    const res = await c.get(`/inbox/p/${p.id}?view=page&diff=split`);
    assert.match(res.text, /<input type="hidden" name="view" value="page">/);
    assert.match(res.text, /<input type="hidden" name="diff" value="split">/);
    const csrf = c.csrfFrom(res.text);
    const headSha = res.text.match(/name="headSha" value="([0-9a-f]{40})"/)[1];
    const back = await c.post(`/inbox/p/${p.id}/page/delta/accept`, { form: { csrf, headSha, view: 'page', diff: 'split' } });
    assert.equal(back.status, 303);
    assert.equal(back.location, `/inbox/p/${p.id}?view=page&diff=split&m=page_accepted`);
    const fresh = await c.get(`/inbox/p/${p.id}`);
    const headSha2 = fresh.text.match(/name="headSha" value="([0-9a-f]{40})"/)[1];
    const odd = await c.post(`/inbox/p/${p.id}/page/delta/accept`, { form: { csrf, headSha: headSha2, view: '"><script>', diff: 'x' } });
    assert.equal(odd.location, `/inbox/p/${p.id}?m=page_accepted`);
    // Default view: no extra fields, so addresses stay clean.
    const plain = await c.get(`/inbox/p/${p.id}`);
    assert.ok(!/name="view"/.test(plain.text));
  });

  it('keeps the view when an action fails and the page is shown again', async () => {
    const { c, p } = await serve({ 'brain/wiki/alpha.md': ALPHA_V2 });
    const res = await c.get(`/inbox/p/${p.id}?view=page`);
    const csrf = c.csrfFrom(res.text);
    const bad = await c.post(`/inbox/p/${p.id}/approve`, { form: { csrf, headSha: '0'.repeat(40), scope: 'all', view: 'page' } });
    assert.ok(bad.status >= 400);
    assert.match(bad.text, /<input type="hidden" name="view" value="page">/);
    assert.match(bad.text, /al-doc|al-diff/, 'still the whole-page view');
  });
});

// ── names, header, contents ──────────────────────────────────────────────────

describe('header, contents and names', () => {
  it('titles the page with the source name and leaves the stored title alone', async () => {
    const { app, c, p } = await serve({ 'brain/wiki/alpha.md': ALPHA_V2 });
    assert.equal(p.title, 'New material from “Q3 board deck”', 'the stored title is unchanged');
    const res = await c.get(`/inbox/p/${p.id}`);
    assert.match(res.text, /<h1>Q3 board deck<\/h1>/);
    assert.match(res.text, /<p class="al-reviewhead__ref al-mono"[^>]*>brain\/raw\/alpha\.pdf<\/p>/);
    assert.ok(!/<h1>New material from/.test(res.text));
    const stored = await app.ctx.store.proposals.get(p.id);
    assert.equal(stored.title, 'New material from “Q3 board deck”');
    // A connector source titled by its path takes the name its pages give it.
    const named = proposalName({ ...p, source: { kind: 'connector', id: 'gh:a/b.mdx', connector: 'gh', ref: 'a/b.mdx', path: 'brain/raw/x.txt', title: 'org/repo/a/b.mdx' }, changes: [{ claims: [{ op: 'add', citation: { id: 'b', title: 'The Real Name', path: 'brain/raw/x.txt' } }] }] });
    assert.deepEqual(named, { title: 'The Real Name', ref: 'gh · a/b.mdx' });
  });

  it('has a summary line, a status chip, what is still needed and the approve button in the header', async () => {
    const { c, p } = await serve({ 'brain/wiki/alpha.md': ALPHA_V2, 'brain/wiki/delta.md': page({ title: 'Delta', body: '## A\n\nDelta is new. [source: alpha-pdf, p.1]\n' }) });
    const res = await c.get(`/inbox/p/${p.id}`);
    const start = res.text.indexOf('<header class="al-reviewhead">');
    const head = res.text.slice(start, res.text.indexOf('</header>', start));
    assert.match(head, /1 new page, 1 changed page/);
    assert.match(head, /facts: /);
    assert.match(head, /Sent /);
    assert.match(head, /Waiting for review/);
    assert.match(head, /thing still needed/);
    assert.match(head, /action="\/inbox\/p\/[^"]+\/approve"/);
    assert.match(head, /href="#request-changes"/);
    assert.match(head, /href="#turn-down"/);
    assert.match(res.text, /id="turn-down"/);
  });

  it('lists the pages in the contents, new first, with markers, tier, counts and review state', async () => {
    const { c, p } = await serve({ 'brain/wiki/alpha.md': ALPHA_V2, 'brain/wiki/delta.md': page({ title: 'Delta', body: '## A\n\nDelta is new. [source: alpha-pdf, p.1]\n' }) });
    const res = await c.get(`/inbox/p/${p.id}`);
    const from = res.text.indexOf('<nav class="al-rail"');
    const rail = res.text.slice(from, res.text.indexOf('</nav>', from));
    assert.ok(rail.indexOf('href="#page-delta"') < rail.indexOf('href="#page-alpha"'), 'new before changed');
    assert.match(rail, />New<\/span>/);
    assert.match(rail, />Changed<\/span>/);
    assert.match(rail, /al-tier al-tier--curated/);
    assert.match(rail, /<span class="al-delta__add">\+1<\/span>/);
    assert.match(rail, /Not accepted yet: /);
    assert.match(rail, /0 of 2 pages accepted/);
    const csrf = c.csrfFrom(res.text);
    const headSha = res.text.match(/name="headSha" value="([0-9a-f]{40})"/)[1];
    await c.post(`/inbox/p/${p.id}/page/delta/accept`, { form: { csrf, headSha } });
    const after = await c.get(`/inbox/p/${p.id}`);
    assert.match(after.text, /1 of 2 pages accepted/);
    assert.match(after.text, /Accepted: /);
  });

  it('puts the questions first in the contents when there are any', () => {
    const p = { id: 'prp_1', status: 'open', headSha: 'a'.repeat(40), createdAt: new Date().toISOString(), source: { id: 's', title: 'S' }, branch: 'x', approvals: [], audit: CLEAN_AUDIT, changes: [] };
    const d = { id: 'dec_1', kind: 'contradiction', status: 'open', question: 'Which one?', options: [{ id: 'a', label: 'A' }], context: {} };
    const out = String(proposalPage({ proposal: p, decisions: [d], evaluation: { ready: false, blockers: [], missing: [{ message: 'x' }] }, actor: ada, csrf: 'c', nonce: 'n', canAct: { ok: true, canReview: true } }));
    assert.match(out, /href="#questions"[^>]*>[\s\S]*?1 question to answer first/);
    assert.match(out, /id="questions"/);
    assert.match(out, /action="\/inbox\/d\/dec_1\/resolve"/);
    assert.match(out, /name="headSha"/);
  });

  it('folds the other files, except a new file that is not bookkeeping', () => {
    const p = { id: 'prp_1', status: 'open', headSha: 'a'.repeat(40), createdAt: new Date().toISOString(), source: { id: 's', title: 'S' }, branch: 'x', approvals: [], audit: CLEAN_AUDIT, changes: [],
      otherFiles: [
        { status: 'M', path: 'brain/index.md', preview: 'added line', previewOf: 'added' },
        { status: 'A', path: 'brain/raw/extracted/s.txt', preview: 'sidecar', previewOf: 'start' },
        { status: 'A', path: 'brain/raw/notes.md', preview: 'new notes', previewOf: 'start' },
      ] };
    const out = String(proposalPage({ proposal: p, decisions: [], evaluation: { ready: false, blockers: [], missing: [] }, actor: ada, csrf: 'c', nonce: 'n', canAct: { ok: true, canReview: true } }));
    assert.match(out, /<summary>Other files \(3\)<\/summary>/);
    assert.match(out, /<details class="al-filecard" id="file-0">/);
    assert.match(out, /<details class="al-filecard" id="file-1">/);
    assert.match(out, /<details class="al-filecard" id="file-2" open>/);
    for (const t of ['added line', 'sidecar', 'new notes']) assert.ok(out.includes(t), `${t} is in the HTML`);
  });

  it('shows each queue row with the document name, its reference, counts, status and age', () => {
    const p = { id: 'prp_1', status: 'open', title: 'New material from “org/x/a.mdx”', createdAt: new Date(Date.now() - 3600e3).toISOString(), source: { id: 's', title: 'org/x/a.mdx', path: 'brain/raw/a.txt' },
      changes: [{ slug: 'a', action: 'create', title: 'A', claims: [{ op: 'add', citation: { id: 'a', title: 'The Real Name', path: 'brain/raw/a.txt' } }], pageStatus: 'pending' }] };
    const info = { title: p.title, line: '1 new fact about A', openDecisions: 1, hot: 0, counts: { pages: 1, added: 1, changed: 0, removed: 0 } };
    const out = String(queuePage({ items: [{ proposal: p, info }], filters: { show: 'active', q: '' }, actor: ada, csrf: 'c', nonce: 'n' }));
    assert.match(out, /<div class="al-card__title">The Real Name<\/div>/);
    assert.match(out, /al-queuerow__ref[^>]*>brain\/raw\/a\.txt</);
    assert.match(out, /1 page/);
    assert.match(out, /\+1/);
    assert.match(out, /1 question for you/);
    assert.match(out, /Waiting for review/);
    assert.match(out, /1 hour ago/);
  });
});

// ── warnings, in both views ──────────────────────────────────────────────────

describe('every warning stays visible', () => {
  const claims = [
    { op: 'add', text: 'Fact with no source.', excerptStatus: 'no-citation' },
    { op: 'add', text: 'Fact with unknown source.', citation: { id: 'unknown', locator: '' }, excerptStatus: 'no-citation' },
    { op: 'add', text: 'Fact with a source the page does not list.', citation: { id: 'ghost', locator: 'p.1' }, excerptStatus: 'unknown-source' },
    { op: 'add', text: 'Fact whose source file is gone.', citation: { id: 'a', locator: 'p.1', title: 'A' }, excerptStatus: 'source-missing' },
    { op: 'add', text: 'Fact whose spot is not in the source.', citation: { id: 'a', locator: 'p.99', title: 'A' }, excerptStatus: 'not-found' },
  ];
  const p = { id: 'prp_1', status: 'open', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), createdAt: new Date().toISOString(), source: { id: 'a', title: 'A' }, branch: 'x', approvals: [], audit: CLEAN_AUDIT,
    changes: [{ slug: 'pg', path: 'brain/wiki/pg.md', action: 'create', title: 'Pg', tier: 'curated', claims, fields: [], pageStatus: 'pending' }] };
  const render = (view, pageTexts) => String(proposalPage({ proposal: p, decisions: [], evaluation: { ready: false, blockers: [], missing: [] }, actor: ada, csrf: 'c', nonce: 'n', canAct: { ok: true, canReview: true }, view, pageTexts }));
  const WARNINGS = [
    'No source given for this.',
    'The source for this is not known yet — it is listed as an open question.',
    "This cites a source the page doesn't list. That's worth a closer look.",
    "The source file isn't available here, so the passage can't be shown.",
    "We couldn't find that spot in the source. Check it by hand before you approve.",
  ];

  it('in the compare view, in the right column of each fact', () => {
    const out = render('compare');
    for (const w of WARNINGS) assert.ok(out.includes(w), w);
    assert.equal((out.match(/class="al-compare__group"/g) || []).length, 5, 'no unsupported fact is folded into another');
  });

  it('in the whole page view too', () => {
    const out = render('page', { pg: { text: { text: '---\ntitle: Pg\n---\nbody\n', bytes: 22, shownBytes: 22, truncated: false }, lines: 4 } });
    for (const w of WARNINGS) assert.ok(out.includes(w), w);
    assert.ok(out.includes('al-doc'));
  });

  it('and a page that has no checked facts keeps its own warning', () => {
    const q = { ...p, changes: [{ ...p.changes[0], claims: [], needsManualLook: true, preview: 'Preview text' }] };
    for (const view of ['compare', 'page']) {
      const out = String(proposalPage({ proposal: q, decisions: [], evaluation: { ready: false, blockers: [], missing: [] }, actor: ada, csrf: 'c', nonce: 'n', canAct: { ok: true, canReview: true }, view }));
      assert.match(out, /has no facts the inbox could pair with a source/);
    }
  });
});

// ── learnings, tiers, and the page without its script ────────────────────────

describe('other kinds and no script', () => {
  it('a learnings proposal has the same layout and still shows its whole text', () => {
    const body = 'First line of the learning.\nSecond line with <b>markup</b> & more.\n\n## Basis\n\n- [[delta]]\n';
    const p = { id: 'prp_1', kind: 'learnings', status: 'open', title: '1 thing the brain concluded from what it holds', headSha: 'a'.repeat(40), createdAt: new Date().toISOString(), branch: 'x', approvals: [], audit: CLEAN_AUDIT,
      changes: [{ slug: 'l', path: 'brain/wiki/l.md', action: 'create', title: 'A learning', tier: 'curated', claims: [], fields: [], pageStatus: 'pending', basis: [{ slug: 'delta', title: 'Delta Service' }], body, front: 'title: A learning', meta: { title: 'A learning', confidence: 'medium' } }] };
    const out = String(proposalPage({ proposal: p, decisions: [], evaluation: { ready: false, blockers: [], missing: [] }, actor: ada, csrf: 'c', nonce: 'n', canAct: { ok: true, canReview: true }, view: 'page' }));
    assert.match(out, /<h1>1 thing the brain concluded from what it holds<\/h1>/);
    assert.match(out, /class="al-rail"/);
    assert.match(out, /class="al-pagesec"/);
    for (const line of body.split('\n').filter(Boolean)) assert.ok(out.includes(escapeHtml(line)), line);
    assert.ok(!out.includes('<b>markup</b>'));
    assert.ok(!/data-view=/.test(out), 'no compare or whole page choice for a learning');
    assert.match(out, /<a href="\/inbox\/pages\/delta">Delta Service<\/a>/);
  });

  it('works with the script taken out: every action is a form or a link, and nothing is inline', async () => {
    const { c, p } = await serve({ 'brain/wiki/alpha.md': ALPHA_V2 });
    for (const q of ['', '?view=page', '?view=page&diff=split']) {
      const res = await c.get(`/inbox/p/${p.id}${q}`);
      const t = stripScripts(res.text);
      assert.match(t, /action="\/inbox\/p\/[^"]+\/approve"/);
      assert.match(t, /action="\/inbox\/p\/[^"]+\/page\/alpha\/accept"/);
      assert.match(t, /action="\/inbox\/p\/[^"]+\/page\/alpha\/reject"/);
      assert.match(t, /action="\/inbox\/p\/[^"]+\/request-changes"/);
      assert.match(t, /href="#page-alpha"/);
      assert.match(t, /data-view="compare"[^>]*href="[^"]*view=compare/);
      assert.match(t, /data-view="page"[^>]*href="[^"]*view=page/);
      assert.ok(!/\son[a-z]+\s*=/.test(t.replace(/<style[\s\S]*?<\/style>/g, '')), 'no inline handlers');
      assert.ok(!/\sstyle\s*=/.test(t), 'no style attributes');
      assert.ok(!/(src|href)="https?:/.test(t.replace(/<style[\s\S]*?<\/style>/g, '')), 'nothing external');
    }
  });

  it('the one script is ours, nonced, and never touches approval keys', async () => {
    const { c, p } = await serve({ 'brain/wiki/alpha.md': ALPHA_V2 });
    const res = await c.get(`/inbox/p/${p.id}`);
    const nonce = res.headers.get('content-security-policy').match(/script-src 'nonce-([^']+)'/)[1];
    assert.equal((res.text.match(/<script/g) || []).length, 1);
    const script = res.text.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
    assert.ok(res.text.includes(`<script nonce="${nonce}">`));
    for (const key of ['j', 'k', 'n', 'p', 'v', '?']) assert.ok(script.includes(`'${key}'`), `handles ${key}`);
    assert.ok(!/\.submit\(|requestSubmit|\.click\(\)/.test(script), 'the script never submits a form');
    assert.ok(script.includes('prefers-reduced-motion'));
    assert.ok(/INPUT\|TEXTAREA\|SELECT/.test(script), 'keys are left alone in form fields');
  });
});

// ── tables, links and chips in the page text ─────────────────────────────────

describe('the page text reads like a page', () => {
  const titles = new Map([['a', 'The A'], ['b', 'The B']]);

  it('turns a pipe table into a table, with escaped cells and chips inside cells', () => {
    const out = String(pageText('| Step | Serves |\n|---|:-:|\n| Like <b>x</b> | [[beta]] [source: a, p.1] |\n', { titles }));
    assert.match(out, /<table class="al-doctable">/);
    assert.match(out, /<th scope="col">Step<\/th><th scope="col">Serves<\/th>/);
    assert.match(out, /<td>Like &lt;b&gt;x&lt;\/b&gt;<\/td>/);
    assert.match(out, /<td><span class="al-wikilink" title="beta">beta<\/span> <span class="al-cite" title="The A">a · p\.1<\/span><\/td>/);
    assert.ok(!out.includes('|'), 'no pipe characters left');
  });

  it('keeps a malformed table as plain lines', () => {
    for (const bad of ['| only one line |', '| a | b |\n| x | y |', '| a | b |\n|---|\n| x | y |']) {
      const out = String(pageText(bad, { titles }));
      assert.ok(!out.includes('<table'), bad);
      assert.match(out, /al-doc__row/);
    }
  });

  it('shows a wikilink as its text, with the slug in title, and shortens chips by the number of sources', () => {
    const one = String(pageText('See [[beta|the beta page]] and [[gamma#part]]. [source: a, §Key Findings]', { titles, single: true }));
    assert.match(one, /<span class="al-wikilink" title="beta">the beta page<\/span>/);
    assert.match(one, /<span class="al-wikilink" title="gamma">gamma<\/span>/);
    assert.ok(!one.includes('[['));
    assert.match(one, /<span class="al-cite" title="The A">§Key Findings<\/span>/);
    const many = String(pageText('Fact. [source: b, p.2] And [source: unknown]', { titles, single: false }));
    assert.match(many, /title="The B">b · p\.2<\/span>/);
    assert.match(many, />unknown<\/span>/);
  });
});

// ── what changed in a page's details ─────────────────────────────────────────

describe('details of a changed page', () => {
  it('says what changed in plain words', () => {
    const before = { tier: 'curated', tags: ['a'], aliases: [], status: 'draft', confidence: 'high', date_modified: '2026-01-06', related: ['[[beta]]'], relations: { supports: ['[[x]]'] }, sources: [{ id: 's1', title: 'Old source' }, { id: 's2', title: 'Kept' }] };
    const after = { tier: 'evidence', tags: ['a', 'new'], aliases: ['Al'], status: 'draft', confidence: 'medium', date_modified: new Date('2026-11-16T00:00:00Z'), related: ['[[beta]]', '[[delta]]'], relations: { depends_on: ['[[y]]'] }, sources: [{ id: 's2', title: 'Kept' }, { id: 's3', title: 'New source' }] };
    assert.deepEqual(detailChanges(before, after), [
      'Tier changed from “curated” to “evidence”', 'Confidence changed from “high” to “medium”', 'Date last changed changed from “2026-01-06” to “2026-11-16”',
      'Tag added: new', 'Also known as added: Al', 'Source added: New source', 'Source removed: Old source', 'Related page added: delta',
      'No longer supports: x', 'Now depends on: y',
    ]);
    assert.deepEqual(detailChanges({ tier: 'a' }, { tier: 'a' }), []);
  });

  it('finds where the details block ends and splits a diff there', () => {
    assert.equal(frontMatterLines('---\ntitle: x\n---\nbody\n'), 3);
    assert.equal(frontMatterLines('no front matter\n'), 0);
    const d = parseDiff('diff --git a/p.md b/p.md\n--- a/p.md\n+++ b/p.md\n@@ -2,6 +2,7 @@\n title: x\n-tier: a\n+tier: b\n ---\n body one\n+body two\n body three\n');
    const { front, body } = splitFront(d.files[0], 4, 4);
    assert.equal(front.hunks.length, 1);
    assert.deepEqual(front.hunks[0].lines.map((l) => l.text), ['title: x', 'tier: a', 'tier: b', '---']);
    assert.equal(body.hunks.length, 1);
    assert.deepEqual(body.hunks[0].lines.filter((l) => l.type === 'add').map((l) => l.text), ['body two']);
    assert.equal(splitFront(parseDiff('diff --git a/p.md b/p.md\n--- a/p.md\n+++ b/p.md\n@@ -1 +1 @@\n-x\n+y\n').files[0], 0, 0).front.hunks.length, 0);
  });

  it('serves the details list first, the raw block in a fold, and the body diff', async () => {
    const changed = ALPHA_V2.replace('tier: curated', 'tier: evidence').replace('confidence: high', 'confidence: medium');
    const { c, p } = await serve({ 'brain/wiki/alpha.md': changed });
    const res = await c.get(`/inbox/p/${p.id}?view=page`);
    const sec = res.text.slice(res.text.indexOf('id="page-alpha"'));
    assert.match(sec, /What changed in the page's details/);
    assert.match(sec, /<li>Tier changed from “curated” to “evidence”<\/li>/);
    assert.match(sec, /<li>Confidence changed from “high” to “medium”<\/li>/);
    assert.match(sec, /<summary>Show the raw details block<\/summary>/);
    assert.match(sec, /What changed in the text/);
    const body = sec.slice(sec.indexOf('What changed in the text'));
    assert.match(body, /<ins class="al-diff__ins">45<\/ins>/);
    assert.ok(!/tier: evidence/.test(body), 'the raw details lines are not in the body diff');
    assert.match(sec.slice(0, sec.indexOf('What changed in the text')), /tier: [^]*evidence/, 'but they are in the fold');
  });
});

// ── the strip under the header ───────────────────────────────────────────────

describe('the strip under the header', () => {
  const base = { id: 'prp_1', status: 'open', headSha: 'a'.repeat(40), createdAt: new Date().toISOString(), source: { id: 's', title: 'S' }, branch: 'x', approvals: [], changes: [] };
  const render = (p, evaluation, canAct = { ok: true, canReview: true }) => String(proposalPage({ proposal: p, decisions: [], evaluation, actor: ada, csrf: 'c', nonce: 'n', canAct }));

  it('puts the check result and what is still needed together, and the approving sentence by the button', () => {
    const out = render({ ...base, audit: CLEAN_AUDIT, notes: 'Agent note text' }, { ready: false, blockers: [{ message: 'Needs 1 more approval.' }], missing: [{ message: 'Page “X” needs its own look.' }] });
    const strip = out.slice(out.indexOf('class="al-strip"'), out.indexOf('Agent note text'));
    assert.match(strip, /Waiting for review\./);
    assert.match(strip, /Automatic checks passed\./);
    assert.match(strip, /Before this can be added:<\/strong> <ul class="al-strip__list"><li>Needs 1 more approval\.<\/li><li>Page “X” needs its own look\.<\/li>/);
    assert.ok(!/class="al-strip al-strip--fail"/.test(out));
    assert.match(out, /<details class="al-details" open><summary>The agent's notes<\/summary>/);
    const head = out.slice(out.indexOf('<header class="al-reviewhead">'), out.indexOf('</header>', out.indexOf('<header class="al-reviewhead">')));
    assert.match(head, /id="decide">Approving adds it once everything above is in place\./);
    assert.ok(!out.includes("The agent's notes") || out.includes('Agent note text'));
  });

  it('shows a failed or missing check as an alert, with its message and findings', () => {
    const failed = render({ ...base, audit: { exit: 1, errors: 2, warnings: 0, findings: [{ id: 'CITE-002', slug: 'a', message: 'Bad citation' }] } }, { ready: false, blockers: [], missing: [] });
    assert.match(failed, /class="al-strip al-strip--fail" id="needs" role="alert"/);
    assert.match(failed, /Automatic checks found 2 problems\. This can&#39;t be added until they&#39;re fixed\./);
    assert.match(failed, /What the checks found/);
    assert.match(failed, /Bad citation/);
    const none = render({ ...base, audit: null }, { ready: false, blockers: [], missing: [] });
    assert.match(none, /class="al-strip al-strip--fail"/);
    assert.match(none, /The automatic checks have not run yet\./);
  });

  it('keeps the rule sentence when the person cannot approve, and the outcome panels for finished proposals', () => {
    const out = render({ ...base, audit: CLEAN_AUDIT }, { ready: true, blockers: [], missing: [], explanation: 'All set.' }, { ok: false, canReview: false, why: 'Only reviewers can approve.' });
    assert.match(out, /id="decide">Only reviewers can approve\./);
    assert.match(out, /<strong>Ready\.<\/strong> All set\./);
    const merged = render({ ...base, status: 'merged', audit: CLEAN_AUDIT, merge: { at: '2026-11-18T00:00:00Z' } }, { ready: true, blockers: [], missing: [] });
    assert.match(merged, /Added to the knowledge base/);
  });

  it('has no script hook for emphasising words any more', async () => {
    const { c, p } = await serve({ 'brain/wiki/alpha.md': ALPHA_V2 });
    const res = await c.get(`/inbox/p/${p.id}`);
    const script = res.text.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
    assert.ok(!/mouseover|focusin|is-on/.test(script));
    assert.ok(!/has-active/.test(res.text));
  });
});
