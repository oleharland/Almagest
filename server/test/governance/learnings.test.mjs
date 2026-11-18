/**
 * The proposal built from a synthesize job: marked as learnings, titled in
 * plain words, one sentence of explanation, each learning with its Basis as
 * links. And what the service remembers when a person turns one down.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, describe, it } from 'node:test';

import { createRejectedMemory, REJECTED_NS } from '../../src/governance/learnings.mjs';
import { LEARNINGS_EXPLANATION } from '../../src/governance/summary.mjs';
import { proposalPage } from '../../src/governance/web/views.mjs';
import { claimPage, seedFiles, sourcePage } from '../ingest/_synthesis.mjs';
import { ada, bob, CLEAN_AUDIT, cleanup, G, govApp, job, proposalBranch, repo, vic } from './fixtures.mjs';

after(cleanup);

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const NOT_READY = { ready: false, blockers: [], missing: [], explanation: '' };

async function brain(extra = {}) {
  const r = repo({ files: { ...seedFiles(), ...extra } });
  const app = await govApp(r);
  return { r, app, gov: G(app) };
}

/** A learnings proposal the way the runner hands it over: a synthesize job, no source. */
async function learnings(app, pages, { runReport, name = 'abc1234' } = {}) {
  const files = Object.fromEntries(Object.entries(pages).map(([slug, p]) => [`brain/wiki/${slug}.md`, claimPage(p)]));
  const b = await proposalBranch(app, `ingest/learnings-${name}`, files);
  const p = await G(app).createFromJob(job(b.branch, { kind: 'synthesize', source: null, trigger: 'synthesis' }), { ...b, audit: CLEAN_AUDIT, runReport });
  return { ...b, p };
}

const view = (p, actor = ada, canAct = { ok: true, canReview: true, why: '' }) => String(proposalPage({ proposal: p, decisions: [], evaluation: NOT_READY, actor, csrf: 'c', nonce: 'n', canAct }));

describe('governance: a learnings proposal', () => {
  it('is marked, titled in plain words, and has no source file', async () => {
    const { app } = await brain();
    const { p } = await learnings(app, { one: { title: 'Delta and Epsilon retry differently', basis: ['delta', 'epsilon'] } });
    assert.equal(p.kind, 'learnings');
    assert.equal(p.title, '1 thing the brain concluded from what it holds');
    assert.equal(p.status, 'open');
    assert.equal(p.source.kind, 'synthesis');
    assert.match(p.source.id, /^learnings-[0-9a-f]{7}$/);
    assert.equal(p.trigger, 'synthesis');
    assert.match(p.summary, /^1 thing the brain concluded from what it holds/);
    assert.equal(p.changes.length, 1);
    assert.equal(p.changes[0].action, 'create');
    await app.stop();
  });

  it('counts the learnings in the title', async () => {
    const { app } = await brain();
    const { p } = await learnings(app, {
      one: { title: 'Delta and Epsilon retry differently', basis: ['delta', 'epsilon'] },
      two: { title: 'Alpha and Delta agree on retries', basis: ['alpha', 'delta'] },
    });
    assert.equal(p.title, '2 things the brain concluded from what it holds');
    await app.stop();
  });

  it('says what it is in one sentence and links each Basis page', async () => {
    const { app } = await brain();
    const { p } = await learnings(app, { one: { title: 'Delta and Epsilon retry differently', basis: ['epsilon', 'delta'] } });
    assert.deepEqual(p.changes[0].basis, [{ slug: 'delta', title: 'Delta Service' }, { slug: 'epsilon', title: 'Epsilon Service' }]);
    const text = view(p);
    assert.ok(text.includes(LEARNINGS_EXPLANATION), 'the explanation is on the page');
    assert.equal(LEARNINGS_EXPLANATION, 'These are conclusions the brain drew from pages that were already reviewed. Each one lists the pages it rests on, and you can accept or turn down each one on its own.');
    assert.match(text, /<h1>1 thing the brain concluded from what it holds<\/h1>/);
    assert.match(text, /What it rests on/);
    assert.match(text, /<a href="\/inbox\/pages\/delta">Delta Service<\/a>/);
    assert.match(text, /<a href="\/inbox\/pages\/epsilon">Epsilon Service<\/a>/);
    assert.match(text, /Accept page/);
    assert.match(text, /Take this page out/);
    assert.doesNotMatch(text, /No source given for this/);
    assert.doesNotMatch(text, /has no facts the inbox could pair with a source/);
    await app.stop();
  });

  it('shows no learnings explanation on any other proposal', async () => {
    const { app } = await brain();
    const b = await proposalBranch(app, 'ingest/other-0000000', { 'brain/wiki/other.md': sourcePage({ title: 'Other', sourceId: 'beta-pdf' }) });
    const p = await G(app).createFromJob(job(b.branch), { ...b, audit: CLEAN_AUDIT });
    assert.equal(p.kind, undefined);
    assert.ok(!view(p).includes(LEARNINGS_EXPLANATION));
    assert.match(p.title, /^New material from/);
    await app.stop();
  });

  it('escapes what a page says', async () => {
    const { app } = await brain({ 'brain/wiki/zeta.md': sourcePage({ title: 'Zeta <img src=x onerror=alert(1)>', sourceId: 'beta-pdf' }) });
    const { p } = await learnings(app, { evil: { title: 'Zeta <script>alert(2)</script> and Delta', basis: ['zeta', 'delta'] } });
    const text = view(p);
    assert.ok(!text.includes('<img src=x'));
    assert.ok(!text.includes('<script>alert(2)'));
    assert.match(text, /Zeta &lt;img src=x onerror=alert\(1\)&gt;/);
    await app.stop();
  });

  it('with only a question and no page, says so', async () => {
    const { app } = await brain();
    const b = await proposalBranch(app, 'ingest/learnings-def5678', { 'brain/log.md': '# Log\n\n| Date | Action | Details |\n|------|--------|---------|\n| 2026-01-06 | synthesize | two pages disagree |\n' });
    const runReport = { blocked: [{ kind: 'contradiction', slug: 'delta', question: 'Delta says three retries and Epsilon says one.', claimA: 'three', sourceA: 'beta-pdf', claimB: 'one', sourceB: 'gamma-pdf', options: [{ id: 'keep', label: 'Keep both', effect: 'none' }] }] };
    const p = await G(app).createFromJob(job(b.branch, { kind: 'synthesize', source: null, trigger: 'synthesis' }), { ...b, audit: CLEAN_AUDIT, runReport });
    assert.equal(p.kind, 'learnings');
    assert.equal(p.title, 'The brain has a question about what it holds');
    assert.equal((await app.ctx.store.decisions.listByProposal(p.id)).length, 1);
    await app.stop();
  });
});

