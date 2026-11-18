import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { tierOfText } from '../../../tools/lib/canonical.mjs';
import { agentActor, humanActor } from '../../src/core/auth.mjs';
import { createMerger } from '../../src/governance/merge.mjs';
import { writableMatcher } from '../../src/governance/paths.mjs';
import { vouch } from '../../src/governance/trust.mjs';
import { ada, ALPHA_V2, bob, CLEAN_AUDIT, cleanup, DELTA, G, git, govApp, job, proposalBranch, repo, repos, sess, vic } from './fixtures.mjs';

after(cleanup);

const show = (r, ref, file) => git(r, 'show', `${ref}:${file}`);
const tierOn = (r, ref, slug) => tierOfText(show(r, ref, `brain/wiki/${slug}.md`));

async function boot(overrides = {}) {
  const r = repo();
  git(r, 'checkout', '-q', '--detach');
  const app = await govApp(r, { overrides });
  return { r, app, gov: G(app) };
}

async function openProposal(app, files = { 'brain/wiki/alpha.md': ALPHA_V2, 'brain/wiki/delta.md': DELTA }, branch = 'ingest/q3-board-deck-abcdef1') {
  const b = await proposalBranch(app, branch, files);
  const p = await G(app).createFromJob(job(branch), { ...b, audit: CLEAN_AUDIT, runReport: { source: { id: 'alpha-pdf' }, outcome: 'written', pages: [] } });
  return { ...b, p };
}

describe('tier control on a page in an open proposal', () => {
  it('writes one commit that changes only the tier line, authored by the person, and moves the reviewed version', async () => {
    const { r, app, gov } = await boot({ governance: { rules: [{ when: {}, require: { approvals: 2 } }] } });
    const { p, headSha } = await openProposal(app);
    await gov.approve(p.id, bob);
    const out = await gov.setPageTier(p.id, 'delta', 'evidence', bob, { headSha });
    assert.notEqual(out.headSha, headSha);
    assert.equal(git(r, 'rev-parse', p.branch).trim(), out.headSha);
    assert.equal(out.revision, 2);
    assert.deepEqual(git(r, 'diff', '--name-only', headSha, out.headSha).trim().split('\n'), ['brain/wiki/delta.md']);
    const diff = git(r, 'diff', '-U0', headSha, out.headSha).split('\n').filter((l) => /^[+-][^+-]/.test(l));
    assert.deepEqual(diff, ['-tier: curated', '+tier: evidence']);
    assert.equal(git(r, 'log', '-1', '--format=%an <%ae>|%cn', out.headSha).trim(), 'Bob <bob@acme.test>|governance');
    assert.equal(out.changes.find((c) => c.slug === 'delta').tier, 'evidence');
    // Bob's approval was for the earlier version: it no longer counts.
    const ev = (await gov.evaluate(p.id)).evaluation;
    assert.equal(ev.ready, false);
    assert.equal(ev.approvers.length, 0);
    assert.equal((await gov.getProposal(p.id)).approvals.length, 1);
  });

  it('is not kept when the audit fails on it: the branch stays where it was', async () => {
    const { r, app, gov } = await boot();
    const broken = DELTA.replace('[source: alpha-pdf, p.1]', '[source: nope, p.1]');
    const { p, headSha } = await openProposal(app, { 'brain/wiki/delta.md': broken });
    await assert.rejects(() => gov.setPageTier(p.id, 'delta', 'evidence', bob, { headSha }), /was not kept.*CITE-002/);
    assert.equal(git(r, 'rev-parse', p.branch).trim(), headSha);
    assert.equal((await gov.getProposal(p.id)).headSha, headSha);
  });

  it('canonical needs the owner role, an explicit confirm, and a person: then the page merges as canonical', async () => {
    const { r, app, gov } = await boot();
    const { p, headSha } = await openProposal(app);
    await assert.rejects(() => gov.setPageTier(p.id, 'delta', 'canonical', bob, { headSha, confirm: true }), /needs the owner role/);
    await assert.rejects(() => gov.setPageTier(p.id, 'delta', 'canonical', ada, { headSha }), /confirm/);
    const out = await gov.setPageTier(p.id, 'delta', 'canonical', ada, { headSha, confirm: true });
    const change = out.changes.find((c) => c.slug === 'delta');
    assert.equal(change.canonical, false);
    assert.equal(change.tierSetBy.by, 'usr_ada');
    assert.equal(out.required.canonical.length, 0);
    const done = await gov.approve(p.id, ada);
    assert.equal(done.status, 'merged', done.mergeError?.message);
    assert.equal(tierOn(r, 'main', 'delta'), 'canonical');
    // From here the page is locked.
    await assert.rejects(() => gov.setPageTier(p.id, 'delta', 'curated', ada, { headSha: done.headSha }), /./);
  });

  it('a canonical tier nobody chose in the inbox blocks the proposal and cannot merge', async () => {
    const { r, app, gov } = await boot();
    const { p } = await openProposal(app, { 'brain/wiki/delta.md': DELTA.replace('tier: curated', 'tier: canonical') });
    assert.equal(p.changes[0].canonical, true);
    assert.equal(p.changes[0].promotes, true);
    assert.ok((await gov.evaluate(p.id)).evaluation.blockers.some((b) => b.code === 'canonical'));
    // Straight at the merge, past the policy: refused too.
    const { config, git: g, log } = app.ctx;
    const merger = createMerger({ git: g, config, log, allowed: writableMatcher({ brainDir: config.v1.brainDir, manifestPath: config.v1.manifestPath, challengesPath: config.v1.challengesPath, indexDir: config.v1.indexDir }) });
    const before = git(r, 'rev-parse', 'main').trim();
    const out = await merger.merge(await gov.getProposal(p.id), { approvers: [{ display: 'Ada', actorId: 'usr_ada', channel: 'web' }], author: { name: 'Ada', email: 'a@a' } });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'canonical');
    assert.equal(git(r, 'rev-parse', 'main').trim(), before);
  });
});

