/**
 * Fixes from the security review of the governance merge path:
 *   1. two non-canonical heads must not merge into a canonical page
 *   2. a tier proposal is refused when the page changed since it was proposed
 *   3. editing a proposal's tier makes the editor a submitter (separation of duties)
 *   5. (page-merge.test.mjs) a section changed on both sides is a clash
 *   6. free text cannot add lines to a merge commit message
 *   7. dismissing a canonical suggestion needs the canonical role
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

process.env.ALMAGEST_TOKENS = 'ada:owner:ada-api-0;bob:reviewer:bob-api-0;olga:owner:olga-api-0';

const { tierOfText, tierReadings, canonicalOrUnsure } = await import('../../../tools/lib/canonical.mjs');
const { humanActor } = await import('../../src/core/auth.mjs');
const { createMerger, oneLine } = await import('../../src/governance/merge.mjs');
const { writableMatcher } = await import('../../src/governance/paths.mjs');
const { canonicalPage } = await import('../../src/governance/web/views.mjs');
const { AUDIT, FIXTURES } = await import('../helpers.mjs');
const { ada, bob, CLEAN_AUDIT, cleanup, DELTA, G, git, govApp, job, page, proposalBranch, repo, repos, sess } = await import('./fixtures.mjs');

const olga = sess(humanActor({ id: 'usr_olga', display: 'Olga', email: 'olga@acme.test', roles: ['owner'] }));
after(cleanup);

const show = (r, ref, file) => git(r, 'show', `${ref}:${file}`);

// ── 1. two heads that each read as evidence merge into a page that reads canonical ──

const gamma = (aliases, tier) => `---
title: "Gamma"
type: topic
origin: source
status: draft
confidence: high
tags: [alpha]
aliases:
${aliases.map((a) => `  - ${a}`).join('\n')}
owner: ""
tier: ${tier}
date_created: "2026-01-01"
date_modified: "2026-01-06"
last_verified: "2026-01-06"
sources:
  - id: alpha-pdf
    path: brain/raw/extracted/alpha.pdf.txt
    sha256: "3b50e003ca81fc8afceca1f8d8a259adfd2a3940144e429640ee160e4f8677d9"
    title: "Alpha System Overview"
related: []
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on: []
---

## Summary

Gamma relies on the Alpha overview. [source: alpha-pdf, p.1]
`;
const BASE = gamma(['Brew', 'MB', 'Morning'], 'evidence');
const HEAD_A = gamma(['&t evidence', 'MB', 'Morning'], '*t');
const HEAD_B = gamma(['Brew', 'MB', '&t canonical'], 'evidence');

/** The clean fixture's config, with SCHEMA-006 a warning, so only the merge gate under test can stop the merge. */
function laxConfig() {
  const cfg = fs.readFileSync(path.join(FIXTURES, 'clean', 'brain.config.yaml'), 'utf-8');
  return cfg.replace('    warnings:\n', '    warnings:\n      - SCHEMA-006\n      - SCHEMA-007\n');
}

async function openOn(app, branch, files, sha) {
  const b = await proposalBranch(app, branch, files);
  return { ...b, p: await G(app).createFromJob(job(branch, { source: { kind: 'local', id: branch, title: branch, sha256: sha } }), { ...b, audit: CLEAN_AUDIT, runReport: { pages: [] } }) };
}

