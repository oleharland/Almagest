/**
 * Regression tests for the security review of governance:
 *   1. bearer tokens could approve        → only vouched sessions / verified channels act
 *   2. approvals not pinned to what was seen → headSha required and checked everywhere
 *   3. one person counted as two          → identity registry, personKey, SoD by email
 *   4. merge did not constrain paths      → writable set enforced in evaluate() and merge()
 * plus the low items (GitHub delivery dedupe, email link TTL).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { humanActor, registerAuthProvider } from '../../src/core/auth.mjs';
import { createMerger } from '../../src/governance/merge.mjs';
import { outsideFiles, writableMatcher } from '../../src/governance/paths.mjs';
import { evaluate } from '../../src/governance/policy.mjs';
import { verify } from '../../src/governance/signing.mjs';
import { vouch } from '../../src/governance/trust.mjs';
import {
  ada, ALPHA_V2, bob, CLEAN_AUDIT, cleanup, DELTA, G, git, govApp, job, proposalBranch, repo,
} from './fixtures.mjs';

const ENV = { ALMAGEST_TOKENS: 'ada:owner:a-1;bob:reviewer:b-2', ALMAGEST_SECRET_KEY: 'k', T_GH: 'gh', T_SLACK: 'sl' };
const saved = {};
const apps = [];
before(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; } });
after(async () => {
  for (const a of apps) await a.stop().catch(() => {});
  for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  cleanup();
});

async function app(overrides = {}) {
  const a = await govApp(repo(), { overrides });
  apps.push(a);
  return a;
}
async function open(a, files = { 'brain/wiki/alpha.md': ALPHA_V2, 'brain/wiki/delta.md': DELTA }, branch = 'ingest/q3-abcdef1', jobExtra = {}) {
  const b = await proposalBranch(a, branch, files);
  return a.ctx.governance.createFromJob(job(branch, jobExtra), { ...b, audit: CLEAN_AUDIT });
}

describe('1 · bearer tokens never act', () => {
  it('the service refuses actors no session or verified channel vouched for', async () => {
    const a = await app();
    const p = await open(a);
    const gov = a.ctx.governance;
    const plain = humanActor({ id: 'usr_ada', display: 'Ada', roles: ['owner'] });
    const forged = { ...plain, session: { sid: 'made-up' } };          // a session field is not a session
    const spread = { ...ada };                                          // copying a vouched actor drops the vouch
    for (const actor of [plain, forged, spread]) {
      await assert.rejects(() => gov.approve(p.id, actor, { headSha: p.headSha }), /signed-in browser session/);
      await assert.rejects(() => gov.reject(p.id, actor), /signed-in browser session/);
      await assert.rejects(() => gov.rejectPage(p.id, 'delta', actor), /signed-in browser session/);
      await assert.rejects(() => gov.requestChanges(p.id, actor, { feedback: 'x' }), /signed-in browser session/);
      await assert.rejects(() => gov.retryMerge(p.id, actor), /signed-in browser session/);
    }
    // A Slack-verified person may act only through the Slack channel.
    const viaSlack = vouch(humanActor({ id: 'usr_ada', display: 'Ada', roles: ['owner'] }), 'slack');
    await assert.rejects(() => gov.approve(p.id, viaSlack, { headSha: p.headSha, channel: 'web' }), /signed-in browser session/);
    assert.equal((await gov.getProposal(p.id)).approvals.length, 0);
    assert.equal((await gov.approve(p.id, viaSlack, { headSha: p.headSha, channel: 'slack' })).status, 'merged');
  });

  it('decisions too', async () => {
    const a = await app();
    const b = await proposalBranch(a, 'ingest/d-1111111', { 'brain/wiki/delta.md': DELTA });
    const p = await a.ctx.governance.createFromJob(job(b.branch), { ...b, audit: CLEAN_AUDIT, runReport: { blocked: [{ kind: 'low_confidence', slug: 'delta', question: 'Keep?', options: [{ id: 'k', label: 'Keep', effect: 'keep it' }] }] } });
    const [d] = await a.ctx.governance.listDecisions(p.id);
    await assert.rejects(() => a.ctx.governance.resolveDecision(d.id, humanActor({ id: 'usr_ada', roles: ['owner'] }), { optionId: 'k', headSha: p.headSha }), /signed-in browser session/);
  });
});

describe('2 · approvals are pinned to the version shown', () => {
  it('approve and resolveDecision need the current headSha', async () => {
    const a = await app();
    const b = await proposalBranch(a, 'ingest/d-2222222', { 'brain/wiki/delta.md': DELTA });
    const p = await a.ctx.governance.createFromJob(job(b.branch), { ...b, audit: CLEAN_AUDIT, runReport: { blocked: [{ kind: 'low_confidence', slug: 'delta', question: 'Keep?', options: [{ id: 'k', label: 'Keep', effect: 'keep it' }] }] } });
    const gov = a.ctx.governance;
    await assert.rejects(() => gov.approve(p.id, ada), /no headSha/);
    await assert.rejects(() => gov.approve(p.id, ada, { headSha: 'e'.repeat(40) }), (e) => e.status === 409 && e.code === 'stale' && /changed since you opened it/.test(e.message));
    const [d] = await gov.listDecisions(p.id);
    await assert.rejects(() => gov.resolveDecision(d.id, ada, { optionId: 'k' }), /no headSha/);
    await assert.rejects(() => gov.resolveDecision(d.id, ada, { optionId: 'k', headSha: 'e'.repeat(40) }), /changed since you opened it/);
    assert.equal((await gov.resolveDecision(d.id, ada, { optionId: 'k', headSha: p.headSha })).status, 'resolved');
  });

  it('a merged GitHub PR whose head is not the reviewed version is not an approval', async () => {
    const a = await app({ service: { http: { port: 0 } }, governance: { channels: [{ kind: 'web' }, { kind: 'github-pr', repo: 'x/y', webhook_secret_env: 'T_GH', users: { octo: { id: 'usr_ada', email: 'ada@acme.test' } } }] } });
    const server = await a.start();
    const p = await open(a);
    const body = JSON.stringify({ action: 'closed', pull_request: { merged: true, merge_commit_sha: 'f'.repeat(40), head: { ref: p.branch, sha: 'c'.repeat(40) }, merged_by: { login: 'octo' } } });
    const sig = `sha256=${crypto.createHmac('sha256', 'gh').update(body).digest('hex')}`;
    const res = await fetch(`http://127.0.0.1:${server.address().port}/channels/github/webhook`, { method: 'POST', headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': sig, 'x-github-delivery': 'd-1' }, body });
    const out = await res.json();
    assert.equal(out.policyMet, false);
    const after1 = await a.ctx.governance.getProposal(p.id);
    assert.equal(after1.approvals.length, 0, 'no approval recorded for a version nobody reviewed');
    const [v] = await a.ctx.store.audit.list({ action: 'policy.violation' });
    assert.match(v.detail.reason, /GitHub merged version ccccccc, but the reviewed version is/);

    // Low: the same delivery again is a no-op.
    const dup = await fetch(`http://127.0.0.1:${server.address().port}/channels/github/webhook`, { method: 'POST', headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': sig, 'x-github-delivery': 'd-1' }, body });
    assert.deepEqual(await dup.json(), { ok: true, duplicate: true });
    assert.equal((await a.ctx.store.audit.list({ action: 'policy.violation' })).length, 1);
  });

  it('a Slack press for an older version is refused by the service as well as the channel', async () => {
    const a = await app();
    const p = await open(a);
    const viaSlack = vouch(humanActor({ id: 'usr_ada', display: 'Ada', roles: ['owner'] }), 'slack');
    await assert.rejects(() => a.ctx.governance.approve(p.id, viaSlack, { headSha: 'b'.repeat(40), channel: 'slack' }), /changed since you opened it/);
  });
});

describe('3 · one person is one approver', () => {
  it('approvals under two ids with one email count once (policy)', () => {
    const appr = (id, email) => ({ actorId: id, display: id, email, kind: 'human', roles: ['owner'], teams: [], scope: 'all', channel: 'web', headSha: 'h' });
    const p = {
      headSha: 'h', status: 'open', audit: { exit: 0 }, changes: [{ slug: 'a', title: 'A', pageStatus: 'pending', claims: [] }],
      approvals: [appr('usr_sub-1', 'Ada@Acme.test'), appr('usr_ada', 'ada@acme.test')],
      required: { approvals: 2, roles: [], pages: {}, canonical: [] },
    };
    const ev = evaluate({ proposal: p });
    assert.equal(ev.approvers.length, 1);
    assert.equal(ev.ready, false);
    assert.match(ev.explanation, /Needs 1 more approval/);
  });

  it('SoD sees through a second id for the same email (registry)', async () => {
    const a = await app({ governance: { separation_of_duties: true } });
    const reg = a.ctx.governance.identities;
    await reg.remember({ id: 'usr_sub-ada', kind: 'human', email: 'ada@acme.test', display: 'Ada', roles: ['owner'], idp: 'oidc' });
    await reg.remember({ id: 'usr_ada', kind: 'human', email: 'ADA@acme.test', display: 'Ada', roles: ['owner'], idp: 'token' });
    const p = await open(a, undefined, undefined, { requestedBy: 'agent:mcp:claude', onBehalfOf: 'usr_sub-ada' });
    // Same person, other id: refused as the submitter.
    await assert.rejects(() => G(a).approve(p.id, ada), /separation of duties/);
    assert.equal((await G(a).approve(p.id, bob)).status, 'merged');
  });

  it('channel mappings resolve by email; unseen people and missing emails are refused', async () => {
    registerAuthProvider('oidc', () => ({ name: 'oidc', authenticate: async () => null }));   // stands in for core/auth-oidc.mjs
    const oidc = { service: { auth: { provider: 'oidc', oidc: { issuer: 'https://idp.test', client_id: 'c' } } } };
    await assert.rejects(
      () => app({ ...oidc, governance: { channels: [{ kind: 'web' }, { kind: 'slack', users: { U1: { id: 'usr_ada' } } }] } }),
      /needs an email — under single sign-on/,
    );
    await assert.rejects(
      () => app({ governance: { separation_of_duties: true, channels: [{ kind: 'web' }, { kind: 'slack', users: { U1: { id: 'usr_nobody', email: 'n@x' } } }] } }),
      /not in ALMAGEST_TOKENS/,
    );
    await assert.rejects(
      () => app({ governance: { rules: [{ when: {}, require: { approvals: 2 } }], channels: [{ kind: 'web' }, { kind: 'github-pr', users: { octo: { id: 'usr_ada' } } }] } }),
      /needs an email — separation of duties or multi-approval/,
    );

    const a = await app({ ...oidc, governance: { channels: [{ kind: 'web' }] } });
    const reg = a.ctx.governance.identities;
    assert.deepEqual(await reg.resolveMapped({ email: 'ada@acme.test', roles: ['admin'] }, { mode: 'oidc' }), { refused: 'Sign in to the review inbox once with single sign-on to link this account.' });
    await reg.remember({ id: 'usr_sub-ada', kind: 'human', email: 'ada@acme.test', display: 'Ada', roles: ['reviewer'], teams: ['eng'], idp: 'oidc' });
    const { actor } = await reg.resolveMapped({ id: 'usr_handwritten', email: 'Ada@Acme.test', roles: ['admin'] }, { mode: 'oidc' });
    assert.equal(actor.id, 'usr_sub-ada', 'the canonical id, not the one in the mapping');
    assert.deepEqual(actor.roles, ['reviewer'], 'roles from how the person signs in, not from the mapping');
  });
});

describe('4 · proposals may only change the knowledge base', () => {
  const allowed = writableMatcher({ brainDir: 'brain', manifestPath: 'brain/manifest.yaml', challengesPath: 'brain/canonical-challenges.md', indexDir: 'brain/.index' });

  it('the writable set', () => {
    for (const ok of ['brain/wiki/alpha.md', 'brain/raw/extracted/a.pdf.txt', 'brain/raw/extracted/drive/x.txt', 'brain/raw/processed/notes.md',
      'brain/index.md', 'brain/manifest.yaml', 'brain/log.md', 'brain/canonical-challenges.md', 'brain/.index/pages.tsv']) assert.ok(allowed(ok), ok);
    for (const no of ['tools/audit.mjs', 'server/src/app.mjs', 'brain.config.yaml', '.gitattributes', '.github/workflows/x.yml', 'agent/rules/ingest.md',
      'CLAUDE.md', 'brain/wiki/sub/page.md', 'brain/wiki/.hidden.md', 'brain/wiki/page.txt', 'brain/.index/x.json', 'brain/.index/sub/a.tsv',
      'brain/raw/extracted/.gitattributes', 'brain/CLAUDE.md', 'brain/raw/new.pdf']) assert.ok(!allowed(no), no);
    assert.deepEqual(outsideFiles([{ status: 'A', path: 'brain/wiki/l.md', mode: '120000' }], allowed).map((o) => o.reason), ['a symbolic link']);
    assert.deepEqual(outsideFiles([{ status: 'A', path: 'brain/raw/processed/x.pdf', mode: '100644', binary: true }], allowed).map((o) => o.reason), ['a binary file in processed/ (text only)']);
    assert.deepEqual(outsideFiles([{ status: 'R', from: 'tools/a.mjs', path: 'brain/wiki/a.md', mode: '100644' }], allowed).map((o) => o.path), ['tools/a.mjs']);
  });

  it('a proposal touching anything else can never be approved, and is logged', async () => {
    const a = await app();
    const p = await open(a, { 'brain/wiki/delta.md': DELTA, 'tools/audit.mjs': 'process.exit(0)\n', '.gitattributes': '* merge=union\n' });
    assert.deepEqual(p.outside.map((o) => o.path).sort(), ['.gitattributes', 'tools/audit.mjs']);
    const { evaluation } = await a.ctx.governance.evaluate(p.id);
    assert.ok(evaluation.blockers.some((b) => b.code === 'paths' && /outside the knowledge base/.test(b.message)));
    await assert.rejects(() => G(a).approve(p.id, ada), /also changes files outside the knowledge base — it can't be approved/);
    const [entry] = await a.ctx.store.audit.list({ action: 'proposal.blocked_paths' });
    assert.ok(entry.detail.files.some((f) => f.path === 'tools/audit.mjs'));
    assert.equal((await a.ctx.governance.mayApprove(p, ada)).ok, false);
  });

  it('a symlinked wiki page is refused', async () => {
    const a = await app();
    const g = a.ctx.git;
    const wt = await g.worktreeAdd('ingest/link-3333333');
    fs.symlinkSync('../../brain.config.yaml', path.join(wt, 'brain/wiki/link.md'));
    const head = await g.commitAll(wt, { message: 'link', author: { name: 'i', email: 'i@i' } });
    const p = await a.ctx.governance.createFromJob(job('ingest/link-3333333'), { branch: 'ingest/link-3333333', headSha: head, audit: CLEAN_AUDIT });
    assert.deepEqual(p.outside.map((o) => o.reason), ['a symbolic link']);
  });

  it('merge() refuses on its own, even if asked directly', async () => {
    const a = await app();
    const r = a.ctx.repoRoot;
    git(r, 'checkout', '-q', '--detach');
    const b = await proposalBranch(a, 'ingest/evil-4444444', { 'brain/wiki/delta.md': DELTA, 'server/backdoor.mjs': 'x\n' });
    const merger = createMerger({ git: a.ctx.git, config: a.ctx.config, allowed });
    const before1 = git(r, 'rev-parse', 'main').trim();
    const out = await merger.merge({ id: 'prp_x', title: 't', branch: b.branch, headSha: b.headSha, changes: [] }, { approvers: [], author: { name: 'A', email: 'a@a' } });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'paths');
    assert.deepEqual(out.files.map((f) => f.path), ['server/backdoor.mjs']);
    assert.equal(git(r, 'rev-parse', 'main').trim(), before1);
    assert.throws(() => createMerger({ git: a.ctx.git, config: a.ctx.config }), /writable-path matcher/);
  });
});

describe('low', () => {
  it('email links expire after 24 hours by default', async () => {
    const a = await app({ governance: { channels: [{ kind: 'web' }, { kind: 'email', transport: 'http', http: { url: 'http://127.0.0.1:1/x' }, recipients: [{ email: 'ada@acme.test', id: 'usr_ada' }] }] } });
    const email = a.ctx.governance.channel('email');
    const p = await open(a);
    await email.notify('proposal.created', { proposal: p }).catch(() => {});   // the transport is unreachable; the message is kept
    const token = email.sent[0].text.match(/\/inbox\/l\/(\S+)/)[1];
    const v = verify('k', 'email-link', token);
    const hours = (v.exp - Date.now()) / 3600000;
    assert.ok(hours > 23.9 && hours <= 24, String(hours));
  });
});
