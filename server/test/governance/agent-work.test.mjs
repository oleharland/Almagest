/**
 * What the agent was asked to do on a proposal, and how it ended. A request
 * that fails for good must not read as done, and the old version must not be
 * approvable while the agent is working on, or failed at, the new one.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { agentActor, humanActor } from '../../src/core/auth.mjs';
import { assertMayApprove, computeRequirements, evaluate } from '../../src/governance/policy.mjs';
import { describe as describeProposal } from '../../src/governance/summary.mjs';
import {
  ada, ALPHA_V2, bob, CLEAN_AUDIT, cleanup, client, DELTA, G, git, govApp, job, proposalBranch, repo, setJobStatus, vic,
} from './fixtures.mjs';

const TOKENS = 'ada:owner:ada-secret-1;bob:reviewer:bob-secret-2;vic:viewer:vic-secret-3';
const LOGINS = 'ada:ada-signin-1;bob:bob-signin-2;vic:vic-signin-3';
let saved;
before(() => { saved = process.env.ALMAGEST_TOKENS; process.env.ALMAGEST_TOKENS = TOKENS; process.env.ALMAGEST_LOGINS = LOGINS; process.env.ALMAGEST_SECRET_KEY = 'test-secret'; });
after(() => { process.env.ALMAGEST_TOKENS = saved; cleanup(); });

const QUESTION = 'Is the refund window 30 or 45 days?';
const BLOCKED = [{
  kind: 'contradiction', slug: 'alpha', question: QUESTION, claimA: '30 days', sourceA: 'alpha-pdf, p.3', claimB: '45 days', sourceB: 'alpha-pdf, p.1',
  options: [
    { id: 'use45', label: 'Use 45 days', effect: 'Change the refund window on the refund-policy page to 45 days.' },
    { id: 'keep', label: 'Keep both', effect: 'none' },
  ],
}];

let n = 0;
async function openProposal(app, { blocked = BLOCKED, branch = 'ingest/acme-handbook-abcdef1' } = {}) {
  const b = await proposalBranch(app, branch, { 'brain/wiki/alpha.md': ALPHA_V2, 'brain/wiki/delta.md': DELTA });
  // each proposal has a source of its own, so a second one does not replace the first
  const source = { kind: 'local', id: `acme-doc-${++n}`, path: `brain/raw/acme-${n}.pdf`, title: `Acme document ${n}`, sha256: `abcdef${n}` };
  const p = await G(app).createFromJob(job(branch, { source }), { ...b, audit: CLEAN_AUDIT, runReport: { blocked } });
  return { ...b, p };
}

/** A new commit on the proposal's branch, as a revise run would make, handed to governance the way the runner does. */
async function advance(app, p, jobId) {
  const g = app.ctx.git;
  const worktree = await g.worktreeAdd(p.branch);
  fs.writeFileSync(path.join(worktree, 'brain/wiki/delta.md'), DELTA.replace('Delta is new.', `Delta is new and revised ${++n} times.`));
  const headSha = await g.commitAll(worktree, { message: 'revise', author: { name: 'svc:ingest', email: 'ingest@almagest.local' } });
  const baseSha = await g.mergeBase('main', headSha);
  return G(app).createFromJob(job(p.branch, { id: jobId, proposalId: p.id, kind: 'revise' }), { branch: p.branch, baseSha, headSha, audit: CLEAN_AUDIT, worktree, runReport: { blocked: [] } });
}

async function answered(app) {
  const { p } = await openProposal(app);
  const [d] = await app.ctx.governance.listDecisions(p.id);
  await G(app).resolveDecision(d.id, ada, { optionId: 'use45' });
  const reviseJob = app.ingest.jobs.at(-1);
  return { p: await app.ctx.governance.getProposal(p.id), d, reviseJob };
}