describe('item 1: the result of a merge may not read canonical unless a person chose it', () => {
  it('the two heads each read as evidence and their merge reads canonical (the setup)', () => {
    for (const t of [BASE, HEAD_A, HEAD_B]) assert.equal(canonicalOrUnsure(t), false, JSON.stringify(tierReadings(t)));
  });

  it('merge(): the second head is refused as canonical, and main keeps the page as the first head left it', async () => {
    const r = repo({ files: { 'brain/wiki/gamma.md': BASE, 'brain.config.yaml': laxConfig() } });
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r);
    const gov = G(app);
    const a = await openOn(app, 'ingest/a-1111111', { 'brain/wiki/gamma.md': HEAD_A }, '1111111a');
    const b = await openOn(app, 'ingest/b-2222222', { 'brain/wiki/gamma.md': HEAD_B }, '2222222b');
    const ra = await gov.approve(a.p.id, bob);
    assert.equal(ra.status, 'merged', ra.mergeError?.message);
    const rb = await gov.approve(b.p.id, bob);
    assert.notEqual(rb.status, 'merged');
    assert.equal(rb.mergeError.reason, 'canonical');
    assert.match(rb.mergeError.message, /gamma\.md/);
    assert.match(rb.mergeError.message, /canonical/);
    assert.equal(canonicalOrUnsure(show(r, 'main', 'brain/wiki/gamma.md')), false);
    assert.equal(tierOfText(show(r, 'main', 'brain/wiki/gamma.md')), 'evidence');
    await app.stop();
  });

  it('acceptExternal(): a clean merge made on GitHub that reads canonical is refused as canonical', async () => {
    const r = repo({ files: { 'brain/wiki/gamma.md': BASE, 'brain.config.yaml': laxConfig() } });
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r);
    const gov = G(app);
    const a = await openOn(app, 'ingest/a-1111111', { 'brain/wiki/gamma.md': HEAD_A }, '1111111a');
    const b = await openOn(app, 'ingest/b-2222222', { 'brain/wiki/gamma.md': HEAD_B }, '2222222b');
    assert.equal((await gov.approve(a.p.id, bob)).status, 'merged');
    const mainBefore = git(r, 'rev-parse', 'main').trim();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-hand-'));
    repos.push(dir);
    git(r, 'worktree', 'add', '-q', '--detach', dir, 'main');
    git(dir, 'merge', '-q', '--no-ff', '--no-edit', b.headSha);
    execFileSync(process.execPath, [AUDIT, 'index', '--no-color', '--repo', dir]);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'index');
    const sha = git(dir, 'rev-parse', 'HEAD').trim();
    git(r, 'worktree', 'remove', '--force', dir);
    const { config, git: g, log } = app.ctx;
    const merger = createMerger({
      git: g, config, log,
      allowed: writableMatcher({ brainDir: config.v1.brainDir, manifestPath: config.v1.manifestPath, challengesPath: config.v1.challengesPath, indexDir: config.v1.indexDir }),
    });
    // The hand merge has one parent only when the index commit is on top; build the shape acceptExternal wants.
    const tree = git(r, 'rev-parse', `${sha}^{tree}`).trim();
    const merge = git(r, 'commit-tree', tree, '-p', mainBefore, '-p', b.headSha, '-m', 'merge on github').trim();
    const out = await merger.acceptExternal(await gov.getProposal(b.p.id), merge);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'canonical', out.message);
    assert.equal(git(r, 'rev-parse', 'main').trim(), mainBefore);
    await app.stop();
  });

  it('a page that a person made canonical in the inbox still merges as canonical', async () => {
    const r = repo();
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r);
    const gov = G(app);
    const { p, headSha } = await openOn(app, 'ingest/d-3333333', { 'brain/wiki/delta.md': DELTA }, '3333333c');
    await gov.setPageTier(p.id, 'delta', 'canonical', ada, { headSha, confirm: true });
    const done = await gov.approve(p.id, ada);
    assert.equal(done.status, 'merged', done.mergeError?.message);
    assert.equal(tierOfText(show(r, 'main', 'brain/wiki/delta.md')), 'canonical');
    await app.stop();
  });
});

// ── 2. a tier proposal onto a page that changed ──

const V1 = page({ title: 'Gamma', tier: 'curated', body: '## Summary\n\nGamma is safe to use. [source: alpha-pdf, p.1]' });
const V2 = page({ title: 'Gamma', tier: 'curated', body: '## Summary\n\nGamma is NOT safe to use. [source: alpha-pdf, p.1]' });