describe('tier change on a page already on main', () => {
  it('in a solo brain promotion is one action: proposed, approved, merged, logged', async () => {
    const { r, app, gov } = await boot();
    const out = await gov.proposeTier('beta', 'canonical', ada, { confirm: true });
    assert.equal(out.status, 'merged', out.mergeError?.message);
    assert.equal(out.kind, 'tier');
    assert.match(out.branch, /^ingest\/tier-beta-[0-9a-f]{7}$/);
    assert.equal(out.title, 'Ada wants to make “Beta Appliance” canonical.');
    assert.equal(tierOn(r, 'main', 'beta'), 'canonical');
    assert.match(show(r, 'main', 'brain/log.md'), /Ada wants to make “Beta Appliance” canonical\. — approved by Ada \(web\)/);
    assert.equal(git(r, 'log', '-1', '--format=%an', 'main').trim(), 'Ada');
  });

  it('demotion is allowed, and open challenges stay in the ledger', async () => {
    const { r, app, gov } = await boot();
    await gov.proposeTier('beta', 'canonical', ada, { confirm: true });
    const ledger = show(r, 'main', 'brain/canonical-challenges.md');
    const down = await gov.proposeTier('beta', 'curated', ada);
    assert.equal(down.status, 'merged', down.mergeError?.message);
    assert.equal(tierOn(r, 'main', 'beta'), 'curated');
    assert.equal(show(r, 'main', 'brain/canonical-challenges.md'), ledger);
  });

  it('in a team brain the proposer cannot approve their own, so it waits for another owner', async () => {
    const { r, app, gov } = await boot({ governance: { separation_of_duties: true } });
    const out = await gov.proposeTier('beta', 'evidence', bob);
    assert.equal(out.status, 'open');
    assert.equal(out.approvals.length, 0);
    assert.equal(tierOn(r, 'main', 'beta'), 'curated');
    const done = await gov.approve(out.id, ada);
    assert.equal(done.status, 'merged', done.mergeError?.message);
    assert.equal(tierOn(r, 'main', 'beta'), 'evidence');
  });

  it('a promotion waiting in the inbox needs the canonical role from its approver', async () => {
    const { app, gov } = await boot({ governance: { separation_of_duties: true } });
    const out = await gov.proposeTier('beta', 'canonical', ada, { confirm: true });
    assert.equal(out.status, 'open');
    assert.deepEqual(out.required.roles, ['owner']);
    const bobOut = await gov.approve(out.id, bob);
    assert.equal(bobOut.status, 'open');
    assert.match((await gov.evaluate(out.id)).evaluation.explanation, /owner role/);
  });

  it('the merge refuses a tier proposal whose branch changes anything but the tier line', async () => {
    const { r, app, gov } = await boot({ governance: { separation_of_duties: true } });
    const out = await gov.proposeTier('beta', 'evidence', bob);
    const wt = await app.ctx.git.worktreeAdd(out.branch);
    const f = path.join(wt, 'brain/wiki/beta.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf-8').replace('2U rack appliance', '9U rack appliance'));
    const head = await app.ctx.git.commitAll(wt, { message: 'sneak', author: { name: 'x', email: 'x@x' } });
    await app.ctx.git.run(['worktree', 'remove', '--force', wt]);
    await app.ctx.store.proposals.update(out.id, { headSha: head });
    const done = await gov.approve(out.id, ada);
    assert.equal(done.status, 'open');
    assert.equal(done.mergeError.reason, 'tier');
    assert.match(done.mergeError.message, /more than the tier line/);
    assert.equal(tierOn(r, 'main', 'beta'), 'curated');
  });

  it('refuses a page locked in brain.config.yaml and a second open change for the same page', async () => {
    const { r, app, gov } = await boot({ governance: { separation_of_duties: true } });
    await gov.proposeTier('beta', 'evidence', bob);
    await assert.rejects(() => gov.proposeTier('beta', 'canonical', ada, { confirm: true }), /already waiting/);
    await assert.rejects(() => gov.proposeTier('nope', 'curated', bob), /no page/);
    await assert.rejects(() => gov.proposeTier('../x', 'curated', bob), /not a page name/);
    void r;
  });
});