describe('governance: approving learnings follows the normal policy', () => {
  it('a reviewer approves and the claim page lands on main; a viewer cannot', async () => {
    const { r, app, gov } = await brain();
    const { p } = await learnings(app, { one: { title: 'Delta and Epsilon retry differently', basis: ['delta', 'epsilon'] } });
    // The same requirements as any new curated page: nothing about who may approve changes.
    const b = await proposalBranch(app, 'ingest/other-0000000', { 'brain/wiki/other.md': sourcePage({ title: 'Other', sourceId: 'beta-pdf' }) });
    const ordinary = await G(app).createFromJob(job(b.branch), { ...b, audit: CLEAN_AUDIT });
    assert.deepEqual({ ...p.required, pages: undefined }, { ...ordinary.required, pages: undefined });
    await assert.rejects(() => gov.approve(p.id, vic), /./);
    const done = await gov.approve(p.id, bob);
    assert.equal(done.status, 'merged', done.mergeError?.message);
    assert.match(r && (await app.ctx.git.show('main', 'brain/wiki/one.md')), /type: claim/);
    assert.equal(done.merge.audit.exit, 0);
    await app.stop();
  });

  it('"Ask for changes" queues a revise like any proposal, and the proposal stays learnings', async () => {
    const { app, gov } = await brain();
    const { p } = await learnings(app, { one: { title: 'Delta and Epsilon retry differently', basis: ['delta', 'epsilon'] } });
    const changed = await gov.requestChanges(p.id, ada, { feedback: 'Make the title sharper.' });
    assert.equal(changed.status, 'changes_requested');
    assert.equal(changed.kind, 'learnings');
    const revise = app.ingest.jobs.find((j) => j.kind === 'revise');
    assert.equal(revise.proposalId, p.id);
    assert.match(revise.instructions, /Make the title sharper/);
    await app.stop();
  });
});

