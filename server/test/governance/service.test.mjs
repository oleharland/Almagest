import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { agentActor } from '../../src/core/auth.mjs';
import {
  ada, ALPHA_V2, bob, CLEAN_AUDIT, cleanup, DELTA, git, govApp, job, page, proposalBranch, repo, vic,
} from './fixtures.mjs';

after(cleanup);

const show = (r, ref, file) => git(r, 'show', `${ref}:${file}`);

async function openProposal(app, branch = 'ingest/q3-board-deck-abcdef1', files = { 'brain/wiki/alpha.md': ALPHA_V2, 'brain/wiki/delta.md': DELTA }, extra = {}) {
  const b = await proposalBranch(app, branch, files);
  const p = await app.ctx.governance.createFromJob(job(branch, extra.job), { ...b, audit: CLEAN_AUDIT, runReport: extra.runReport || { source: { id: 'alpha-pdf' }, outcome: 'written', pages: [] } });
  return { ...b, p };
}

describe('governance: happy path', () => {
  it('createFromJob → approve → main moves with a two-parent merge authored by the approver', async () => {
    const r = repo();
    git(r, 'checkout', '-q', '--detach');               // main checked out nowhere → update-ref path
    const app = await govApp(r);
    const gov = app.ctx.governance;
    const created = app.ctx.bus.waitFor('proposal.created');
    const merged = app.ctx.bus.waitFor('proposal.merged');
    const { p, headSha } = await openProposal(app);
    await created;

    assert.equal(p.status, 'open');
    assert.equal(p.title, 'New material from “Q3 board deck”');
    assert.match(p.summary, /1 new fact.*1 updated fact|updated fact/);
    assert.equal(p.changes.length, 2);
    assert.equal(p.required.approvals, 1);
    assert.equal((await gov.listProposals({ status: 'open' })).length, 1);

    const before = git(r, 'rev-parse', 'main').trim();
    const out = await gov.approve(p.id, ada, { scope: 'all', channel: 'web' });
    assert.equal(out.status, 'merged', out.mergeError?.message);
    await merged;

    const sha = git(r, 'rev-parse', 'main').trim();
    assert.equal(out.merge.sha, sha);
    assert.notEqual(sha, before);
    const parents = git(r, 'log', '-1', '--format=%P', sha).trim().split(' ');
    assert.deepEqual(parents, [before, headSha]);
    assert.equal(git(r, 'log', '-1', '--format=%an <%ae>', sha).trim(), 'Ada <ada@acme.test>');
    assert.equal(git(r, 'log', '-1', '--format=%cn', sha).trim(), 'governance');
    assert.match(git(r, 'log', '-1', '--format=%B', sha), new RegExp(`${p.id}[\\s\\S]*Reviewed head: ${headSha}`));
    const logMd = show(r, sha, 'brain/log.md');
    assert.match(logMd, new RegExp(`\\| merge \\| ${p.id} .*approved by Ada \\(web\\); reviewed ${headSha.slice(0, 7)}; pages: alpha, delta`));
    assert.equal(show(r, sha, 'brain/wiki/delta.md'), DELTA);
    // re-audit ran on the merge result
    assert.equal(out.merge.audit.exit, 0);
    assert.equal(out.merge.method, 'update-ref');
    // cleaned up: the ingest worktree is gone
    assert.equal(await app.ctx.git.worktreeFor('ingest/q3-board-deck-abcdef1'), null);

    const audit = await app.ctx.store.audit.list({});
    assert.deepEqual(audit.map((a) => a.action), ['proposal.create', 'proposal.approve', 'proposal.merge']);
    assert.equal(audit[1].actorId, 'usr_ada');
    assert.equal(audit[1].detail.headSha, headSha);
    await app.stop();
  });

  it('fast-forwards inside the worktree that has main checked out', async () => {
    const r = repo();
    const app = await govApp(r);
    const { p } = await openProposal(app);
    const out = await app.ctx.governance.approve(p.id, ada);
    assert.equal(out.status, 'merged', out.mergeError?.message);
    assert.equal(out.merge.method, 'ff-only');
    assert.equal(git(r, 'rev-parse', 'HEAD').trim(), out.merge.sha);
    assert.equal(fs.readFileSync(path.join(r, 'brain/wiki/delta.md'), 'utf-8'), DELTA);
    assert.equal(git(r, 'status', '--porcelain').trim(), '');
    await app.stop();
  });

  it('refuses to move a checked-out main whose edits would be overwritten, and retries later', async () => {
    const r = repo();
    const app = await govApp(r);
    const { p } = await openProposal(app);
    fs.writeFileSync(path.join(r, 'brain/wiki/alpha.md'), 'my unsaved edit\n');
    const before = git(r, 'rev-parse', 'main').trim();
    const out = await app.ctx.governance.approve(p.id, ada);
    assert.equal(out.status, 'approved');
    assert.equal(out.mergeError.reason, 'checkout');
    assert.match(out.mergeError.message, /unsaved edits/);
    assert.equal(git(r, 'rev-parse', 'main').trim(), before);
    git(r, 'checkout', '--', 'brain/wiki/alpha.md');
    const again = await app.ctx.governance.retryMerge(p.id, ada);
    assert.equal(again.status, 'merged');
    await app.stop();
  });

  it('merges a second proposal even though both appended to log.md (union of appends)', async () => {
    const r = repo({ files: { 'brain/log.md': '# Log\n\n| Date | Action | Details |\n|---|---|---|\n' } });
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r);
    const a = await openProposal(app, 'ingest/a-1111111', { 'brain/wiki/delta.md': DELTA, 'brain/log.md': '# Log\n\n| Date | Action | Details |\n|---|---|---|\n| 2026-10-01 | ingest | a |\n' });
    const b = await openProposal(app, 'ingest/b-2222222', { 'brain/wiki/alpha.md': ALPHA_V2, 'brain/log.md': '# Log\n\n| Date | Action | Details |\n|---|---|---|\n| 2026-10-02 | ingest | b |\n' }, { job: { source: { kind: 'local', id: 'other', title: 'B' } } });
    assert.equal((await app.ctx.governance.approve(a.p.id, ada)).status, 'merged');
    const second = await app.ctx.governance.approve(b.p.id, ada);
    assert.equal(second.status, 'merged', second.mergeError?.message);
    const log = show(r, 'main', 'brain/log.md');
    for (const s of ['| ingest | a |', '| ingest | b |', a.p.id, b.p.id]) assert.ok(log.includes(s), s);
    assert.ok(!log.includes('<<<<<<<'));
    await app.stop();
  });
});