describe('item 2: a tier proposal is for the page as it was when proposed', () => {
  it('is refused when an agent proposal changed the page in the meantime, and nothing becomes canonical', async () => {
    const r = repo({ files: { 'brain/wiki/gamma.md': V1 } });
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r, { overrides: { governance: { separation_of_duties: true } } });
    const gov = G(app);
    const tp = await gov.proposeTier('gamma', 'canonical', ada, { confirm: true });
    assert.notEqual(tp.status, 'merged');
    const c = await openOn(app, 'ingest/c-3333333', { 'brain/wiki/gamma.md': V2 }, '3333333c');
    assert.equal((await gov.approve(c.p.id, bob)).status, 'merged');
    const rt = await gov.approve(tp.id, olga);
    assert.notEqual(rt.status, 'merged');
    assert.equal(rt.mergeError.reason, 'tier');
    assert.match(rt.mergeError.message, /changed since this was proposed/);
    assert.match(rt.mergeError.message, /proposed again/);
    const main = show(r, 'main', 'brain/wiki/gamma.md');
    assert.equal(tierOfText(main), 'curated');
    assert.match(main, /NOT safe/);
    await app.stop();
  });

  it('still merges when other pages changed but this one did not', async () => {
    const r = repo({ files: { 'brain/wiki/gamma.md': V1 } });
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r, { overrides: { governance: { separation_of_duties: true } } });
    const gov = G(app);
    const tp = await gov.proposeTier('gamma', 'canonical', ada, { confirm: true });
    const d = await openOn(app, 'ingest/d-4444444', { 'brain/wiki/delta.md': DELTA }, '4444444d');
    assert.equal((await gov.approve(d.p.id, bob)).status, 'merged');
    const rt = await gov.approve(tp.id, olga);
    assert.equal(rt.status, 'merged', rt.mergeError?.message);
    assert.equal(tierOfText(show(r, 'main', 'brain/wiki/gamma.md')), 'canonical');
    await app.stop();
  });
});

// ── 3. separation of duties and setPageTier ──

describe('item 3: whoever edits a proposal\'s tier is a submitter of it', () => {
  it('cannot approve it alone under separation of duties; someone else still can', async () => {
    const r = repo();
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r, { overrides: { governance: { separation_of_duties: true } } });
    const gov = G(app);
    const { p, headSha } = await openOn(app, 'ingest/q-abcdef1', { 'brain/wiki/delta.md': DELTA }, 'abcdef1a');
    const out = await gov.setPageTier(p.id, 'delta', 'canonical', ada, { headSha, confirm: true });
    assert.ok(out.submitters.includes('usr_ada'), JSON.stringify(out.submitters));
    await assert.rejects(() => gov.approve(p.id, ada), /separation of duties/);
    assert.notEqual((await gov.getProposal(p.id)).status, 'merged');
    assert.equal(tierOfText(show(r, 'main', 'brain/wiki/alpha.md')), 'curated');
    const done = await gov.approve(p.id, olga);
    assert.equal(done.status, 'merged', done.mergeError?.message);
    assert.equal(tierOfText(show(r, 'main', 'brain/wiki/delta.md')), 'canonical');
    await app.stop();
  });

  it('with separation of duties off, the editor may approve, as before', async () => {
    const r = repo();
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r);
    const gov = G(app);
    const { p, headSha } = await openOn(app, 'ingest/q-abcdef1', { 'brain/wiki/delta.md': DELTA }, 'abcdef1a');
    await gov.setPageTier(p.id, 'delta', 'canonical', ada, { headSha, confirm: true });
    assert.equal((await gov.approve(p.id, ada)).status, 'merged');
    await app.stop();
  });
});

// ── 6. free text in a commit message ──