describe('agent work: the observed sequence', () => {
  it('a revise that fails for good leaves the answer unapplied, blocks approving the old version, and can be run again', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p, d, reviseJob } = await answered(app);
    assert.equal(reviseJob.kind, 'revise');
    assert.equal(reviseJob.trigger, 'decision');
    assert.equal(reviseJob.decisionId, d.id);
    assert.equal(p.status, 'open');
    assert.deepEqual(p.work.map((w) => ({ jobId: w.jobId, kind: w.kind, decisionId: w.decisionId })), [{ jobId: reviseJob.id, kind: 'decision', decisionId: d.id }]);
    assert.ok(p.work[0].at);
    assert.equal(p.work[0].status, undefined, 'the proposal holds a pointer, never a status');

    await setJobStatus(app, reviseJob.id, 'failed', 'Agent exited with code 1');
    const work = await gov.workOf(p);
    assert.equal(work.length, 1);
    assert.equal(work[0].status, 'failed');
    assert.equal(work[0].error, 'Agent exited with code 1');

    // approving the version from before the answer is refused, on every path that goes through assertMayApprove
    await assert.rejects(() => app.ctx.governance.approve(p.id, ada, { headSha: p.headSha }), (err) => err.status === 409 && /could not finish/.test(err.message));
    assert.equal((await gov.getProposal(p.id)).status, 'open');
    assert.equal((await gov.getProposal(p.id)).approvals.length, 0);

    // the decision does not read as settled, and the evaluation says why
    const decisions = await gov.listDecisions(p.id);
    const info = describeProposal(p, decisions, work);
    assert.equal(info.unappliedAnswers, 1);
    assert.match(info.sentence, /1 answer not applied yet/);
    assert.equal(describeProposal(p, decisions).unappliedAnswers, 0);
    const ev = await gov.evaluate(p.id);
    const blocker = ev.evaluation.blockers.find((b) => b.code === 'agent-failed');
    assert.ok(blocker);
    assert.ok(blocker.message.includes(QUESTION));
    assert.equal(ev.evaluation.ready, false);
    assert.equal(ev.work.length, 1);
    assert.equal((await gov.mayApprove(p, ada)).ok, false);

    // run it again: a new job copies the failed one
    const retried = await gov.retryWork(p.id, reviseJob.id, bob);
    const again = app.ingest.jobs.at(-1);
    assert.notEqual(again.id, reviseJob.id);
    for (const k of ['kind', 'trigger', 'decisionId', 'instructions', 'source']) assert.deepEqual(again[k], reviseJob[k], k);
    assert.equal(again.requestedBy, bob.id);
    assert.equal(again.proposalId, p.id);
    assert.deepEqual(retried.work.map((w) => w.jobId), [again.id]);
    const events = await app.ctx.store.audit.list({});
    const ev2 = events.find((e) => e.action === 'proposal.retry_agent');
    assert.equal(ev2.actorId, bob.id);
    assert.equal(ev2.detail.oldJobId, reviseJob.id);
    assert.equal(ev2.detail.jobId, again.id);
    assert.equal(ev2.detail.headSha, p.headSha);

    // the new job lands a new head and ends well: the entry is gone and the new version can be approved
    await setJobStatus(app, again.id, 'running');
    const next = await advance(app, p, again.id);
    assert.notEqual(next.headSha, p.headSha);
    assert.equal(next.work.length, 1, 'still running while the run writes the proposal');
    await setJobStatus(app, again.id, 'succeeded');
    assert.deepEqual(await gov.workOf(next), []);
    const settled = await advance(app, next, 'job_later');   // the next write drops the settled entry
    assert.deepEqual(settled.work, []);
    await assert.rejects(() => app.ctx.governance.approve(p.id, ada, { headSha: p.headSha }), /changed since you opened it/);
    const merged = await gov.approve(p.id, ada);
    assert.equal(merged.status, 'merged', merged.mergeError?.message);
    await app.stop();
  });

  it('a pending or running job refuses the approval of the old version', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p, reviseJob } = await answered(app);
    for (const status of ['queued', 'running']) {
      await setJobStatus(app, reviseJob.id, status);
      await assert.rejects(() => gov.approve(p.id, ada), (err) => err.status === 409 && /has not finished/.test(err.message), status);
      const ev = await gov.evaluate(p.id);
      assert.equal(ev.evaluation.blockers.find((b) => b.code === 'agent-working')?.message.includes(QUESTION), true, status);
      assert.equal(ev.evaluation.blockers.some((b) => b.code === 'agent-failed'), false);
      assert.equal(describeProposal(p, await gov.listDecisions(p.id), ev.work).unappliedAnswers, 1);
      // a pending job cannot be run again
      await assert.rejects(() => gov.retryWork(p.id, reviseJob.id, ada), (err) => err.status === 409 && /still working/.test(err.message), status);
    }
    assert.equal((await gov.getProposal(p.id)).approvals.length, 0);
    await app.stop();
  });

  it('a cancelled job counts as failed, and so does one with no record in the job store', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p, reviseJob } = await answered(app);
    await setJobStatus(app, reviseJob.id, 'cancelled');
    assert.equal((await gov.workOf(p))[0].status, 'failed');
    assert.match((await gov.workOf(p))[0].error, /cancelled/);

    const { p: p2 } = await openProposal(app, { branch: 'ingest/acme-faq-bcdef12' });
    const [d2] = await gov.listDecisions(p2.id);
    app.ingest.enqueue = async (spec) => ({ id: 'job_ghost', status: 'queued', ...spec });   // never reaches the job store
    await gov.resolveDecision(d2.id, ada, { optionId: 'use45' });
    const [w] = await gov.workOf(await gov.getProposal(p2.id));
    assert.equal(w.status, 'failed');
    assert.match(w.error, /no record/i);
    await assert.rejects(() => gov.retryWork(p2.id, 'job_ghost', ada), (err) => err.status === 409 && /no record/i.test(err.message));
    await app.stop();
  });

  it('an answer is settled only when the job ended well and moved the branch', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p, reviseJob } = await answered(app);
    await setJobStatus(app, reviseJob.id, 'running');
    assert.equal((await gov.workOf(p))[0].status, 'pending');
    await setJobStatus(app, reviseJob.id, 'succeeded', null, { moved: true });
    assert.deepEqual(await gov.workOf(p), []);
    assert.equal((await gov.evaluate(p.id)).evaluation.blockers.some((b) => /^agent-/.test(b.code)), false);
    assert.equal(describeProposal(p, await gov.listDecisions(p.id), []).unappliedAnswers, 0);
    const out = await gov.approve(p.id, ada);
    assert.equal(out.status, 'merged', out.mergeError?.message);
    await app.stop();
  });

  it('scenario A: the agent raises the same question again, blocked with no commit, and the answer stays unapplied', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p, d, reviseJob } = await answered(app);
    await setJobStatus(app, reviseJob.id, 'blocked', null, { moved: false });
    const [w] = await gov.workOf(p);
    assert.equal(w.status, 'failed');
    assert.equal(w.error, 'The agent finished without changing anything.');
    await assert.rejects(() => gov.approve(p.id, ada), (err) => err.status === 409 && /could not finish/.test(err.message));
    assert.equal(describeProposal(p, await gov.listDecisions(p.id), [w]).unappliedAnswers, 1);
    assert.equal((await gov.listDecisions(p.id)).find((x) => x.id === d.id).status, 'resolved');
    await app.stop();
  });

  it('scenario B: a succeeded run with no head (unchanged, no changes) leaves an answer and a request for changes unapplied', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p, reviseJob } = await answered(app);
    await app.ctx.store.jobs.update(reviseJob.id, { status: 'succeeded', startSha: 'start1', headSha: undefined, note: 'unchanged, nothing to review' });
    assert.equal((await gov.workOf(p))[0].status, 'failed');
    const { p: q } = await openProposal(app, { blocked: [], branch: 'ingest/acme-faq-bcdef12' });
    await gov.requestChanges(q.id, ada, { feedback: 'Cite page 2' });
    const fb = app.ingest.jobs.at(-1);
    await setJobStatus(app, fb.id, 'succeeded', null, { moved: false });
    assert.equal((await gov.workOf(await gov.getProposal(q.id)))[0].status, 'failed');
    // without a start (older jobs), the job's end is compared with the head the request was made on
    await app.ctx.store.jobs.update(fb.id, { startSha: undefined, headSha: q.headSha });
    assert.equal((await gov.workOf(await gov.getProposal(q.id)))[0].status, 'failed');
    await app.ctx.store.jobs.update(fb.id, { headSha: 'somewhere-new' });
    assert.deepEqual(await gov.workOf(await gov.getProposal(q.id)), []);
    await app.stop();
  });

  it('page entries settle on success whether or not the branch moved', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p } = await openProposal(app, { blocked: [] });
    await gov.rejectPage(p.id, 'delta', ada);
    const drop = app.ingest.jobs.at(-1);
    await setJobStatus(app, drop.id, 'succeeded', null, { moved: false });
    assert.deepEqual(await gov.workOf(await gov.getProposal(p.id)), []);
    await app.stop();
  });

  it('an answer with no effect queues nothing and leaves no entry', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p } = await openProposal(app);
    const [d] = await gov.listDecisions(p.id);
    await gov.resolveDecision(d.id, ada, { optionId: 'keep' });
    assert.equal(app.ingest.jobs.length, 0);
    assert.equal((await gov.getProposal(p.id)).work, undefined);
    await app.stop();
  });
});