describe('governance: pinning, conflicts, the audit gate', () => {
  it('an approval stops counting when the branch gets a new head (upsert by branch)', async () => {
    const r = repo();
    const app = await govApp(r, { overrides: { governance: { rules: [{ when: {}, require: { approvals: 2 } }] } } });
    const gov = app.ctx.governance;
    const { p } = await openProposal(app);
    await gov.approve(p.id, ada);
    assert.equal((await gov.evaluate(p.id)).evaluation.approvers.length, 1);

    // A revise job commits on the same branch and calls createFromJob again.
    const b2 = await proposalBranch(app, p.branch, { 'brain/wiki/delta.md': DELTA.replace('Delta is new.', 'Delta is newer.') });
    const updated = await gov.createFromJob({ ...job(p.branch), kind: 'revise', proposalId: p.id }, { ...b2, baseSha: p.baseSha, audit: CLEAN_AUDIT });
    assert.equal(updated.id, p.id);
    assert.equal(updated.revision, 2);
    assert.equal(updated.approvals.length, 1, 'recorded approvals are kept');
    const ev = (await gov.evaluate(p.id)).evaluation;
    assert.equal(ev.approvers.length, 0, '… but no longer count');
    await gov.approve(p.id, bob);
    const done = await gov.approve(p.id, ada);
    assert.equal(done.status, 'merged');
    await app.stop();
  });

  it('a conflict marks the proposal conflicted and asks the agent to revise', async () => {
    const r = repo();
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r);
    const { p } = await openProposal(app);
    // main moves under the proposal, touching the same lines of alpha.md
    const mainWt = await app.ctx.git.worktreeAdd('main');
    fs.writeFileSync(path.join(mainWt, 'brain/wiki/alpha.md'), ALPHA_V2.replace('45-second', '60-second'));
    await app.ctx.git.commitAll(mainWt, { message: 'human edit', author: { name: 'H', email: 'h@h' } });
    await app.ctx.git.worktreeRemove(mainWt);
    const before = git(r, 'rev-parse', 'main').trim();

    const out = await app.ctx.governance.approve(p.id, ada);
    assert.equal(out.status, 'conflicted');
    assert.deepEqual(out.mergeError.files, ['brain/wiki/alpha.md']);
    assert.equal(git(r, 'rev-parse', 'main').trim(), before);
    const revise = app.ingest.jobs.find((j) => j.kind === 'revise');
    assert.equal(revise.proposalId, p.id);
    assert.equal(revise.reason, 'conflict');
    assert.match(revise.instructions, /brain\/wiki\/alpha\.md/);
    await app.stop();
  });

  it('re-audits the merge result and does not merge when it fails, whatever the runner reported', async () => {
    const r = repo();
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r);
    const broken = DELTA.replace('Delta relies on the Alpha overview.', 'Delta relies on [[nowhere-page]].');
    const { p } = await openProposal(app, 'ingest/bad-3333333', { 'brain/wiki/delta.md': broken });
    const before = git(r, 'rev-parse', 'main').trim();
    const out = await app.ctx.governance.approve(p.id, ada);
    assert.equal(out.status, 'conflicted');
    assert.equal(out.mergeError.reason, 'audit');
    assert.equal(git(r, 'rev-parse', 'main').trim(), before);
    assert.match(app.ingest.jobs.at(-1).instructions, /LINK-001/);
    await app.stop();
  });

  it('a proposal whose runner audit failed cannot be merged at all', async () => {
    const r = repo();
    const app = await govApp(r);
    const b = await proposalBranch(app, 'ingest/x-4444444', { 'brain/wiki/delta.md': DELTA });
    const p = await app.ctx.governance.createFromJob(job(b.branch), { ...b, audit: { exit: 1, errors: 2, warnings: 0, findings: [] } });
    const out = await app.ctx.governance.approve(p.id, ada);
    assert.equal(out.status, 'open');
    assert.match((await app.ctx.governance.evaluate(p.id)).evaluation.explanation, /found 2 problems/);
    await app.stop();
  });
});