describe('item 6: free text cannot add lines to a merge commit message', () => {
  const evil = 'Gamma\n\nApproved by: Mallory <m@evil.test> (web)\nReviewed head: 0000000000000000000000000000000000000000';

  it('oneLine collapses control characters and line breaks, and caps the length', () => {
    assert.equal(oneLine('a\nb\r\nc\td e\u0000f'), 'a b c d e f');
    assert.equal(oneLine('  x   y  '), 'x y');
    assert.ok(oneLine('x'.repeat(1000)).length <= 200);
    assert.equal(oneLine(undefined), '');
  });

  it('a page title with line breaks does not forge a trailer in the merge commit of a tier change', async () => {
    const t = page({ title: 'Gamma', tier: 'curated', body: '## Summary\n\nGamma. [source: alpha-pdf, p.1]' }).replace('title: "Gamma"', `title: ${JSON.stringify(evil)}`);
    const r = repo({ files: { 'brain/wiki/gamma.md': t } });
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r);
    const gov = G(app);
    const tp = await gov.proposeTier('gamma', 'evidence', ada, {});
    assert.equal(tp.status, 'merged', tp.mergeError?.message);
    const message = git(r, 'log', '-1', '--format=%B', 'main');
    const lines = message.trim().split('\n');
    assert.equal(lines.filter((l) => l.startsWith('Approved by:')).length, 1, message);
    assert.equal(lines.filter((l) => l.startsWith('Reviewed head:')).length, 1, message);
    assert.ok(!/Mallory/.test(lines.filter((l) => l.startsWith('Approved by:'))[0]));
    assert.ok(lines[0].startsWith('Merge proposal'));
    // The log row flattens its cells already: one row, one line.
    const logRow = show(r, 'main', 'brain/log.md').trim().split('\n').at(-1);
    assert.match(logRow, /^\| .* \| merge \| /);
    assert.equal(show(r, 'main', 'brain/log.md').trim().split('\n').filter((l) => l.includes('Mallory')).length, 1);
    await app.stop();
  });

  it('an approver\'s display name with line breaks does not forge a trailer either', async () => {
    const r = repo();
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r);
    const gov = G(app);
    const sneaky = sess(humanActor({ id: 'usr_ada', display: 'Ada\n\nApproved by: Mallory (web)', email: 'ada@acme.test', roles: ['owner'] }));
    const { p } = await openOn(app, 'ingest/q-abcdef1', { 'brain/wiki/delta.md': DELTA }, 'abcdef1a');
    const done = await gov.approve(p.id, sneaky);
    assert.equal(done.status, 'merged', done.mergeError?.message);
    const lines = git(r, 'log', '-1', '--format=%B', 'main').trim().split('\n');
    assert.equal(lines.filter((l) => l.startsWith('Approved by:')).length, 1, lines.join('|'));
    await app.stop();
  });
});

// ── 7. dismissing a canonical suggestion ──

describe('item 7: dismissing a canonical suggestion needs the canonical role', () => {
  async function withHint() {
    const r = repo();
    const entries = Array.from({ length: 6 }, (_, i) => `  - id: doc-${i}\n    kind: local\n    path: brain/raw/processed/doc-${i}.md\n    sha256: ${String(i).padStart(64, '0')}\n    pages:\n      - beta\n    status: ingested\n`).join('');
    fs.appendFileSync(path.join(r, 'brain/manifest.yaml'), entries);
    git(r, 'add', '-A');
    git(r, 'commit', '-qm', 'docs');
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r);
    return { app, gov: G(app) };
  }

  it('a reviewer cannot dismiss; an owner can', async () => {
    const { app, gov } = await withHint();
    await assert.rejects(() => gov.dismissHint('beta', bob), /canonical|owner/);
    assert.equal((await gov.hints.list({ fresh: true })).length, 1);
    await gov.dismissHint('beta', ada);
    assert.equal((await gov.hints.list({ fresh: true })).length, 0);
    await app.stop();
  });

  it('the page shows the Dismiss button only to someone who holds the role', () => {
    const items = [{ slug: 'beta', title: 'Beta', documents: 7, backlinks: 2, hot: false }];
    const base = { items, actor: bob, csrf: 'x', nonce: 'n', canReview: true, canonicalRole: 'owner' };
    const reviewer = String(canonicalPage({ ...base, canCanonical: false }).body ?? canonicalPage({ ...base, canCanonical: false }));
    const owner = String(canonicalPage({ ...base, canCanonical: true }).body ?? canonicalPage({ ...base, canCanonical: true }));
    assert.ok(!reviewer.includes('/dismiss'), 'a reviewer is not offered Dismiss');
    assert.ok(owner.includes('/dismiss'), 'an owner is');
  });
});