describe('agent work: the other three places', () => {
  it('asking for changes: a failed job shows the blocker and can be run again', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p } = await openProposal(app, { blocked: [] });
    const out = await gov.requestChanges(p.id, ada, { feedback: 'Cite page 2 instead' });
    assert.equal(out.status, 'changes_requested');
    const first = app.ingest.jobs.at(-1);
    assert.equal(out.work[0].kind, 'feedback');
    await setJobStatus(app, first.id, 'failed', 'Timed out after 30 minutes');
    const ev = await gov.evaluate(p.id);
    assert.ok(ev.evaluation.blockers.some((b) => b.code === 'agent-failed' && /requested changes/.test(b.message)));
    assert.equal(ev.work[0].error, 'Timed out after 30 minutes');
    const retried = await gov.retryWork(p.id, first.id, ada);
    const second = app.ingest.jobs.at(-1);
    assert.notEqual(second.id, first.id);
    assert.match(second.instructions, /Cite page 2 instead/);
    assert.equal(retried.work[0].jobId, second.id);
    assert.equal(retried.status, 'changes_requested');
    await app.stop();
  });

  it('taking a page out: a failed drop-page job shows the blocker and can be run again', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p } = await openProposal(app, { blocked: [] });
    const out = await gov.rejectPage(p.id, 'delta', ada);
    const first = app.ingest.jobs.at(-1);
    assert.equal(first.kind, 'drop-page');
    assert.deepEqual(out.work.map((w) => [w.kind, w.slug]), [['page', 'delta']]);
    await setJobStatus(app, first.id, 'failed', 'could not restore the page');
    const ev = await gov.evaluate(p.id);
    assert.ok(ev.evaluation.blockers.some((b) => b.code === 'agent-failed' && /taking out the page/.test(b.message)));
    assert.ok(ev.evaluation.blockers.some((b) => b.code === 'page-removal'), 'the existing blocker stays');
    await assert.rejects(() => gov.approve(p.id, ada), /could not finish/);
    await gov.retryWork(p.id, first.id, bob);
    const second = app.ingest.jobs.at(-1);
    assert.equal(second.kind, 'drop-page');
    assert.equal(second.slug, 'delta');
    assert.equal(second.proposalId, p.id);
    assert.equal((await gov.getProposal(p.id)).work[0].jobId, second.id);
    await app.stop();
  });

  it('a canonical conflict answer queues a page entry tied to the decision, and it survives the challenge commit', async () => {
    const r = repo();
    const cfg = path.join(r, 'brain.config.yaml');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf-8').replace('canonical_pages: []', 'canonical_pages:\n  - beta'));
    git(r, 'commit', '-qam', 'beta is canonical');
    const app = await govApp(r);
    const gov = G(app);
    const beta = git(r, 'show', 'main:brain/wiki/beta.md').replace('Beta is a 2U rack appliance.', 'Beta is a 4U rack appliance.');
    const b = await proposalBranch(app, 'ingest/acme-locked-cdef123', { 'brain/wiki/beta.md': beta });
    const p = await gov.createFromJob(job(b.branch), { ...b, audit: CLEAN_AUDIT });
    const dec = (await gov.listDecisions(p.id)).find((x) => x.kind === 'canonical_conflict');
    assert.ok(dec);
    await gov.resolveDecision(dec.id, ada, { optionId: 'record' });
    const drop = app.ingest.jobs.find((j) => j.kind === 'drop-page');
    const stored = await gov.getProposal(p.id);
    assert.deepEqual(stored.work.map((w) => [w.jobId, w.kind, w.slug, w.decisionId]), [[drop.id, 'page', 'beta', dec.id]]);
    await setJobStatus(app, drop.id, 'failed', 'could not restore the page');
    const ev = await gov.evaluate(p.id);
    assert.ok(ev.evaluation.blockers.some((x) => x.code === 'agent-failed' && /taking out the page/.test(x.message)));
    assert.equal(describeProposal(stored, await gov.listDecisions(p.id), ev.work).unappliedAnswers, 1);
    await app.stop();
  });

  it('a conflict revise queued by a merge is tracked too', async () => {
    const r = repo();
    const app = await govApp(r);
    const gov = G(app);
    const { p } = await openProposal(app, { blocked: [] });
    const g = app.ctx.git;
    // main moves under the proposal on the same page, so the merge clashes
    const wt = await g.worktreeAdd('side/clash');
    fs.writeFileSync(path.join(wt, 'brain/wiki/delta.md'), DELTA.replace('Delta is new.', 'Delta is something else.'));
    const side = await g.commitAll(wt, { message: 'clash', author: { name: 'svc', email: 's@almagest.local' } });
    await g.run(['update-ref', 'refs/heads/main', side]).catch(() => {});
    const out = await gov.approve(p.id, ada);
    assert.equal(out.status, 'conflicted');
    assert.equal(out.work.at(-1).kind, 'conflict');
    await setJobStatus(app, out.work.at(-1).jobId, 'failed', 'agent crashed');
    const ev = await gov.evaluate(p.id);
    assert.ok(ev.evaluation.blockers.some((b) => b.code === 'agent-failed' && /clash/.test(b.message)));
    await app.stop();
  });

  it('two asks folded into one job give two entries on one job id; running it again moves both', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const b1 = BLOCKED;
    const b2 = [{ ...BLOCKED[0], slug: 'delta', question: 'Is the trial 7 or 14 days?' }];
    const { p } = await openProposal(app, { blocked: [...b1, ...b2] });
    const [d1, d2] = await gov.listDecisions(p.id);
    const orig = app.ingest.enqueue;
    let shared = null;
    app.ingest.enqueue = async (spec) => (shared ||= await orig(spec));   // what the queue does with a revise while one is queued
    await gov.resolveDecision(d1.id, ada, { optionId: 'use45' });
    await gov.resolveDecision(d2.id, ada, { optionId: 'use45' });
    const stored = await gov.getProposal(p.id);
    assert.equal(stored.work.length, 2);
    assert.equal(stored.work[0].jobId, stored.work[1].jobId);
    await setJobStatus(app, shared.id, 'failed', 'agent crashed');
    const ev = await gov.evaluate(p.id);
    assert.equal(ev.evaluation.blockers.filter((x) => x.code === 'agent-failed').length, 2);
    assert.equal(describeProposal(stored, await gov.listDecisions(p.id), ev.work).unappliedAnswers, 2);
    app.ingest.enqueue = orig;
    const out = await gov.retryWork(p.id, shared.id, ada);
    const fresh = app.ingest.jobs.at(-1);
    assert.notEqual(fresh.id, shared.id);
    assert.deepEqual(out.work.map((w) => w.jobId), [fresh.id, fresh.id]);
    await app.stop();
  });
});

