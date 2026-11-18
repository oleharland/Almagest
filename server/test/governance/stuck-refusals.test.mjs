/**
 * Two refusals that used to leave a proposal approved and unmergeable with a
 * message that did not say what to do.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

process.env.ALMAGEST_TOKENS = 'ada:owner:ada-api-0;bob:reviewer:bob-api-0;olga:owner:olga-api-0';

const { tierOfText } = await import('../../../tools/lib/canonical.mjs');
const { humanActor } = await import('../../src/core/auth.mjs');
const { proposalPage } = await import('../../src/governance/web/views.mjs');
const { ada, bob, CLEAN_AUDIT, cleanup, G, git, govApp, job, page, proposalBranch, repo, sess } = await import('./fixtures.mjs');

const olga = sess(humanActor({ id: 'usr_olga', display: 'Olga', email: 'olga@acme.test', roles: ['owner'] }));
after(cleanup);

const show = (r, ref, file) => git(r, 'show', `${ref}:${file}`);
const NOT_READY = { ready: false, blockers: [], missing: [], explanation: '' };
const view = (p, actor = ada) => String(proposalPage({ proposal: p, decisions: [], evaluation: NOT_READY, actor, csrf: 'c', nonce: 'n', canAct: { ok: true, canReview: true, why: '' } }));

async function openOn(app, branch, files, sha) {
  const b = await proposalBranch(app, branch, files);
  return { ...b, p: await G(app).createFromJob(job(branch, { source: { kind: 'local', id: branch, title: branch, sha256: sha } }), { ...b, audit: CLEAN_AUDIT, runReport: { pages: [] } }) };
}

const body = (summary, details) => `## Summary\n\n${summary} [source: alpha-pdf, p.1]\n\n## Details\n\n${details} [source: alpha-pdf, p.1]`;
const BASE = page({ title: 'Gamma', tier: 'curated', body: body('Gamma is safe to use.', 'Gamma rests on the Alpha overview.') });
const SUMMARY_CHANGED = page({ title: 'Gamma', tier: 'curated', body: body('Gamma is safe to use in production.', 'Gamma rests on the Alpha overview.') });
const DETAILS_CHANGED = page({ title: 'Gamma', tier: 'curated', body: body('Gamma is safe to use.', 'Gamma rests on the Alpha overview and a second review.') });

describe('a tier proposal refused because the page changed', () => {
  async function stale() {
    const r = repo({ files: { 'brain/wiki/gamma.md': BASE } });
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r, { overrides: { governance: { separation_of_duties: true } } });
    const gov = G(app);
    const tp = await gov.proposeTier('gamma', 'canonical', ada, { confirm: true });
    const c = await openOn(app, 'ingest/c-3333333', { 'brain/wiki/gamma.md': DETAILS_CHANGED }, '3333333c');
    assert.equal((await gov.approve(c.p.id, bob)).status, 'merged');
    return { r, app, gov, tp };
  }

  it('is marked as one that can no longer merge, and says what to do in a plain sentence', async () => {
    const { app, gov, tp } = await stale();
    const rt = await gov.approve(tp.id, olga);
    assert.equal(rt.status, 'conflicted', 'it must not stay approved');
    assert.equal(rt.mergeError.reason, 'tier');
    assert.equal(rt.mergeError.message, 'The page changed since this was proposed, so the tier change has to be proposed again.');
    assert.equal(rt.mergeError.slug, 'gamma');
    await app.stop();
  });

  it('the inbox links to the page', async () => {
    const { app, gov, tp } = await stale();
    const rt = await gov.approve(tp.id, olga);
    const text = view(rt);
    assert.match(text, /changed since this was proposed/);
    assert.match(text, /<a href="\/inbox\/pages\/gamma">[^<]+<\/a>/);
    await app.stop();
  });

  it('does not stop the person from proposing the change again', async () => {
    const { r, app, gov, tp } = await stale();
    await gov.approve(tp.id, olga);
    const again = await gov.proposeTier('gamma', 'canonical', ada, { confirm: true });
    assert.notEqual(again.id, tp.id);
    assert.equal(again.kind, 'tier');
    assert.notEqual(again.status, 'conflicted');
    assert.equal(tierOfText(show(r, 'main', 'brain/wiki/gamma.md')), 'curated', 'nothing became canonical on its own');
    await app.stop();
  });
});

describe('a page a person set to canonical inside an ordinary proposal, changed on main since', () => {
  it('is refused with a message that says what happened and what to do', async () => {
    const r = repo({ files: { 'brain/wiki/gamma.md': BASE } });
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r);
    const gov = G(app);
    const one = await openOn(app, 'ingest/s-1111111', { 'brain/wiki/gamma.md': SUMMARY_CHANGED }, '1111111a');
    const two = await openOn(app, 'ingest/d-2222222', { 'brain/wiki/gamma.md': DETAILS_CHANGED }, '2222222b');
    await gov.setPageTier(one.p.id, 'gamma', 'canonical', ada, { headSha: one.headSha, confirm: true });
    assert.equal((await gov.approve(two.p.id, bob)).status, 'merged');
    const done = await gov.approve(one.p.id, ada);
    assert.notEqual(done.status, 'merged');
    const msg = done.mergeError?.message || '';
    assert.doesNotMatch(msg, /no person chose|without a person choosing/);
    assert.match(msg, /changed on main after you set (its|the) tier/);
    assert.match(msg, /ask for the proposal to be redone and set the tier again/i);
    assert.match(msg, /gamma/);
    assert.notEqual(tierOfText(show(r, 'main', 'brain/wiki/gamma.md')), 'canonical');
    await app.stop();
  });
});
