/**
 * Regression tests for end-to-end QA findings: concurrent proposals and the
 * knowledge base's bookkeeping files (F1), the gaps page (F2), new pages with
 * no extractable facts (F8), and the F9 / UX items.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import YAML from 'yaml';

import { isPlaceholderRow, mergeManifest, stripRemovedPlaceholders } from '../../src/governance/bookkeeping.mjs';
import { MAX_CONFLICT_REVISES } from '../../src/governance/service.mjs';
import { dedupeFindings } from '../../src/governance/web/views.mjs';
import { FIXTURES, REPO_ROOT } from '../helpers.mjs';
import { ada, ALPHA_V2, CLEAN_AUDIT, cleanup, client, DELTA, G, git, govApp, job, page, proposalBranch, repo } from './fixtures.mjs';

const REAL_LOG = fs.readFileSync(path.join(REPO_ROOT, 'brain/log.md'), 'utf-8');
const REAL_INDEX = fs.readFileSync(path.join(REPO_ROOT, 'brain/index.md'), 'utf-8');
const REAL_MANIFEST = fs.readFileSync(path.join(REPO_ROOT, 'brain/manifest.yaml'), 'utf-8');
const FIXTURE_MANIFEST = YAML.parse(fs.readFileSync(path.join(FIXTURES, 'clean/brain/manifest.yaml'), 'utf-8'));
const FIXTURE_INDEX = fs.readFileSync(path.join(FIXTURES, 'clean/brain/index.md'), 'utf-8');

const saved = {};
const apps = [];
before(() => { saved.t = process.env.ALMAGEST_TOKENS; process.env.ALMAGEST_TOKENS = 'ada:owner:a-1'; process.env.ALMAGEST_LOGINS = 'ada:ada-signin-1'; process.env.ALMAGEST_SECRET_KEY = 'k'; });
after(async () => {
  for (const a of apps) await a.stop().catch(() => {});
  process.env.ALMAGEST_TOKENS = saved.t;
  delete process.env.ALMAGEST_LOGINS;
  cleanup();
});
async function app(r, overrides = {}, modules = {}) {
  const a = await govApp(r || repo(), { overrides, modules });
  apps.push(a);
  return a;
}

const PLACEHOLDER_LOG = REAL_LOG.match(/^\| _\(no actions yet\)_.*$/m)[0];
const PLACEHOLDER_SRC = REAL_INDEX.match(/^\| _\(no sources yet\)_.*$/m)[0];

describe('F1 · bookkeeping merges (pure)', () => {
  it('recognises the shipped placeholder rows', () => {
    assert.ok(isPlaceholderRow(PLACEHOLDER_LOG));
    assert.ok(isPlaceholderRow(PLACEHOLDER_SRC));
    assert.ok(isPlaceholderRow('| | | | | |'));
    assert.ok(!isPlaceholderRow('| 2026-10-01 | ingest | a |'));
    assert.ok(!isPlaceholderRow('|------|--------|---------|'));
  });

  it('drops a placeholder only when a side replaced it', () => {
    const ours = REAL_LOG.replace(PLACEHOLDER_LOG, '| 2026-10-01 | ingest | a |');
    const theirs = REAL_LOG.replace(PLACEHOLDER_LOG, '| 2026-10-02 | ingest | b |');
    const [b, o, t] = stripRemovedPlaceholders(REAL_LOG, ours, theirs);
    assert.ok(!b.includes(PLACEHOLDER_LOG));
    assert.equal(o, ours);
    assert.equal(t, theirs);
    const [b2] = stripRemovedPlaceholders(REAL_INDEX, REAL_INDEX, REAL_INDEX);
    assert.equal(b2, REAL_INDEX, 'untouched placeholders stay');
  });

  it('merges the shipped manifest template (`sources: []`) from both sides, block style', () => {
    const entry = (id) => ({ id, kind: 'local', path: `brain/raw/processed/${id}.md`, sha256: '0'.repeat(64), pages: [id], status: 'ingested' });
    const ours = REAL_MANIFEST.replace('sources: []', `sources: [${JSON.stringify(entry('a'))}]`);
    const theirs = REAL_MANIFEST.replace('sources: []', `sources: [${JSON.stringify(entry('b'))}]`);
    const merged = mergeManifest(REAL_MANIFEST, ours, theirs);
    const doc = YAML.parse(merged);
    assert.deepEqual(doc.sources.map((s) => s.id), ['a', 'b']);
    assert.equal(doc.version, 1);
    assert.match(merged, /^sources:\n {2}- id: a$/m, 'block style, whatever the input used');
    assert.ok(merged.startsWith('#'), 'the leading comments survive');
  });

  it('same id changed differently on both sides is a real conflict; one-sided changes win', () => {
    const base = YAML.stringify({ version: 1, sources: [{ id: 'x', status: 'ingested' }] });
    const o = YAML.stringify({ version: 1, sources: [{ id: 'x', status: 'missing' }] });
    const t = YAML.stringify({ version: 1, sources: [{ id: 'x', status: 'stale' }] });
    assert.equal(mergeManifest(base, o, t), null);
    assert.equal(YAML.parse(mergeManifest(base, o, base)).sources[0].status, 'missing');
    assert.equal(mergeManifest(base, 'sources: nope', base), null);
    assert.equal(mergeManifest(base, '{', base), null);
  });
});

describe('F1 · two proposals from the same main both merge', () => {
  it('with the real placeholders in log.md and index.md and a flow-style manifest', async () => {
    const flow = `version: 1\n\nsources: [${FIXTURE_MANIFEST.sources.map((s) => JSON.stringify(s)).join(', ')}]\n`;
    const index = FIXTURE_INDEX.replace(/\| `brain\/raw\/extracted\/alpha\.pdf\.txt`.*\n/, `${PLACEHOLDER_SRC}\n`);
    const r = repo({ files: { 'brain/log.md': REAL_LOG, 'brain/index.md': index, 'brain/manifest.yaml': flow } });
    git(r, 'checkout', '-q', '--detach');
    const a = await app(r);

    const side = (slug, title) => {
      const m = YAML.parse(flow);
      // each proposal records its own source — a different id on each side
      m.sources.push({ id: `${slug}-src`, kind: 'local', path: `brain/raw/extracted/${slug}.txt`, sha256: '0'.repeat(64), pages: [], status: 'ingested' });
      return {
        [`brain/raw/extracted/${slug}.txt`]: `=== page 1 ===\n${title}\n`,
        [`brain/wiki/${slug}.md`]: DELTA.replace('title: "Delta"', `title: "${title}"`),
        'brain/log.md': REAL_LOG.replace(PLACEHOLDER_LOG, `| 2026-10-0${slug.length} | ingest | ${slug} |`),
        'brain/index.md': index.replace(PLACEHOLDER_SRC, `| \`brain/raw/extracted/${slug}.txt\` | 2026-10-01 | ${slug} |`)
          .replace('| [[gamma-claim]]', `| [[${slug}]] | topic | curated | draft | 2026-10-01 |\n| [[gamma-claim]]`),
        // flow style, edited in place — the shape that made `--union` emit invalid YAML
        'brain/manifest.yaml': `version: 1\n\nsources: [${m.sources.map((s) => JSON.stringify(s)).join(', ')}]\n`,
      };
    };
    const ba = await proposalBranch(a, 'ingest/a-1111111', side('delta', 'Delta'));
    const pa = await a.ctx.governance.createFromJob(job(ba.branch), { ...ba, audit: CLEAN_AUDIT });
    const bb = await proposalBranch(a, 'ingest/b-2222222', side('epsilon', 'Epsilon'));
    const pb = await a.ctx.governance.createFromJob(job(bb.branch, { source: { kind: 'local', id: 'other', title: 'B' } }), { ...bb, audit: CLEAN_AUDIT });

    assert.equal((await G(a).approve(pa.id, ada)).status, 'merged');
    const second = await G(a).approve(pb.id, ada);
    assert.equal(second.status, 'merged', second.mergeError?.message);
    assert.equal(a.ingest.jobs.filter((j) => j.kind === 'revise').length, 0, 'no revise for bookkeeping');

    const log = git(r, 'show', 'main:brain/log.md');
    for (const s of ['| ingest | delta |', '| ingest | epsilon |', pa.id, pb.id]) assert.ok(log.includes(s), s);
    assert.ok(!log.includes(PLACEHOLDER_LOG), 'the placeholder is gone once real rows exist');
    assert.ok(!/<<<<<<<|>>>>>>>/.test(log));
    const idx = git(r, 'show', 'main:brain/index.md');
    assert.ok(idx.includes('[[delta]]') && idx.includes('[[epsilon]]'));
    assert.ok(idx.includes('brain/raw/extracted/delta.txt') && idx.includes('brain/raw/extracted/epsilon.txt'));
    const man = YAML.parse(git(r, 'show', 'main:brain/manifest.yaml'));
    assert.deepEqual(man.sources.map((s) => s.id), ['alpha-pdf', 'delta-src', 'epsilon-src']);
    assert.ok(!git(r, 'show', 'main:brain/manifest.yaml').includes('[{'), 'rewritten in block style');
  });
});

describe('F1 · conflict-driven revisions are capped', () => {
  it('one per reviewed version, at most MAX_CONFLICT_REVISES, then a person', async () => {
    const r = repo();
    git(r, 'checkout', '-q', '--detach');
    const a = await app(r);
    const b1 = await proposalBranch(a, 'ingest/c-5555555', { 'brain/wiki/alpha.md': ALPHA_V2 });
    let p = await a.ctx.governance.createFromJob(job(b1.branch), { ...b1, audit: CLEAN_AUDIT });
    const mainWt = await a.ctx.git.worktreeAdd('main');
    fs.writeFileSync(path.join(mainWt, 'brain/wiki/alpha.md'), ALPHA_V2.replace('45-second', '60-second'));
    await a.ctx.git.commitAll(mainWt, { message: 'human edit', author: { name: 'H', email: 'h@h' } });
    await a.ctx.git.worktreeRemove(mainWt);
    const revises = () => a.ingest.jobs.filter((j) => j.kind === 'revise').length;

    p = await G(a).approve(p.id, ada);
    assert.equal(p.status, 'conflicted');
    assert.match(p.mergeError.message, /changed while this waited/);
    assert.equal(revises(), 1);
    // The same version shown again (e.g. a no-op refresh) and approved again: no second job.
    await a.ctx.governance.createFromJob(job(p.branch), { branch: p.branch, headSha: p.headSha, baseSha: p.baseSha, audit: CLEAN_AUDIT });
    const again = await G(a).approve(p.id, ada);
    assert.equal(revises(), 1);
    assert.match(again.mergeError.message, /already redoing it/);

    for (let i = 2; i <= MAX_CONFLICT_REVISES + 1; i++) {
      // the agent "revises" but still clashes
      const bi = await proposalBranch(a, again.branch, { 'brain/wiki/alpha.md': ALPHA_V2.replace('45-second', `4${i}-second`) });
      await a.ctx.governance.createFromJob({ ...job(again.branch), kind: 'revise', proposalId: again.id, reason: 'conflict' }, { ...bi, baseSha: again.baseSha, audit: CLEAN_AUDIT });
      const out = await G(a).approve(again.id, ada);
      assert.equal(out.status, 'conflicted');
      if (i <= MAX_CONFLICT_REVISES) assert.equal(revises(), i);
      else {
        assert.equal(revises(), MAX_CONFLICT_REVISES);
        assert.match(out.mergeError.message, /needs a person/);
      }
    }
  });
});

describe('F2 · gaps page with the real telemetry shape', () => {
  it('shows the representative question and query texts, not [object Object]', async () => {
    const telemetry = {
      create: async (ctx) => {
        ctx.demand = { get: async (s) => new Map(s.map((x) => [x, { score: 0, rank: 0, hot: false }])), hot: async () => [] };
        return {
          record() {}, reverifyQueue: async () => [], explain: async () => null,
          gaps: async () => [{ cluster: 'gap_0123456789ab', representative: 'what is the retry ceiling', tokens: ['retry', 'ceiling'], queries: [{ text: 'what is the retry ceiling', count: 3 }, { text: 'retry max', count: 1 }], count: 4, distinctSessions: 2, firstSeen: '2026-10-01T00:00:00Z', lastSeen: '2026-10-19T00:00:00Z', suggestion: 'No page covers "what is the retry ceiling" — consider submitting a source.' }],
        };
      },
    };
    const a = await app(null, { service: { http: { port: 0 } } }, { telemetry });
    const server = await a.start();
    const base = `http://127.0.0.1:${server.address().port}`;
    const c = client(base);
    const lp = await c.get('/inbox/login');
    await c.post('/inbox/login', { form: { csrf: c.csrfFrom(lp.text), secret: 'ada-signin-1' } });
    const res = await c.get('/inbox/gaps');
    assert.ok(!res.text.includes('[object Object]'));
    assert.ok(!res.text.includes('gap_0123456789ab'));
    assert.match(res.text, /<strong>what is the retry ceiling<\/strong>/);
    assert.match(res.text, /“retry max”/);
    assert.match(res.text, /by 2 people/);
  });
});

describe('F8, F9 and UX', () => {
  it('a new page with no extractable facts asks for a careful read and shows the page', async () => {
    const a = await app();
    const body = '## Details [source: alpha-pdf, p.1]\n\nSome prose without a citation.';
    const b = await proposalBranch(a, 'ingest/h-6666666', { 'brain/wiki/heady.md': page({ title: 'Heady', body }) });
    const p = await a.ctx.governance.createFromJob(job(b.branch), { ...b, audit: CLEAN_AUDIT });
    assert.equal(p.changes[0].needsManualLook, true);
    assert.match(p.changes[0].preview, /Some prose without a citation/);
    assert.match(p.summary, /A new page with no cited facts \(Heady\) — needs a careful read/);
    assert.ok(!/Small edits/.test(p.summary));
  });

  it('a proposal whose only page was taken out cannot be approved', async () => {
    const a = await app();
    const b = await proposalBranch(a, 'ingest/e-7777777', { 'brain/wiki/delta.md': DELTA });
    const p = await a.ctx.governance.createFromJob(job(b.branch), { ...b, audit: CLEAN_AUDIT });
    await a.ctx.governance.rejectPage(p.id, 'delta', ada);
    // the drop-page job removes the page, and the proposal is rebuilt with nothing in it
    const b2 = await proposalBranch(a, b.branch, { 'brain/wiki/delta.md': null });
    const empty = await a.ctx.governance.createFromJob({ ...job(b.branch), kind: 'drop-page', proposalId: p.id }, { ...b2, baseSha: p.baseSha, audit: CLEAN_AUDIT });
    assert.equal(empty.changes.length, 0);
    const { evaluation } = await a.ctx.governance.evaluate(p.id);
    assert.ok(evaluation.blockers.some((x) => x.code === 'empty'));
    await assert.rejects(() => G(a).approve(p.id, ada), /Nothing is left to add/);
    assert.equal((await a.ctx.governance.reject(p.id, ada)).status, 'rejected', 'it can still be closed');
  });

  it('turned-down and superseded proposals leave no worktree or branch behind', async () => {
    const r = repo();
    const a = await app(r);
    const b = await proposalBranch(a, 'ingest/q3-1111111', { 'brain/wiki/delta.md': DELTA });
    const p = await a.ctx.governance.createFromJob(job(b.branch), { ...b, audit: CLEAN_AUDIT });
    const b2 = await proposalBranch(a, 'ingest/q3-2222222', { 'brain/wiki/delta.md': DELTA });
    const p2 = await a.ctx.governance.createFromJob(job(b2.branch), { ...b2, audit: CLEAN_AUDIT });
    assert.equal((await a.ctx.governance.getProposal(p.id)).status, 'superseded');
    assert.equal(await a.ctx.git.worktreeFor(p.branch), null);
    assert.equal(await a.ctx.git.branchExists(p.branch), false);
    await a.ctx.governance.reject(p2.id, ada);
    assert.equal(await a.ctx.git.worktreeFor(p2.branch), null);
    assert.equal(await a.ctx.git.branchExists(p2.branch), false);

    const keep = await app(repo(), { governance: { keep_closed_branches: true } });
    const b3 = await proposalBranch(keep, 'ingest/k-3333333', { 'brain/wiki/delta.md': DELTA });
    const p3 = await keep.ctx.governance.createFromJob(job(b3.branch), { ...b3, audit: CLEAN_AUDIT });
    await keep.ctx.governance.reject(p3.id, ada);
    assert.equal(await keep.ctx.git.branchExists(p3.branch), true);
    assert.equal(await keep.ctx.git.worktreeFor(p3.branch), null);
  });

  it('identical audit findings are shown once, with a count', () => {
    const f = { id: 'LINK-002', severity: 'warning', slug: 'delta', message: '0 backlinks' };
    const out = dedupeFindings([f, { ...f }, { ...f, slug: 'x' }]);
    assert.equal(out.length, 2);
    assert.equal(out[0].count, 2);
  });

  it('decision cards name sources by title; lapsed approvals are named in the status', async () => {
    const a = await app(null, { service: { http: { port: 0 } } });
    const server = await a.start();
    const base = `http://127.0.0.1:${server.address().port}`;
    const b = await proposalBranch(a, 'ingest/u-8888888', { 'brain/wiki/alpha.md': ALPHA_V2 });
    const p = await a.ctx.governance.createFromJob(job(b.branch), { ...b, audit: { exit: 0, errors: 0, warnings: 1, findings: [{ id: 'LINK-002', severity: 'warning', slug: 'alpha', message: '0 backlinks' }] },
      runReport: { blocked: [{ kind: 'contradiction', slug: 'alpha', question: '30 or 45?', claimA: '30 s', sourceA: 'alpha-pdf, p.3', claimB: '45 s', sourceB: 'alpha-pdf, p.1', options: [{ id: 'x', label: 'Use 45', effect: 'e' }] }] } });
    const c = client(base);
    const lp = await c.get('/inbox/login');
    await c.post('/inbox/login', { form: { csrf: c.csrfFrom(lp.text), secret: 'ada-signin-1' } });
    let res = await c.get(`/inbox/p/${p.id}`);
    assert.match(res.text, /Source: Alpha System Overview, page 3/);
    assert.ok(!res.text.includes('Source: alpha-pdf, p.3'));
    assert.match(res.text, /<summary>See the notes<\/summary>/, 'checks passed with notes → expandable');

    // An approval for an earlier version is named in the main status.
    await a.ctx.store.proposals.update(p.id, { approvals: [{ actorId: 'usr_bob', display: 'Bob', kind: 'human', roles: ['reviewer'], scope: 'all', channel: 'web', headSha: 'old' }] });
    res = await c.get(`/inbox/p/${p.id}`);
    assert.match(res.text, /Bob&#39;s approval was for the earlier version and no longer counts/);
  });
});