describe('agent work: running it again is a review action', () => {
  it('needs a reviewer in a browser session, a live proposal, and a failed entry; an unreachable queue changes nothing', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p, reviseJob } = await answered(app);
    await setJobStatus(app, reviseJob.id, 'failed', 'agent crashed');
    const before = JSON.stringify(await gov.getProposal(p.id));

    await assert.rejects(() => gov.retryWork(p.id, reviseJob.id, vic), /approver role|cannot/i);
    await assert.rejects(() => gov.retryWork(p.id, reviseJob.id, agentActor('claude-code', ada)), /cannot approve|human/i);
    const bearer = { ...humanActor({ id: 'usr_bob', display: 'Bob', roles: ['reviewer'] }) };   // no browser session behind it
    await assert.rejects(() => gov.retryWork(p.id, reviseJob.id, bearer));
    await assert.rejects(() => gov.retryWork(p.id, 'job_nope', ada), (err) => err.status === 404);
    const jobsBefore = app.ingest.jobs.length;
    app.ingest.enqueue = async () => null;
    await assert.rejects(() => gov.retryWork(p.id, reviseJob.id, ada), (err) => err.status === 503);
    assert.equal(JSON.stringify(await gov.getProposal(p.id)), before);
    assert.equal(app.ingest.jobs.length, jobsBefore);

    await gov.reject(p.id, ada, { reason: 'no' });
    await assert.rejects(() => gov.retryWork(p.id, reviseJob.id, ada), (err) => err.status === 409);
    await app.stop();
  });

  it('never approves or merges: a run that ends leaves the approval to a person', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p, reviseJob } = await answered(app);
    await setJobStatus(app, reviseJob.id, 'failed', 'agent crashed');
    await gov.retryWork(p.id, reviseJob.id, ada);
    const fresh = app.ingest.jobs.at(-1);
    await setJobStatus(app, fresh.id, 'succeeded');
    const after = await gov.getProposal(p.id);
    assert.equal(after.status, 'open');
    assert.equal(after.approvals.length, 0);
    await app.stop();
  });
});

