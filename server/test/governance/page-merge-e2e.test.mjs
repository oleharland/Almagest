/**
 * Two proposals from the same main that both write one page: when the first
 * is approved the second no longer clashes, because the service combines the
 * two pages (governance/page-merge.mjs). Anything it cannot combine provably
 * falls to the conflict revise path, as before.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createMerger } from '../../src/governance/merge.mjs';
import { mergePages, parsePage } from '../../src/governance/page-merge.mjs';
import { writableMatcher } from '../../src/governance/paths.mjs';
import { proposalPage } from '../../src/governance/web/views.mjs';
import { AUDIT } from '../helpers.mjs';
import { ada, CLEAN_AUDIT, cleanup, G, git, govApp, job, proposalBranch, repo, repos } from './fixtures.mjs';

after(cleanup);

const SIDECAR_B = '=== page 1 ===\nMorning Brew audience\n\n=== page 2 ===\nMorning Brew funding\n';
const SHA_B = crypto.createHash('sha256').update(SIDECAR_B).digest('hex');
const SHA_A = '3b50e003ca81fc8afceca1f8d8a259adfd2a3940144e429640ee160e4f8677d9';

const MANIFEST = `version: 1

sources:
  - id: alpha-pdf
    kind: local
    path: brain/raw/processed/alpha.pdf
    sha256: 1111111111111111111111111111111111111111111111111111111111111111
    extracted: brain/raw/extracted/alpha.pdf.txt
    extracted_sha256: ${SHA_A}
    bytes: 1024
    first_ingested: 2026-01-01
    last_ingested: 2026-01-01
    pages:
      - alpha
      - beta
    status: ingested
  - id: beta-pdf
    kind: local
    path: brain/raw/processed/beta.pdf
    sha256: 2222222222222222222222222222222222222222222222222222222222222222
    extracted: brain/raw/extracted/beta.pdf.txt
    extracted_sha256: ${SHA_B}
    bytes: 2048
    first_ingested: 2026-01-01
    last_ingested: 2026-01-01
    pages:
      - alpha
    status: ingested
`;

const INDEX = fs.readFileSync(new URL('../../../tools/lib/__fixtures__/clean/brain/index.md', import.meta.url), 'utf8')
  .replace('| `brain/raw/extracted/alpha.pdf.txt` | 2026-01-01 | alpha, beta |', '| `brain/raw/extracted/alpha.pdf.txt` | 2026-01-01 | alpha, beta |\n| `brain/raw/extracted/beta.pdf.txt` | 2026-01-01 | alpha |');

const seed = () => repo({ files: { 'brain/manifest.yaml': MANIFEST, 'brain/index.md': INDEX, 'brain/raw/extracted/beta.pdf.txt': SIDECAR_B } });

const SRC = {
  a: `  - id: alpha-pdf\n    path: brain/raw/extracted/alpha.pdf.txt\n    sha256: "${SHA_A}"\n    title: "Alpha System Overview"`,
  b: `  - id: beta-pdf\n    path: brain/raw/extracted/beta.pdf.txt\n    sha256: "${SHA_B}"\n    title: "Beta overview"`,
};

function mb({ src = 'a', body, confidence = 'medium', alias = 'Brew' }) {
  return `---
title: "Morning Brew"
type: topic
tier: evidence
origin: source
status: draft
confidence: ${confidence}
tags: []
aliases: ["${alias}"]
owner: ""
date_created: "2026-01-0${src === 'a' ? 4 : 2}"
date_modified: "2026-01-0${src === 'a' ? 5 : 6}"
last_verified: "2026-01-0${src === 'a' ? 5 : 6}"
sources:
${SRC[src]}
related: []
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on: []
---

${body}
`;
}

const PAGE_A = mb({ src: 'a', body: `## Summary

Morning Brew is a daily business newsletter.

## Details

Morning Brew was founded in 2015. [source: alpha-pdf, p.1]` });

const PAGE_B = mb({ src: 'b', alias: 'MB', body: `## Audience

Most readers are young professionals. [source: beta-pdf, p.1]

## Funding

Morning Brew was acquired in 2020. [source: beta-pdf, p.2]` });

const EXT = (p) => ({ source: { id: 'beta-pdf' }, outcome: 'written', pages: [], extends: [{ slug: 'morningbrew', proposalId: p.id, title: p.title }] });

async function open(app, branch, files, { source, runReport } = {}) {
  const b = await proposalBranch(app, branch, files);
  const p = await G(app).createFromJob(job(branch, { source: source || { kind: 'local', id: branch, title: branch, sha256: 'abcdef1234' } }), { ...b, audit: CLEAN_AUDIT, runReport });
  return { ...b, p };
}

async function twoProposals(opts = {}) {
  const r = seed();
  git(r, 'checkout', '-q', '--detach');
  const app = await govApp(r);
  const a = await open(app, 'ingest/a-1111111', { 'brain/wiki/morningbrew.md': opts.a || PAGE_A }, { source: { kind: 'local', id: 'alpha-pdf', title: 'Alpha deck', sha256: 'aaaaaaa1' } });
  const b = await open(app, 'ingest/b-2222222', { 'brain/wiki/morningbrew.md': opts.b || PAGE_B }, {
    source: { kind: 'local', id: 'beta-pdf', title: 'Beta deck', sha256: 'bbbbbbb2' },
    runReport: opts.extends === false ? undefined : EXT(a.p),
  });
  return { r, app, gov: G(app), a, b };
}

const show = (r, ref, file) => git(r, 'show', `${ref}:${file}`);
const revises = (app) => app.ingest.jobs.filter((j) => j.kind === 'revise');

describe('governance: two proposals that write the same page', () => {
  it('stores the pages a proposal extends, with the other proposal\'s title', async () => {
    const { app, a, b } = await twoProposals();
    assert.deepEqual(b.p.extends, [{ slug: 'morningbrew', proposalId: a.p.id, title: a.p.title }]);
    assert.deepEqual(a.p.extends, []);
    await app.stop();
  });

  it('the second one is combined with the first without an agent: one page, both sets of claims and both sources', async () => {
    const { r, app, gov, a, b } = await twoProposals();
    assert.equal((await gov.approve(a.p.id, ada)).status, 'merged');
    const out = await gov.approve(b.p.id, ada);
    assert.equal(out.status, 'merged', out.mergeError?.message);
    assert.equal(revises(app).length, 0, 'no revise job was queued');

    const page = show(r, 'main', 'brain/wiki/morningbrew.md');
    for (const s of ['daily business newsletter', 'founded in 2015', 'young professionals', 'acquired in 2020', 'id: alpha-pdf', 'id: beta-pdf']) assert.ok(page.includes(s), s);
    assert.equal(page.match(/^## Summary$/gm).length, 1);
    assert.deepEqual([...page.matchAll(/^## (.*)$/gm)].map((m) => m[1]), ['Summary', 'Details', 'Audience', 'Funding']);
    assert.match(page, /aliases:\n  - "?Brew"?\n  - "?MB"?|aliases: \["Brew", "MB"\]/);
    assert.match(page, /date_created: "2026-01-02"/);
    assert.match(page, /date_modified: "2026-01-06"/);

    assert.equal(out.merge.audit.exit, 0, JSON.stringify(out.merge.audit.findings));
    assert.deepEqual(out.merge.combined, ['morningbrew']);
    const logMd = show(r, 'main', 'brain/log.md');
    assert.match(logMd, new RegExp(`\\| merge \\| ${b.p.id} .*pages: morningbrew; combined with what was already there: morningbrew \\|`));
    assert.doesNotMatch(logMd, new RegExp(`${a.p.id}.*combined with`));
    const [entry] = (await app.ctx.store.audit.list({ action: 'proposal.merge' })).filter((e) => e.target === b.p.id);
    assert.deepEqual(entry.detail.combined, ['morningbrew']);
    // The result is still two parents, main and the reviewed head.
    const parents = git(r, 'log', '-1', '--format=%P', 'main').trim().split(' ');
    assert.equal(parents[1], b.headSha);
    await app.stop();
  });

  it('approved in the opposite order, the result holds the same claims and sources', async () => {
    const { r, app, gov, a, b } = await twoProposals();
    assert.equal((await gov.approve(b.p.id, ada)).status, 'merged');
    const out = await gov.approve(a.p.id, ada);
    assert.equal(out.status, 'merged', out.mergeError?.message);
    assert.equal(revises(app).length, 0);
    const page = show(r, 'main', 'brain/wiki/morningbrew.md');
    for (const s of ['daily business newsletter', 'founded in 2015', 'young professionals', 'acquired in 2020', 'id: alpha-pdf', 'id: beta-pdf']) assert.ok(page.includes(s), s);
    assert.deepEqual([...page.matchAll(/^## (.*)$/gm)].map((m) => m[1]).sort(), ['Audience', 'Details', 'Funding', 'Summary']);
    assert.equal(out.merge.audit.exit, 0, JSON.stringify(out.merge.audit.findings));
    assert.deepEqual(out.merge.combined, ['morningbrew']);
    await app.stop();
  });

  it('without extends, sections that differ fall to the revise path as before', async () => {
    const b = mb({ src: 'b', body: `## Details

Morning Brew was founded in 2014. [source: beta-pdf, p.1]` });
    const { r, app, gov, a, b: pb } = await twoProposals({ b, extends: false });
    assert.equal((await gov.approve(a.p.id, ada)).status, 'merged');
    const before = git(r, 'rev-parse', 'main').trim();
    const out = await gov.approve(pb.p.id, ada);
    assert.equal(out.status, 'conflicted');
    assert.deepEqual(out.mergeError.files, ['brain/wiki/morningbrew.md']);
    assert.equal(git(r, 'rev-parse', 'main').trim(), before, 'main did not move');
    assert.equal(revises(app).length, 1);
    assert.equal(revises(app)[0].reason, 'conflict');
    await app.stop();
  });

  it('extends does not make a clash combinable: a section both sides wrote differently still goes to the revise path', async () => {
    const b = mb({ src: 'b', body: `## Details

Morning Brew was founded in 2014. [source: beta-pdf, p.1]` });
    const { r, app, gov, a, b: pb } = await twoProposals({ b });
    assert.equal(pb.p.extends.length, 1, 'the proposal does say it extends the page');
    await gov.approve(a.p.id, ada);
    const before = git(r, 'rev-parse', 'main').trim();
    const out = await gov.approve(pb.p.id, ada);
    assert.equal(out.status, 'conflicted');
    assert.equal(git(r, 'rev-parse', 'main').trim(), before);
    assert.equal(revises(app).length, 1);
    await app.stop();
  });

  it('a frontmatter field that differs with no way to tell which changed is a clash, with or without extends', async () => {
    const b = mb({ src: 'b', confidence: 'low', body: '## Audience\n\nYoung readers. [source: beta-pdf, p.1]' });
    for (const withExtends of [false, true]) {
      const t = await twoProposals({ b, extends: withExtends ? undefined : false });
      await t.gov.approve(t.a.p.id, ada);
      const before = git(t.r, 'rev-parse', 'main').trim();
      assert.equal((await t.gov.approve(t.b.p.id, ada)).status, 'conflicted');
      assert.equal(git(t.r, 'rev-parse', 'main').trim(), before);
      assert.match(show(t.r, 'main', 'brain/wiki/morningbrew.md'), /confidence: medium/);
      await t.app.stop();
    }
  });

  it('an update that leaves the reviewed version as it is cannot change what the proposal extends', async () => {
    const { app, gov, a, b } = await twoProposals();
    assert.equal(b.p.extends.length, 1);
    // A revise run that commits nothing reports something else: the reviewed version is the same, so the list is too.
    const run = (extendsList) => G(app).createFromJob(job('ingest/b-2222222', { source: b.p.source }), {
      branch: 'ingest/b-2222222', headSha: b.headSha, baseSha: b.baseSha, audit: CLEAN_AUDIT,
      runReport: { source: { id: 'beta-pdf' }, outcome: 'written', pages: [], extends: extendsList },
    });
    assert.deepEqual((await run([])).extends, b.p.extends);
    assert.deepEqual((await gov.getProposal(b.p.id)).extends, b.p.extends);
    assert.deepEqual((await run([{ slug: 'morningbrew', proposalId: a.p.id, title: 'x' }, { slug: 'other', proposalId: a.p.id, title: 'y' }])).extends, b.p.extends);
    await app.stop();
  });

  it('the same source id pointing at a different file is never combined', async () => {
    const b = PAGE_B.replace('id: beta-pdf', 'id: alpha-pdf');   // beta's file under alpha's id
    const { r, app, gov, a, b: pb } = await twoProposals({ b });
    await gov.approve(a.p.id, ada);
    const out = await gov.approve(pb.p.id, ada);
    assert.equal(out.status, 'conflicted');
    assert.equal(revises(app).length, 1);
    assert.doesNotMatch(show(r, 'main', 'brain/wiki/morningbrew.md'), /young professionals/);
    await app.stop();
  });

  it('a canonical page is never combined, whether the config or the page itself says so', async () => {
    const approvers = [{ display: 'Ada', actorId: 'usr_ada', channel: 'web' }];
    const author = { name: 'Ada', email: 'ada@acme.test' };
    const attempt = async (setup) => {
      const t = await twoProposals(setup.pages || {});
      if (setup.onMain) {
        // A person edited the page on main directly; it is locked by its own tier field.
        const wt = await t.app.ctx.git.worktreeAdd('main');
        fs.writeFileSync(path.join(wt, 'brain/wiki/morningbrew.md'), setup.onMain);
        await t.app.ctx.git.commitAll(wt, { message: 'human edit', author: { name: 'H', email: 'h@h' } });
        await t.app.ctx.git.worktreeRemove(wt);
      } else await t.gov.approve(t.a.p.id, ada);
      const { config, git: g, log } = t.app.ctx;
      const cfg = { ...config, v1: { ...config.v1, canonicalPages: setup.canonical || [] } };
      const merger = createMerger({
        git: g, config: cfg, log,
        allowed: writableMatcher({ brainDir: config.v1.brainDir, manifestPath: config.v1.manifestPath, challengesPath: config.v1.challengesPath, indexDir: config.v1.indexDir }),
      });
      const before = git(t.r, 'rev-parse', 'main').trim();
      const out = await merger.merge(await t.gov.getProposal(t.b.p.id), { approvers, author });
      if (!out.ok) assert.equal(git(t.r, 'rev-parse', 'main').trim(), before);
      await t.app.stop();
      return out;
    };
    const named = await attempt({ canonical: ['morningbrew'] });
    assert.equal(named.ok, false);
    assert.equal(named.reason, 'canonical');   // refused before any combining: the merge itself now checks the canonical set
    const tiered = await attempt({ onMain: PAGE_A.replace('tier: evidence', 'tier: canonical'), pages: { b: PAGE_B.replace('tier: evidence', 'tier: canonical') } });
    assert.equal(tiered.ok, false);
    assert.equal(tiered.reason, 'canonical');
    const normal = await attempt({});
    assert.equal(normal.ok, true, normal.message);
  });

  it('the merged proposal says which page was combined, and the open one says it adds to another', async () => {
    const { app, gov, a, b } = await twoProposals();
    const view = (p, evaluation) => String(proposalPage({
      proposal: p, decisions: [], evaluation, actor: ada, csrf: 'c', nonce: 'n', canAct: { ok: true, canReview: true, why: '' },
    }));
    const open = await gov.getProposal(b.p.id);
    const text = view(open, { ready: false, blockers: [], missing: [], explanation: '' });
    assert.match(text, /This page adds to one that is waiting in another proposal, <a href="\/inbox\/p\/prp_[^"]+">New material from “Alpha deck”<\/a>\. When both are approved, the service combines the two versions section by section\. If they disagree anywhere, the agent is asked to redo this page on top of what is already there\./);
    assert.doesNotMatch(String(proposalPage({ proposal: a.p, decisions: [], evaluation: { ready: false, blockers: [], missing: [], explanation: '' }, actor: ada, csrf: 'c', nonce: 'n', canAct: { ok: true, canReview: true, why: '' } })), /waiting in another proposal/);
    await gov.approve(a.p.id, ada);
    const done = await gov.approve(b.p.id, ada);
    const merged = String(proposalPage({ proposal: done, decisions: [], evaluation: { ready: false, blockers: [], missing: [], explanation: '' }, actor: ada, csrf: 'c', nonce: 'n', canAct: { ok: false, canReview: false, why: '' } }));
    assert.match(merged, /1 page \(morningbrew\) was combined with what was already there, section by section\./);
    await app.stop();
  });

  it('escapes the other proposal\'s title', async () => {
    const { app, gov, b } = await twoProposals();
    const evil = { ...(await gov.getProposal(b.p.id)), extends: [{ slug: 'morningbrew', proposalId: 'prp_x"><script>', title: '<img src=x onerror=alert(1)>' }] };
    const text = String(proposalPage({ proposal: evil, decisions: [], evaluation: { ready: false, blockers: [], missing: [], explanation: '' }, actor: ada, csrf: 'c', nonce: 'n', canAct: { ok: true, canReview: true, why: '' } }));
    assert.ok(!text.includes('<img src=x'));
    assert.ok(!text.includes('<script>'));
    await app.stop();
  });
});

describe('governance: a removal approved on main stays removed', () => {
  const BASE = mb({ src: 'a', alias: 'Brew', body: `## Details

Morning Brew was founded in 2015. [source: alpha-pdf, p.1]
Its office is in New York. [source: alpha-pdf, p.1]
It is sent on weekdays. [source: alpha-pdf, p.1]
It is free to read. [source: alpha-pdf, p.1]
It was sold in 2020. [source: alpha-pdf, p.1]` });
  // Main's reviewer approved taking out the 2020 sale and the alias.
  const REMOVES = BASE.replace('\nIt was sold in 2020. [source: alpha-pdf, p.1]', '').replace('aliases: ["Brew"]', 'aliases: []');
  // The other proposal started from the same page, still has both, and adds a line and an alias.
  const ADDS = BASE.replace('founded in 2015. [source: alpha-pdf, p.1]', 'founded in 2015. [source: alpha-pdf, p.1]\nIt has 50 staff. [source: alpha-pdf, p.1]').replace('aliases: ["Brew"]', 'aliases: ["Brew", "MB"]');

  async function both(head) {
    const r = repo({ files: { 'brain/manifest.yaml': MANIFEST, 'brain/index.md': INDEX, 'brain/raw/extracted/beta.pdf.txt': SIDECAR_B, 'brain/wiki/morningbrew.md': BASE } });
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r);
    const a = await open(app, 'ingest/a-1111111', { 'brain/wiki/morningbrew.md': REMOVES });
    const b = await open(app, 'ingest/b-2222222', { 'brain/wiki/morningbrew.md': head });
    return { r, app, gov: G(app), a, b };
  }

  it('the removed line and alias do not come back when the other proposal still has them', async () => {
    const { r, app, gov, a, b } = await both(ADDS);
    assert.equal((await gov.approve(a.p.id, ada)).status, 'merged');
    const out = await gov.approve(b.p.id, ada);
    assert.equal(out.status, 'merged', out.mergeError?.message);
    assert.equal(revises(app).length, 0);
    const page = show(r, 'main', 'brain/wiki/morningbrew.md');
    assert.match(page, /It has 50 staff\./);
    assert.doesNotMatch(page, /sold in 2020/);
    assert.deepEqual(parsePage(page).data.aliases, ['MB']);
    await app.stop();
  });

  it('the gate every new main passes refuses a commit that brings the removed line back', async () => {
    const { r, app, gov, a, b } = await both(ADDS);
    assert.equal((await gov.approve(a.p.id, ada)).status, 'merged');
    const { config, git: g, log } = app.ctx;
    const merger = createMerger({ git: g, config, log, allowed: writableMatcher({ brainDir: config.v1.brainDir, manifestPath: config.v1.manifestPath, challengesPath: config.v1.challengesPath, indexDir: config.v1.indexDir }) });
    const mainSha = git(r, 'rev-parse', 'main').trim();
    const base = git(r, 'merge-base', mainSha, b.headSha).trim();
    // Every line is in one of the two versions, but the sale was removed on main and is back.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-back-'));
    repos.push(dir);
    git(r, 'worktree', 'add', '-q', '--detach', dir, 'main');
    try { git(dir, 'merge', '-q', '--no-ff', '--no-commit', b.headSha); } catch { /* the clash is the point */ }
    fs.writeFileSync(path.join(dir, 'brain/wiki/morningbrew.md'), ADDS);
    execFileSync(process.execPath, [AUDIT, 'index', '--no-color', '--repo', dir]);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'merged by hand');
    const sha = git(dir, 'rev-parse', 'HEAD').trim();
    git(r, 'worktree', 'remove', '--force', dir);
    const out = await merger.acceptExternal(await gov.getProposal(b.p.id), sha);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'content');
    assert.equal(git(r, 'rev-parse', 'main').trim(), mainSha);
    assert.ok(base);
    await app.stop();
  });
});