describe('who may change a tier, and through which door', () => {
  const token = humanActor({ id: 'usr_ada', display: 'Ada', roles: ['owner'] });   // not vouched: an API token
  const slack = vouch({ ...ada }, 'slack');

  it('viewers, agents, tokens and every other channel are refused, on both actions', async () => {
    const { app, gov } = await boot();
    const { p, headSha } = await openProposal(app);
    const both = (actor, channel = 'web') => [
      () => gov.proposeTier('beta', 'evidence', actor, { channel }),
      () => gov.setPageTier(p.id, 'delta', 'evidence', actor, { channel, headSha }),
      () => gov.dismissHint('beta', actor, { channel }),
    ];
    for (const call of [...both(vic), ...both(agentActor('x', ada)), ...both(token), ...both(slack), ...both(ada, 'slack'), ...both(ada, 'mcp'), ...both(ada, 'github-pr'), ...both(ada, 'email')]) {
      await assert.rejects(call, (err) => err.status === 403 || err.status === 401);
    }
    // Reviewer and owner pass for evidence and curated.
    const okBob = await gov.proposeTier('beta', 'evidence', bob);
    assert.equal(okBob.status, 'merged');
    await assert.rejects(() => gov.proposeTier('alpha', 'canonical', bob, { confirm: true }), /owner role/);
    const stale = sess(humanActor({ id: 'usr_ada', display: 'Ada', roles: ['owner'] }), { rolesAt: '2020-01-01T00:00:00Z' });
    await assert.rejects(() => gov.proposeTier('alpha', 'evidence', stale), /sign in again/);
  });

  it('the policy names the role: governance.canonical_role', async () => {
    const { gov } = await boot({ governance: { canonical_role: 'admin' } });
    await assert.rejects(() => gov.proposeTier('beta', 'canonical', ada, { confirm: true }), /admin role/);
    const admin = sess(humanActor({ id: 'usr_ada', display: 'Ada', roles: ['admin'] }));
    assert.equal((await gov.proposeTier('beta', 'canonical', admin, { confirm: true })).kind, 'tier');
  });
});

describe('a merge made outside the service', () => {
  function handMerge(r, headSha) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-hand-'));
    repos.push(dir);
    git(r, 'worktree', 'add', '-q', '--detach', dir, 'main');
    git(dir, 'merge', '-q', '--no-ff', '--no-commit', headSha);
    execFileSync(process.execPath, [path.resolve(import.meta.dirname, '../../../tools/audit.mjs'), 'index', '--no-color', '--repo', dir]);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'merged by hand');
    const sha = git(dir, 'rev-parse', 'HEAD').trim();
    git(r, 'worktree', 'remove', '--force', dir);
    return sha;
  }

  it('may not make a page canonical, and may not change a canonical page', async () => {
    const { r, app, gov } = await boot();
    const { config, git: g, log } = app.ctx;
    const merger = createMerger({ git: g, config, log, allowed: writableMatcher({ brainDir: config.v1.brainDir, manifestPath: config.v1.manifestPath, challengesPath: config.v1.challengesPath, indexDir: config.v1.indexDir }) });
    // 1: even a person's inbox choice does not count on the external path.
    const { p, headSha } = await openProposal(app);
    const chosen = await gov.setPageTier(p.id, 'delta', 'canonical', ada, { headSha, confirm: true });
    let out = await merger.acceptExternal(chosen, handMerge(r, chosen.headSha));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'canonical');
    // 2: a canonical page on main (by frontmatter) changed by another branch.
    await gov.proposeTier('beta', 'canonical', ada, { confirm: true });
    const beta = show(r, 'main', 'brain/wiki/beta.md').replace('2U rack appliance', '4U rack appliance');
    const other = await openProposal(app, { 'brain/wiki/beta.md': beta }, 'ingest/b-2222222');
    out = await merger.acceptExternal(other.p, handMerge(r, other.headSha));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'canonical');
  });
});