describe('agent work: telling the inbox when a job ends', () => {
  it('a failed or cancelled job for a proposal is recorded and announced; one that ended well is not', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p } = await openProposal(app);
    const updated = [];
    app.ctx.bus.on('proposal.updated', ({ proposal }) => updated.push(proposal.id));
    const long = 'x'.repeat(2000);
    app.ctx.bus.emit('job.finished', { job: { id: 'job_a', kind: 'revise', status: 'failed', proposalId: p.id, error: long } });
    app.ctx.bus.emit('job.finished', { job: { id: 'job_b', kind: 'drop-page', status: 'cancelled', proposalId: p.id, error: 'cancelled' } });
    app.ctx.bus.emit('job.finished', { job: { id: 'job_c', kind: 'revise', status: 'succeeded', proposalId: p.id } });
    app.ctx.bus.emit('job.finished', { job: { id: 'job_d', kind: 'ingest', status: 'failed' } });
    app.ctx.bus.emit('job.finished', { job: { id: 'job_e', kind: 'revise', status: 'failed', proposalId: 'prp_unknown' } });
    await app.ctx.bus.drain();
    const rows = (await app.ctx.store.audit.list({})).filter((e) => e.action === 'proposal.agent_failed');
    assert.deepEqual(rows.map((r) => r.detail.jobId).sort(), ['job_a', 'job_b']);
    const a = rows.find((r) => r.detail.jobId === 'job_a');
    assert.equal(a.target, p.id);
    assert.equal(a.detail.kind, 'revise');
    assert.ok(a.detail.error.length <= 300 && a.detail.error.length > 100);
    assert.equal(updated.filter((id) => id === p.id).length, 2);
    assert.equal((await gov.getProposal(p.id)).work, undefined, 'nothing is stored on the proposal');

    gov.stop();
    app.ctx.bus.emit('job.finished', { job: { id: 'job_f', kind: 'revise', status: 'failed', proposalId: p.id } });
    await app.ctx.bus.drain();
    assert.equal((await app.ctx.store.audit.list({})).filter((e) => e.action === 'proposal.agent_failed').length, 2);
    await app.stop();
  });
});