describe('governance: a merge commit made outside the service', () => {
  /** A merge commit on main + head, made by hand in a throwaway checkout, with `edit` applied to the clashing page. */
  function handMerge(r, headSha, edit) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-hand-'));
    repos.push(dir);
    git(r, 'worktree', 'add', '-q', '--detach', dir, 'main');
    try { git(dir, 'merge', '-q', '--no-ff', '--no-commit', headSha); } catch { /* the clash is the point */ }
    edit(dir);
    // Whoever merges by hand brings the derived index up to date, as the audit requires.
    execFileSync(process.execPath, [AUDIT, 'index', '--no-color', '--repo', dir]);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'merged by hand');
    const sha = git(dir, 'rev-parse', 'HEAD').trim();
    git(r, 'worktree', 'remove', '--force', dir);
    return sha;
  }

  async function setup() {
    const t = await twoProposals();
    assert.equal((await t.gov.approve(t.a.p.id, ada)).status, 'merged');
    const { config, git: g, log } = t.app.ctx;
    const merger = createMerger({
      git: g, config, log,
      allowed: writableMatcher({ brainDir: config.v1.brainDir, manifestPath: config.v1.manifestPath, challengesPath: config.v1.challengesPath, indexDir: config.v1.indexDir }),
    });
    const p = await t.gov.getProposal(t.b.p.id);
    const expected = await mergePages({ base: null, ours: show(t.r, 'main', 'brain/wiki/morningbrew.md'), theirs: PAGE_B });
    assert.equal(expected.ok, true, expected.reason);
    return { ...t, merger, p, expected: expected.text };
  }

  const write = (dir, text) => fs.writeFileSync(path.join(dir, 'brain/wiki/morningbrew.md'), text);

  it('is accepted when the clashing page is exactly what the service would have produced', async () => {
    const t = await setup();
    const sha = handMerge(t.r, t.p.headSha, (dir) => write(dir, t.expected));
    const out = await t.merger.acceptExternal(t.p, sha);
    assert.equal(out.ok, true, out.message);
    assert.equal(git(t.r, 'rev-parse', 'main').trim(), sha);
    await t.app.stop();
  });

  it('is refused when one line of the combined page was reworded', async () => {
    const t = await setup();
    const before = git(t.r, 'rev-parse', 'main').trim();
    const sha = handMerge(t.r, t.p.headSha, (dir) => write(dir, t.expected.replace('acquired in 2020', 'acquired in 2021')));
    const out = await t.merger.acceptExternal(t.p, sha);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'content');
    assert.deepEqual(out.files.map((f) => f.path), ['brain/wiki/morningbrew.md']);
    assert.equal(git(t.r, 'rev-parse', 'main').trim(), before);
    await t.app.stop();
  });

  it('is refused when it keeps only the proposal\'s page, even though every line is one of the two versions', async () => {
    const t = await setup();
    const before = git(t.r, 'rev-parse', 'main').trim();
    const sha = handMerge(t.r, t.p.headSha, (dir) => write(dir, PAGE_B));
    const out = await t.merger.acceptExternal(t.p, sha);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'content');
    assert.equal(git(t.r, 'rev-parse', 'main').trim(), before);
    await t.app.stop();
  });

  it('is refused when the combined page also has a line that is in neither version', async () => {
    const t = await setup();
    const sha = handMerge(t.r, t.p.headSha, (dir) => write(dir, `${t.expected}\nAn extra claim nobody reviewed.\n`));
    const out = await t.merger.acceptExternal(t.p, sha);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'content');
    await t.app.stop();
  });

  it('the gate every new main passes recomputes the invariant itself: a line from neither version is refused there too', async () => {
    const t = await setup();
    const mainSha = git(t.r, 'rev-parse', 'main').trim();
    const base = git(t.r, 'merge-base', mainSha, t.p.headSha).trim();
    const args = (parents) => ({ mainSha, base, head: t.p.headSha, parents, message: 'm', author: { name: 'Ada', email: 'ada@acme.test' }, proposalId: t.p.id });
    const good = handMerge(t.r, t.p.headSha, (dir) => write(dir, t.expected));
    const [m, h] = git(t.r, 'rev-list', '--parents', '-n', '1', good).trim().split(' ').slice(1);
    assert.equal((await t.merger.verifyCandidate(good, args([m, h]))).ok, true);
    const bad = handMerge(t.r, t.p.headSha, (dir) => write(dir, t.expected.replace('acquired in 2020', 'acquired in 2021')));
    const out = await t.merger.verifyCandidate(bad, args([m, h]));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'content');
    assert.match(out.files[0].reason, /in neither version/);
    assert.equal(git(t.r, 'rev-parse', 'main').trim(), mainSha, 'verifying never moves main');
    await t.app.stop();
  });

  it('gains nothing for a clash the service cannot combine: still refused', async () => {
    const b = mb({ src: 'b', body: '## Details\n\nMorning Brew was founded in 2014. [source: beta-pdf, p.1]' });
    const t = await twoProposals({ b, extends: false });
    await t.gov.approve(t.a.p.id, ada);
    const { config, git: g, log } = t.app.ctx;
    const merger = createMerger({
      git: g, config, log,
      allowed: writableMatcher({ brainDir: config.v1.brainDir, manifestPath: config.v1.manifestPath, challengesPath: config.v1.challengesPath, indexDir: config.v1.indexDir }),
    });
    const p = await t.gov.getProposal(t.b.p.id);
    const sha = handMerge(t.r, p.headSha, (dir) => write(dir, show(t.r, 'main', 'brain/wiki/morningbrew.md')));
    const out = await merger.acceptExternal(p, sha);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'content');
    assert.match(out.message, /clashes/);
    await t.app.stop();
  });
});