describe('governance: actions', () => {
  it('agents, viewers and (with SoD) submitters cannot approve', async () => {
    const r = repo();
    const app = await govApp(r, { overrides: { governance: { separation_of_duties: true } } });
    const { p } = await openProposal(app, undefined, undefined, { job: { requestedBy: 'agent:mcp:claude', onBehalfOf: 'usr_ada' } });
    const gov = app.ctx.governance;
    await assert.rejects(() => gov.approve(p.id, agentActor('claude', ada)), /cannot approve/);
    await assert.rejects(() => gov.approve(p.id, vic), /approver role/);
    await assert.rejects(() => gov.approve(p.id, ada), /separation of duties/);
    assert.equal((await gov.approve(p.id, bob)).status, 'merged');
    await app.stop();
  });

  it('decisions from the run report block, and resolving one enqueues a revise job with the effect', async () => {
    const r = repo();
    const app = await govApp(r);
    const gov = app.ctx.governance;
    const created = app.ctx.bus.waitFor('decision.created');
    const { p } = await openProposal(app, undefined, undefined, {
      runReport: {
        source: { id: 'alpha-pdf' }, outcome: 'written', pages: [],
        blocked: [{ kind: 'contradiction', slug: 'alpha', question: 'Is the backoff 30 or 45 seconds?', claimA: '30 s', sourceA: 'alpha-pdf, p.3', claimB: '45 s', sourceB: 'q3, p.2',
          options: [{ id: 'replace', label: 'Use 45 s', effect: 'Replace the 30 s claim with 45 s, cite q3 p.2' }, { id: 'keep', label: 'Keep 30 s', effect: 'Drop the 45 s claim' }] }],
      },
    });
    const { decision } = await created;
    assert.equal(decision.kind, 'contradiction');
    const out = await gov.approve(p.id, ada);
    assert.equal(out.status, 'open', 'open decision blocks the merge');
    await assert.rejects(() => gov.resolveDecision(decision.id, ada, { optionId: 'nope' }), /Pick one/);
    await assert.rejects(() => gov.resolveDecision(decision.id, agentActor('x', ada), { optionId: 'replace' }), /cannot approve/);
    const resolved = await gov.resolveDecision(decision.id, ada, { optionId: 'replace', note: 'q3 is newer' });
    assert.equal(resolved.status, 'resolved');
    const revise = app.ingest.jobs.find((j) => j.kind === 'revise');
    assert.equal(revise.trigger, 'decision');
    assert.match(revise.instructions, /Replace the 30 s claim[\s\S]*q3 is newer/);
    await assert.rejects(() => gov.resolveDecision(decision.id, ada, { optionId: 'keep' }), /already been answered/);
    await app.stop();
  });

  it('a canonical page change never merges; recording the challenge appends to the ledger on the branch, outside the wiki', async () => {
    const r = repo();
    const cfg = path.join(r, 'brain.config.yaml');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf-8').replace('canonical_pages: []', 'canonical_pages:\n  - beta'));
    git(r, 'commit', '-qam', 'beta is canonical');
    const app = await govApp(r);
    const gov = app.ctx.governance;
    const beta = show(r, 'main', 'brain/wiki/beta.md').replace('Beta is a 2U rack appliance.', 'Beta is a 4U rack appliance.');
    const { p } = await openProposal(app, 'ingest/c-5555555', { 'brain/wiki/beta.md': beta });
    assert.equal(p.changes[0].canonical, true);
    const [dec] = await gov.listDecisions(p.id);
    assert.equal(dec.kind, 'canonical_conflict');
    assert.deepEqual(dec.options.map((o) => o.id), ['record', 'dismiss']);
    await gov.approve(p.id, ada);
    assert.equal((await gov.getProposal(p.id)).status, 'open');

    const resolved = await gov.resolveDecision(dec.id, ada, { optionId: 'record' });
    assert.equal(resolved.status, 'resolved');
    const after = await gov.getProposal(p.id);
    assert.notEqual(after.headSha, p.headSha, 'the challenge row is a new commit on the branch');
    const ledger = show(r, after.headSha, 'brain/canonical-challenges.md');
    assert.match(ledger, /\| \[\[beta\]\] \| Beta is a 4U rack appliance\. \| alpha-pdf, §Overview \| open \|/);
    const touched = git(r, 'diff', '--name-only', p.headSha, after.headSha).trim();
    assert.equal(touched, 'brain/canonical-challenges.md');
    const drop = app.ingest.jobs.find((j) => j.kind === 'drop-page');
    assert.equal(drop.slug, 'beta');
    const ev = (await gov.evaluate(p.id)).evaluation;
    assert.equal(ev.ready, false);
    assert.ok(ev.blockers.some((b) => b.code === 'page-removal'));
    await app.stop();
  });

  it('request changes, take a page out, turn down', async () => {
    const r = repo();
    const app = await govApp(r);
    const gov = app.ctx.governance;
    const { p } = await openProposal(app);
    await assert.rejects(() => gov.requestChanges(p.id, ada, { feedback: '  ' }), /Say what should change/);
    const page1 = await gov.rejectPage(p.id, 'delta', ada);
    assert.equal(page1.changes.find((c) => c.slug === 'delta').pageStatus, 'rejected');
    assert.equal(app.ingest.jobs.at(-1).kind, 'drop-page');
    const cr = await gov.requestChanges(p.id, ada, { feedback: 'Cite page 2 instead' });
    assert.equal(cr.status, 'changes_requested');
    assert.match(app.ingest.jobs.at(-1).instructions, /Cite page 2 instead/);
    await assert.rejects(() => gov.approve(p.id, ada), /being revised/);
    const rej = await gov.reject(p.id, bob, { reason: 'wrong deck' });
    assert.equal(rej.status, 'rejected');
    const actions = (await app.ctx.store.audit.list({})).map((a) => a.action);
    assert.deepEqual(actions, ['proposal.create', 'page.reject', 'proposal.request_changes', 'proposal.reject']);
    // The revise job finishing late must not resurrect a turned-down proposal.
    const late = await gov.createFromJob({ ...job(p.branch), kind: 'revise', proposalId: p.id }, { branch: p.branch, audit: CLEAN_AUDIT });
    assert.equal(late.status, 'rejected');
    assert.equal((await gov.listProposals({})).length, 1);
    await app.stop();
  });

  it('nothing changes when the agent queue is unreachable', async () => {
    const r = repo();
    const ingest = { enqueue: async () => { throw new Error('down'); }, start: async () => {}, stop: async () => {} };
    const app = await govApp(r, { ingest });
    const { p } = await openProposal(app);
    await assert.rejects(() => app.ctx.governance.requestChanges(p.id, ada, { feedback: 'x' }), /isn't reachable/);
    assert.equal((await app.ctx.governance.getProposal(p.id)).status, 'open');
    await app.stop();
  });

  it('a new proposal for the same source supersedes the old one', async () => {
    const r = repo();
    const app = await govApp(r);
    const a = await openProposal(app, 'ingest/q3-1111111');
    const b = await openProposal(app, 'ingest/q3-2222222', { 'brain/wiki/delta.md': DELTA });
    assert.equal((await app.ctx.governance.getProposal(a.p.id)).status, 'superseded');
    assert.equal((await app.ctx.governance.getProposal(b.p.id)).status, 'open');
    await app.stop();
  });

  it('confirmations are single-use and expire', async () => {
    const r = repo();
    const app = await govApp(r);
    const { p } = await openProposal(app);
    const c = await app.ctx.governance.createConfirmation(p.id, ada, 'approve');
    assert.match(c.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.ok(c.url.endsWith(`/inbox/confirm/${c.code}`));
    assert.ok(Date.parse(c.expiresAt) > Date.now());
    await assert.rejects(() => app.ctx.governance.createConfirmation(p.id, ada, 'merge-now'), /unknown confirmation action/);
    await app.stop();
  });

  it('works with page content that has no citations or odd markup', async () => {
    const r = repo();
    const app = await govApp(r);
    const { p } = await openProposal(app, 'ingest/odd-6666666', { 'brain/wiki/odd.md': page({ title: 'Odd', body: '## Summary\n\n```\n[source: x, p.1]\n```\n\nNothing cited.' }) });
    assert.equal(p.changes[0].claims.length, 0);
    await app.stop();
  });
});