describe('agent work: going on without a failed request', () => {
  async function failedFeedback(app) {
    const gov = G(app);
    const { p } = await openProposal(app, { blocked: [] });
    await gov.requestChanges(p.id, ada, { feedback: 'Cite page 2' });
    const first = app.ingest.jobs.at(-1);
    await setJobStatus(app, first.id, 'failed', 'Agent said: nothing to change');
    return { p, first };
  }

  it('a later successful job does not clear a failed entry; dismissing it does, and the proposal can be reviewed as it is', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p, first } = await failedFeedback(app);
    await gov.requestChanges(p.id, ada, { feedback: 'Also fix the title' });
    const second = app.ingest.jobs.at(-1);
    await setJobStatus(app, second.id, 'running');
    const next = await advance(app, p, second.id);
    await setJobStatus(app, second.id, 'succeeded', null, { moved: true });
    const open1 = await gov.getProposal(p.id);
    assert.equal(open1.status, 'open');
    assert.equal(open1.headSha, next.headSha);
    assert.deepEqual((await gov.workOf(open1)).map((w) => [w.jobId, w.status]), [[first.id, 'failed']]);
    await assert.rejects(() => gov.approve(p.id, ada), (err) => err.status === 409 && /go on without it/.test(err.message));

    const out = await gov.dismissWork(p.id, first.id, bob);
    assert.deepEqual(out.work.map((w) => w.jobId), [second.id], 'only the settled entry is left');
    assert.deepEqual(await gov.workOf(out), []);
    assert.equal(out.feedback[0].notApplied.by, bob.id);
    assert.equal(out.feedback[1].notApplied, undefined);
    const ev = (await app.ctx.store.audit.list({})).find((e) => e.action === 'proposal.dismiss_agent');
    assert.deepEqual([ev.detail.jobId, ev.detail.kinds, ev.detail.headSha], [first.id, ['feedback'], next.headSha]);
    const merged = await gov.approve(p.id, ada);
    assert.equal(merged.status, 'merged', merged.mergeError?.message);
    await app.stop();
  });

  it('dismissing the last failed request for changes puts a proposal waiting on it back to open', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p, first } = await failedFeedback(app);
    assert.equal((await gov.getProposal(p.id)).status, 'changes_requested');
    const out = await gov.dismissWork(p.id, first.id, ada);
    assert.equal(out.status, 'open');
    assert.equal(out.feedback[0].notApplied.display, 'Ada');
    await app.stop();
  });

  it('a decision entry marks the decision for good, and the card says so', async () => {
    const app = await govApp(repo(), { overrides: { service: { http: { port: 0 } } } });
    const server = await app.start();
    const base = `http://127.0.0.1:${server.address().port}`;
    const gov = G(app);
    const { p, d, reviseJob } = await answered(app);
    await setJobStatus(app, reviseJob.id, 'failed', 'agent crashed');
    const out = await gov.dismissWork(p.id, reviseJob.id, bob);
    assert.deepEqual(out.work, []);
    const dec = (await gov.listDecisions(p.id)).find((x) => x.id === d.id);
    assert.equal(dec.status, 'resolved');
    assert.equal(dec.resolution.notApplied.by, bob.id);
    const page1 = await (await login(base)).get(`/inbox/p/${p.id}`);
    assert.match(page1.text, /The agent did not apply this answer\. Bob chose to continue without it\./);
    assert.doesNotMatch(page1.text, /Not applied yet/);
    await app.stop();
  });

  it('a conflict entry is just removed and the status stays', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p } = await openProposal(app, { blocked: [] });
    const g = app.ctx.git;
    const wt = await g.worktreeAdd('side/clash');
    fs.writeFileSync(path.join(wt, 'brain/wiki/delta.md'), DELTA.replace('Delta is new.', 'Delta is something else.'));
    const side = await g.commitAll(wt, { message: 'clash', author: { name: 'svc', email: 's@almagest.local' } });
    await g.run(['update-ref', ['refs', 'heads', 'main'].join('/'), side]);
    const out = await gov.approve(p.id, ada);
    assert.equal(out.status, 'conflicted');
    const entry = out.work.at(-1);
    await setJobStatus(app, entry.jobId, 'failed', 'agent crashed');
    const after = await gov.dismissWork(p.id, entry.jobId, ada);
    assert.equal(after.status, 'conflicted');
    assert.deepEqual(after.work, []);
    await app.stop();
  });

  it('dismiss is refused for pending entries, page entries, non reviewers and agents; the entry stays', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p, reviseJob } = await answered(app);
    await setJobStatus(app, reviseJob.id, 'running');
    await assert.rejects(() => gov.dismissWork(p.id, reviseJob.id, ada), (err) => err.status === 409 && /still working/.test(err.message));
    await setJobStatus(app, reviseJob.id, 'failed', 'x');
    await assert.rejects(() => gov.dismissWork(p.id, reviseJob.id, vic), /approver role|cannot/i);
    await assert.rejects(() => gov.dismissWork(p.id, reviseJob.id, agentActor('claude-code', ada)), /cannot approve|human/i);
    await assert.rejects(() => gov.dismissWork(p.id, reviseJob.id, humanActor({ id: 'usr_bob', display: 'Bob', roles: ['reviewer'] })));
    await assert.rejects(() => gov.dismissWork(p.id, 'job_nope', ada), (err) => err.status === 404);
    assert.equal((await gov.getProposal(p.id)).work.length, 1);

    const { p: q } = await openProposal(app, { blocked: [], branch: 'ingest/acme-faq-bcdef12' });
    await gov.rejectPage(q.id, 'delta', ada);
    const drop = app.ingest.jobs.at(-1);
    await setJobStatus(app, drop.id, 'failed', 'x');
    await assert.rejects(() => gov.dismissWork(q.id, drop.id, ada), (err) => err.status === 409 && /taken out/.test(err.message));
    assert.equal((await gov.getProposal(q.id)).work.length, 1);
    const blocker = (await gov.evaluate(q.id)).evaluation.blockers.find((b) => b.code === 'agent-failed');
    assert.match(blocker.message, /Run it again\.$/);
    assert.doesNotMatch(blocker.message, /go on without/);
    await app.stop();
  });

  it('retry of a page entry with no job record rebuilds the drop-page job; other kinds are refused with the way out', async () => {
    const app = await govApp(repo());
    const gov = G(app);
    const { p } = await openProposal(app, { blocked: [] });
    app.ingest.enqueue = async (spec) => ({ id: 'job_ghost', status: 'queued', ...spec });   // never reaches the job store
    await gov.rejectPage(p.id, 'delta', ada);
    assert.equal((await gov.workOf(await gov.getProposal(p.id)))[0].status, 'failed');
    app.ingest.enqueue = async (spec) => { const j = { id: 'job_new', status: 'queued', ...spec }; app.ingest.jobs.push(j); return j; };
    const out = await gov.retryWork(p.id, 'job_ghost', bob);
    const made = app.ingest.jobs.at(-1);
    assert.equal(made.kind, 'drop-page');
    assert.equal(made.slug, 'delta');
    assert.equal(made.proposalId, p.id);
    assert.equal(made.requestedBy, bob.id);
    assert.deepEqual(made.source, p.source);
    assert.match(made.instructions, /Remove every change to brain\/wiki\/delta\.md/);
    assert.equal(out.work[0].jobId, 'job_new');

    const { p: q } = await openProposal(app, { blocked: [], branch: 'ingest/acme-faq-bcdef12' });
    app.ingest.enqueue = async (spec) => ({ id: 'job_ghost2', status: 'queued', ...spec });
    await gov.requestChanges(q.id, ada, { feedback: 'Cite page 2' });
    await assert.rejects(() => gov.retryWork(q.id, 'job_ghost2', ada), (err) => err.status === 409 && /Go on without it/.test(err.message));
    await app.stop();
  });
});

// ── pure policy ──────────────────────────────────────────────────────────────

const HEAD = 'h2';
const adaPlain = humanActor({ id: 'usr_ada', display: 'Ada', roles: ['owner'], teams: ['engineering'] });
const change = (slug) => ({ slug, title: slug.toUpperCase(), tier: 'curated', action: 'update', hot: false, owner: '', claims: [], pageStatus: 'pending' });
const approval = { actorId: 'usr_ada', display: 'Ada', kind: 'human', roles: ['owner'], teams: ['engineering'], scope: 'all', channel: 'web', headSha: HEAD };
function proposal(extra = {}) {
  const changes = [change('alpha'), change('delta')];
  return { id: 'prp_1', headSha: HEAD, status: 'open', audit: { exit: 0, errors: 0 }, changes, approvals: [approval], submittedBy: 'usr_sub', submitters: [], required: computeRequirements({ changes }), ...extra };
}
const decision = { id: 'dec_1', status: 'resolved', question: 'Is the refund window 30 or 45 days?' };