describe('governance: remembering what was turned down', () => {
  const memory = (app) => createRejectedMemory({ store: app.ctx.store, git: app.ctx.git, config: app.ctx.config });

  it('a learning taken out of the proposal is remembered by its sorted Basis, its title and each page hash', async () => {
    const { r, app, gov } = await brain();
    const { p } = await learnings(app, {
      one: { title: 'Delta and Epsilon retry differently', basis: ['epsilon', 'delta'] },
      two: { title: 'Alpha and Delta agree on retries', basis: ['alpha', 'delta'] },
    });
    await gov.rejectPage(p.id, 'one', ada);
    const rows = await app.ctx.store.kv.list(REJECTED_NS);
    assert.equal(rows.length, 1, 'only the page that was turned down');
    const rec = rows[0].value;
    assert.deepEqual(rec.basis, ['delta', 'epsilon']);
    assert.equal(rec.title, 'Delta and Epsilon retry differently');
    const onMain = (slug) => app.ctx.git.show('main', `brain/wiki/${slug}.md`);
    assert.deepEqual(rec.hashes, { delta: sha(await onMain('delta')), epsilon: sha(await onMain('epsilon')) });
    assert.ok(rec.at);
    const audit = await app.ctx.store.audit.list({});
    assert.ok(audit.some((a) => a.action === 'learning.turned_down' && a.target === p.id));
    assert.ok(r);
    await app.stop();
  });

  it('turning down the whole proposal remembers every learning still in it, and not one already taken out', async () => {
    const { app, gov } = await brain();
    const { p } = await learnings(app, {
      one: { title: 'Delta and Epsilon retry differently', basis: ['delta', 'epsilon'] },
      two: { title: 'Alpha and Delta agree on retries', basis: ['alpha', 'delta'] },
      three: { title: 'Alpha and Epsilon differ', basis: ['alpha', 'epsilon'] },
    });
    await gov.rejectPage(p.id, 'one', ada);
    await gov.reject(p.id, ada, { reason: 'not useful' });
    const rows = (await app.ctx.store.kv.list(REJECTED_NS)).map((r) => r.value.basis.join('+')).sort();
    assert.deepEqual(rows, ['alpha+delta', 'alpha+epsilon', 'delta+epsilon']);
    await app.stop();
  });

  it('turning down an ordinary proposal remembers nothing', async () => {
    const { app, gov } = await brain();
    const b = await proposalBranch(app, 'ingest/other-0000000', { 'brain/wiki/other.md': sourcePage({ title: 'Other', sourceId: 'beta-pdf' }) });
    const p = await G(app).createFromJob(job(b.branch), { ...b, audit: CLEAN_AUDIT });
    await gov.reject(p.id, ada, {});
    assert.deepEqual(await app.ctx.store.kv.list(REJECTED_NS), []);
    await app.stop();
  });

  it('lists a remembered learning until one of its Basis pages changes', async () => {
    const { app, gov } = await brain();
    const { p } = await learnings(app, { one: { title: 'Delta and Epsilon retry differently', basis: ['delta', 'epsilon'] } });
    await gov.reject(p.id, ada, {});
    const m = memory(app);
    assert.deepEqual((await m.standing()).map((r) => r.title), ['Delta and Epsilon retry differently']);
    assert.ok(await m.blocking(['epsilon', 'delta']), 'the order of the Basis does not matter');
    assert.equal(await m.blocking(['delta', 'alpha']), null, 'a different set is not blocked');

    // The same Basis set returns once a Basis page changed.
    const { execFileSync } = await import('node:child_process');
    const g = (...a) => execFileSync('git', a, { cwd: app.ctx.repoRoot, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } });
    const fs = await import('node:fs');
    fs.writeFileSync(`${app.ctx.repoRoot}/brain/wiki/delta.md`, sourcePage({ title: 'Delta Service', sourceId: 'beta-pdf', body: 'Delta changed.', modified: '2026-02-01' }));
    g('add', '-A');
    g('commit', '-q', '-m', 'delta changed');
    assert.equal(await m.blocking(['delta', 'epsilon']), null);
    assert.deepEqual(await m.standing(), []);
    await app.stop();
  });

  it('a failure to remember never blocks turning something down', async () => {
    const { app, gov } = await brain();
    const { p } = await learnings(app, { one: { title: 'Delta and Epsilon retry differently', basis: ['delta', 'epsilon'] } });
    const real = app.ctx.store.kv.set;
    app.ctx.store.kv.set = async () => { throw new Error('store is read only'); };
    const done = await gov.reject(p.id, ada, {});
    app.ctx.store.kv.set = real;
    assert.equal(done.status, 'rejected');
    await app.stop();
  });
});