describe('policy: agent work', () => {
  it('evaluate blocks with one blocker per entry, named for what was asked', () => {
    assert.equal(evaluate({ proposal: proposal(), decisions: [decision] }).ready, true);
    const work = [
      { jobId: 'j1', kind: 'decision', decisionId: 'dec_1', status: 'pending' },
      { jobId: 'j2', kind: 'feedback', status: 'failed', error: 'x' },
      { jobId: 'j3', kind: 'page', slug: 'delta', status: 'failed' },
      { jobId: 'j4', kind: 'conflict', status: 'pending' },
    ];
    const ev = evaluate({ proposal: proposal(), decisions: [decision], options: { work } });
    assert.equal(ev.ready, false);
    const by = Object.fromEntries(ev.blockers.filter((b) => /^agent-/.test(b.code)).map((b) => [b.jobId, b]));
    assert.equal(by.j1.code, 'agent-working');
    assert.match(by.j1.message, /applying your answer to “Is the refund window 30 or 45 days\?”/);
    assert.equal(by.j2.code, 'agent-failed');
    assert.match(by.j2.message, /requested changes/);
    assert.equal(by.j3.code, 'agent-failed');
    assert.match(by.j3.message, /taking out the page “DELTA”/);
    assert.equal(by.j4.code, 'agent-working');
    assert.match(by.j4.message, /clash with recent changes/);
    assert.match(ev.explanation, /could not finish/);
    assert.equal(evaluate({ proposal: proposal(), decisions: [decision], options: { work: [] } }).ready, true);
  });

  it('assertMayApprove refuses with 409 while any work is unsettled, and only then', () => {
    assert.doesNotThrow(() => assertMayApprove(proposal(), adaPlain, { headSha: HEAD, requireHead: true, work: [] }));
    assert.doesNotThrow(() => assertMayApprove(proposal(), adaPlain, { headSha: HEAD, requireHead: true }));
    for (const [status, words] of [['pending', /has not finished/], ['failed', /could not finish/]]) {
      assert.throws(() => assertMayApprove(proposal(), adaPlain, { headSha: HEAD, requireHead: true, work: [{ jobId: 'j', kind: 'feedback', status }] }), (err) => err.status === 409 && words.test(err.message), status);
    }
    // identity checks still come first
    assert.throws(() => assertMayApprove(proposal(), agentActor('claude-code', adaPlain), { work: [{ jobId: 'j', kind: 'feedback', status: 'failed' }] }), /cannot approve/);
  });
});

// ── the web inbox ────────────────────────────────────────────────────────────

async function login(base, secret = 'ada-signin-1') {
  const c = client(base);
  const page1 = await c.get('/inbox/login');
  await c.post('/inbox/login', { form: { csrf: c.csrfFrom(page1.text), secret, next: '/inbox' } });
  return c;
}

async function serveFailed() {
  const app = await govApp(repo(), { overrides: { service: { http: { port: 0 } } } });
  const server = await app.start();
  const base = `http://127.0.0.1:${server.address().port}`;
  const { p, reviseJob } = await answered(app);
  await setJobStatus(app, reviseJob.id, 'failed', 'Agent exited with code 1\nsecond line');
  return { app, base, p, reviseJob };
}

describe('agent work: the inbox, going on without it', () => {
  it('a failed decision entry has both buttons with a plain sentence; a reviewer can post, others cannot', async () => {
    const { app, base, p, reviseJob } = await serveFailed();
    const c = await login(base, 'bob-signin-2');
    const page1 = await c.get(`/inbox/p/${p.id}`);
    assert.match(page1.text, />Go on without it</);
    assert.match(page1.text, new RegExp(`action="/inbox/p/${p.id}/work/${reviseJob.id}/dismiss"`));
    assert.match(page1.text, /the answer stays marked as not applied/);
    const csrf = c.csrfFrom(page1.text);
    const url = `/inbox/p/${p.id}/work/${reviseJob.id}/dismiss`;
    assert.equal((await c.post(url, { form: {} })).status, 403, 'no CSRF');
    assert.equal((await c.post(url, { form: { csrf: 'wrong' } })).status, 403);
    const v = await login(base, 'vic-signin-3');
    const vp = await v.get(`/inbox/p/${p.id}`);
    assert.ok(!vp.text.includes('/dismiss"'));
    assert.equal((await v.post(url, { form: { csrf: v.csrfFrom(vp.text) } })).status, 403);
    const bearer = { authorization: 'Bearer bob-secret-2', 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}${url}`, { method: 'POST', headers: bearer, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/proposals/${p.id}/work/${reviseJob.id}/dismiss`, { method: 'POST', headers: bearer, body: '{}' })).status, 403);
    assert.equal((await app.ctx.governance.getProposal(p.id)).work.length, 1);

    const res = await c.post(url, { form: { csrf } });
    assert.equal(res.status, 303);
    assert.match(res.location, /m=agent_dismissed/);
    assert.deepEqual((await app.ctx.governance.getProposal(p.id)).work, []);
    assert.match((await c.get('/inbox/activity')).text, /went on without a request the agent could not finish on/);
    await app.stop();
  });

  it('the API mirror works for a browser session with the CSRF header', async () => {
    const { app, base, p, reviseJob } = await serveFailed();
    const c = await login(base);
    const csrf = c.csrfFrom((await c.get(`/inbox/p/${p.id}`)).text);
    const ok = await c.post(`/api/proposals/${p.id}/work/${reviseJob.id}/dismiss`, { json: {}, headers: { 'x-almagest-csrf': csrf } });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(JSON.parse(ok.text).work, []);
    await app.stop();
  });

  it('a page entry shows only the retry button', async () => {
    const app = await govApp(repo(), { overrides: { service: { http: { port: 0 } } } });
    const server = await app.start();
    const base = `http://127.0.0.1:${server.address().port}`;
    const { p } = await openProposal(app, { blocked: [] });
    await G(app).rejectPage(p.id, 'delta', ada);
    await setJobStatus(app, app.ingest.jobs.at(-1).id, 'failed', 'x');
    const page1 = await (await login(base)).get(`/inbox/p/${p.id}`);
    assert.match(page1.text, />Run it again</);
    assert.ok(!page1.text.includes('Go on without it'));
    await app.stop();
  });
});

describe('agent work: the inbox', () => {
  it('a failed entry shows what was asked, the error and a button; a pending one says the agent is working', async () => {
    const { app, base, p, reviseJob } = await serveFailed();
    const c = await login(base);
    const res = await c.get(`/inbox/p/${p.id}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /The agent could not finish applying your answer to “Is the refund window 30 or 45 days\?”/);
    assert.match(res.text, /Agent exited with code 1 second line/);
    assert.match(res.text, new RegExp(`action="/inbox/p/${p.id}/work/${reviseJob.id}/retry"`));
    assert.match(res.text, />Run it again</);
    assert.match(res.text, /Not applied yet\./);
    assert.match(res.text, /1 answer not applied yet|not applied yet/);
    assert.ok(!res.text.includes('Approve all'), 'no approve button while the agent has not finished');
    assert.match(res.text, /The agent could not finish what it was asked to do on this proposal/);
    const queue = await c.get('/inbox');
    assert.match(queue.text, /1 answer not applied yet/);

    await setJobStatus(app, reviseJob.id, 'running');
    const working = await c.get(`/inbox/p/${p.id}`);
    assert.match(working.text, /The agent is applying your answer to “Is the refund window 30 or 45 days\?”/);
    assert.ok(!working.text.includes('/retry"'));
    assert.match(working.text, /The agent is working on it\./);
    await app.stop();
  });

  it('a reviewer posts the button and the agent is asked again; the person stays on the proposal', async () => {
    const { app, base, p, reviseJob } = await serveFailed();
    const c = await login(base, 'bob-signin-2');
    const page1 = await c.get(`/inbox/p/${p.id}`);
    const res = await c.post(`/inbox/p/${p.id}/work/${reviseJob.id}/retry`, { form: { csrf: c.csrfFrom(page1.text) } });
    assert.equal(res.status, 303);
    assert.match(res.location, new RegExp(`^/inbox/p/${p.id}\\?m=agent_retried`));
    const stored = await app.ctx.governance.getProposal(p.id);
    assert.notEqual(stored.work[0].jobId, reviseJob.id);
    assert.equal(app.ingest.jobs.at(-1).requestedBy, 'usr_bob');
    const done = await c.get(res.location);
    assert.match(done.text, /Sent to the agent again/);
    assert.match((await c.get('/inbox/activity')).text, /asked the agent to run a request again on/);
    await app.stop();
  });

  it('a missing CSRF token, a viewer, a bearer token and a job that did not fail are all refused', async () => {
    const { app, base, p, reviseJob } = await serveFailed();
    const before = JSON.stringify(await app.ctx.governance.getProposal(p.id));
    const url = `/inbox/p/${p.id}/work/${reviseJob.id}/retry`;

    const c = await login(base);
    assert.equal((await c.post(url, { form: { csrf: 'wrong' } })).status, 403);
    assert.equal((await c.post(url, { form: {} })).status, 403);

    const v = await login(base, 'vic-signin-3');
    const vp = await v.get(`/inbox/p/${p.id}`);
    assert.ok(!vp.text.includes('/retry"'), 'a viewer gets no button');
    assert.equal((await v.post(url, { form: { csrf: v.csrfFrom(vp.text) } })).status, 403);

    const bearer = { authorization: 'Bearer bob-secret-2', 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}${url}`, { method: 'POST', headers: bearer, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/proposals/${p.id}/work/${reviseJob.id}/retry`, { method: 'POST', headers: bearer, body: '{}' })).status, 403);
    assert.equal(JSON.stringify(await app.ctx.governance.getProposal(p.id)), before);

    // the API mirror: a browser session with the CSRF header works
    const page1 = await c.get(`/inbox/p/${p.id}`);
    const csrf = c.csrfFrom(page1.text);
    const ok = await c.post(`/api/proposals/${p.id}/work/${reviseJob.id}/retry`, { json: {}, headers: { 'x-almagest-csrf': csrf } });
    assert.equal(ok.status, 200, ok.text);
    assert.notEqual(JSON.parse(ok.text).work[0].jobId, reviseJob.id);
    // the old job is no longer in the list, so asking again for it is refused
    const stale = await c.post(url, { form: { csrf } });
    assert.equal(stale.status, 404);
    await app.stop();
  });
});
