import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { agentActor, humanActor, serviceActor } from '../../src/core/auth.mjs';
import { loadServiceConfig } from '../../src/core/config.mjs';
import {
  assertMayApprove, computeRequirements, decisionRoles, distinctTeamCount, evaluate, globToRegExp, validateRules,
} from '../../src/governance/policy.mjs';
import { cleanup, repo } from './fixtures.mjs';
import { after } from 'node:test';

after(cleanup);

const HEAD = 'h2';
const ada = humanActor({ id: 'usr_ada', display: 'Ada', roles: ['owner'], teams: ['engineering'] });
const bob = humanActor({ id: 'usr_bob', display: 'Bob', roles: ['reviewer'], teams: ['product'] });
const cat = humanActor({ id: 'usr_cat', display: 'Cat', roles: ['reviewer'], teams: ['engineering'] });

const change = (slug, extra = {}) => ({ slug, title: slug.toUpperCase(), tier: 'curated', action: 'update', hot: false, owner: '', claims: [], pageStatus: 'pending', ...extra });
const appr = (a, scope = 'all', headSha = HEAD) => ({ actorId: a.id, display: a.display, kind: a.kind, roles: a.roles, teams: a.teams, scope, channel: 'web', headSha });

function proposal({ changes = [change('alpha')], approvals = [], rules = [], decisions = [], status = 'open', audit = { exit: 0, errors: 0 }, submittedBy = 'usr_sub', submitters = [] } = {}) {
  const p = { id: 'prp_1', headSha: HEAD, status, audit, changes, approvals, submittedBy, submitters };
  p.required = computeRequirements({ changes, decisions, rules });
  return p;
}

function profileRules(profile) {
  return loadServiceConfig(repo(), { overrides: { service: { profile } }, env: { DATABASE_URL: 'x' } }).governance;
}

describe('policy: invariants', () => {
  it('needs at least one human approval, even when no rule asks for any', () => {
    const p = proposal({ rules: [{ when: {}, require: { approvals: 0 } }] });
    const ev = evaluate({ proposal: { ...p, required: { ...p.required, approvals: 0 } } });
    assert.equal(ev.ready, false);
    assert.equal(ev.missing[0].code, 'human');
    assert.ok(evaluate({ proposal: proposal({ approvals: [appr(ada)] }) }).ready);
  });

  it('an approval only counts for the headSha it was given for', () => {
    const ev = evaluate({ proposal: proposal({ approvals: [appr(ada, 'all', 'h1')] }) });
    assert.equal(ev.ready, false);
    assert.equal(ev.approvers.length, 0);
  });

  it('agents and services can never approve, whatever the record claims', () => {
    const agent = agentActor('claude-code', ada);
    assert.throws(() => assertMayApprove(proposal(), agent), /cannot approve/);
    assert.throws(() => assertMayApprove(proposal(), serviceActor('ingest')), /cannot approve/);
    const forged = { ...appr(ada), kind: 'agent' };
    assert.equal(evaluate({ proposal: proposal({ approvals: [forged] }) }).ready, false);
    assert.throws(() => assertMayApprove(proposal(), humanActor({ id: 'v', roles: ['viewer'] })), /approver role/);
  });

  it('separation of duties: the submitter and the human an agent acted for cannot approve', () => {
    const p = proposal({ submittedBy: 'agent:mcp:claude', submitters: ['agent:mcp:claude', 'usr_ada'] });
    assert.throws(() => assertMayApprove(p, ada, { separationOfDuties: true }), /separation of duties/);
    assert.doesNotThrow(() => assertMayApprove(p, ada, { separationOfDuties: false }));
    assert.doesNotThrow(() => assertMayApprove(p, bob, { separationOfDuties: true }));
    // A recorded approval from the submitter does not count once SoD is on.
    const withSelf = { ...p, approvals: [appr(ada)] };
    assert.equal(evaluate({ proposal: withSelf, options: { separationOfDuties: true } }).ready, false);
    assert.equal(evaluate({ proposal: withSelf, options: { separationOfDuties: false } }).ready, true);
  });

  it('open decisions block the merge; resolved ones do not', () => {
    const p = proposal({ approvals: [appr(ada)] });
    const ev = evaluate({ proposal: p, decisions: [{ status: 'open', kind: 'contradiction' }] });
    assert.equal(ev.ready, false);
    assert.equal(ev.blockers[0].code, 'decisions');
    assert.ok(evaluate({ proposal: p, decisions: [{ status: 'resolved', kind: 'contradiction' }] }).ready);
  });

  it('an audit exit other than 0 blocks the merge', () => {
    for (const exit of [1, 2, null]) {
      const ev = evaluate({ proposal: proposal({ approvals: [appr(ada)], audit: { exit, errors: 3 } }) });
      assert.equal(ev.ready, false, `exit ${exit}`);
      assert.ok(ev.blockers.some((b) => b.code === 'audit'));
    }
  });

  it('a proposal that modifies a canonical page never merges, however many approvals', () => {
    const changes = [change('taxonomy', { canonical: true, tier: 'canonical' })];
    const p = proposal({ changes, approvals: [appr(ada), appr(bob), appr(cat), appr(ada, 'taxonomy')] });
    const ev = evaluate({ proposal: p });
    assert.equal(ev.ready, false);
    assert.ok(ev.blockers.some((b) => b.code === 'canonical' && b.slug === 'taxonomy'));
    assert.deepEqual(p.required.canonical, ['taxonomy']);
  });

  it('pages a reviewer took out block until the agent has removed them', () => {
    const p = proposal({ changes: [change('alpha'), change('beta', { pageStatus: 'rejected' })], approvals: [appr(ada)] });
    assert.ok(evaluate({ proposal: p }).blockers.some((b) => b.code === 'page-removal'));
  });

  it('merged / rejected proposals cannot be approved', () => {
    assert.throws(() => assertMayApprove(proposal({ status: 'merged' }), ada), /already added/);
    assert.throws(() => assertMayApprove(proposal({ status: 'rejected' }), ada), /turned down/);
  });

  it('require_sso_for_approval refuses non-SSO identities (but not a GitHub merge)', () => {
    assert.throws(() => assertMayApprove(proposal(), { ...ada, idp: 'token' }, { requireSso: true }), /single sign-on/);
    assert.doesNotThrow(() => assertMayApprove(proposal(), { ...ada, idp: 'oidc' }, { requireSso: true }));
    assert.doesNotThrow(() => assertMayApprove(proposal(), { ...ada, idp: 'github' }, { requireSso: true, channel: 'github-pr' }));
  });
});

describe('policy: profile defaults', () => {
  const hot = [change('alpha', { hot: true }), change('beta')];

  it('solo: one approval; a hot page needs its own explicit approval', () => {
    const { rules, separation_of_duties: sod } = profileRules('solo');
    assert.equal(sod, false);
    const all = proposal({ changes: hot, rules, approvals: [appr(ada)] });
    const ev = evaluate({ proposal: all });
    assert.equal(ev.ready, false);
    assert.match(ev.missing[0].message, /for the page “ALPHA”/);
    assert.match(ev.missing[0].message, /accept that page itself/);
    const both = proposal({ changes: hot, rules, approvals: [appr(ada), appr(ada, 'alpha')] });
    assert.ok(evaluate({ proposal: both }).ready);
    // A proposal with no hot page: one "approve all" is enough.
    assert.ok(evaluate({ proposal: proposal({ rules, approvals: [appr(ada)] }) }).ready);
    // Accepting every page one by one also counts as approving the whole thing.
    assert.ok(evaluate({ proposal: proposal({ changes: hot, rules, approvals: [appr(ada, 'alpha'), appr(ada, 'beta')] }) }).ready);
  });

  it('team: SoD on, hot pages need two people on that page', () => {
    const { rules, separation_of_duties: sod } = profileRules('team');
    assert.equal(sod, true);
    const one = proposal({ changes: hot, rules, approvals: [appr(ada), appr(ada, 'alpha')] });
    const ev = evaluate({ proposal: one, options: { separationOfDuties: true } });
    assert.equal(ev.ready, false);
    assert.match(ev.explanation, /Needs 1 more approval for the page “ALPHA”/);
    const two = proposal({ changes: hot, rules, approvals: [appr(ada), appr(ada, 'alpha'), appr(bob, 'alpha')] });
    assert.ok(evaluate({ proposal: two, options: { separationOfDuties: true } }).ready);
  });

  it('enterprise: hot pages need two approvals including one from the page owner team', () => {
    const { rules, require_sso_for_approval: sso } = profileRules('enterprise');
    assert.equal(sso, true);
    const changes = [change('alpha', { hot: true, owner: 'engineering' })];
    const p1 = proposal({ changes, rules, approvals: [appr(bob), appr(bob, 'alpha')] });
    const ev = evaluate({ proposal: p1 });
    assert.equal(ev.ready, false);
    assert.match(ev.explanation, /Needs 1 more approval from someone in team engineering for the page “ALPHA”/);
    const p2 = proposal({ changes, rules, approvals: [appr(bob), appr(bob, 'alpha'), appr(cat, 'alpha')] });
    assert.ok(evaluate({ proposal: p2 }).ready);
  });

  it('enterprise: a canonical_conflict decision requires an owner', () => {
    const { rules } = profileRules('enterprise');
    assert.deepEqual(decisionRoles('canonical_conflict', rules), ['owner']);
    const p = proposal({ rules, decisions: [{ kind: 'canonical_conflict', status: 'resolved' }], approvals: [appr(bob)] });
    p.required = computeRequirements({ changes: p.changes, decisions: [{ kind: 'canonical_conflict' }], rules });
    assert.match(evaluate({ proposal: p }).explanation, /owner role/);
    p.approvals.push(appr(ada));
    assert.ok(evaluate({ proposal: p }).ready);
  });
});

describe('policy: rules', () => {
  it('owner_team on a page without an owner falls back to the owner role', () => {
    const rules = [{ when: { tier: 'curated' }, require: { owner_team: true } }];
    const p = proposal({ rules, approvals: [appr(bob)] });
    assert.match(evaluate({ proposal: p }).explanation, /owner role \(the page has no owner team\)/);
    p.approvals.push(appr(ada));
    assert.ok(evaluate({ proposal: p }).ready);
  });

  it('page-matched rules without per_page raise the proposal bar; combine by max', () => {
    const rules = [
      { when: { page: 'pricing-*' }, require: { approvals: 2 } },
      { when: { action: 'create' }, require: { approvals: 3, roles: ['owner'] } },
    ];
    const r = computeRequirements({ changes: [change('pricing-eu'), change('beta')], rules });
    assert.equal(r.approvals, 2);
    assert.equal(r.perPage, false);
    const r2 = computeRequirements({ changes: [change('pricing-eu', { action: 'create' })], rules });
    assert.equal(r2.approvals, 3);
    assert.deepEqual(r2.roles, ['owner']);
  });

  it('distinct_teams needs different people from different teams', () => {
    const rules = [{ when: {}, require: { approvals: 2, distinct_teams: 2 } }];
    const p = proposal({ rules, approvals: [appr(ada), appr(cat)] });   // both engineering
    assert.match(evaluate({ proposal: p }).explanation, /2 different teams/);
    p.approvals = [appr(ada), appr(bob)];
    assert.ok(evaluate({ proposal: p }).ready);
    assert.equal(distinctTeamCount([{ teams: ['a', 'b'] }]), 1);
    assert.equal(distinctTeamCount([{ teams: ['a', 'b'] }, { teams: ['a'] }]), 2);
  });

  it('label and connector conditions match the source', () => {
    const rules = [{ when: { label: 'finance' }, require: { roles: ['owner'] } }, { when: { connector: 'drive' }, require: { approvals: 2 } }];
    const r = computeRequirements({ changes: [change('a')], rules, label: 'finance', source: { kind: 'connector', connector: 'drive' } });
    assert.deepEqual(r.roles, ['owner']);
    assert.equal(r.approvals, 2);
    assert.equal(computeRequirements({ changes: [change('a')], rules }).approvals, 1);
  });

  it('validates config loudly', () => {
    assert.throws(() => validateRules([{ when: { colour: 'red' } }]), /not a known condition/);
    assert.throws(() => validateRules([{ require: { approvals: -1 } }]), /whole number/);
    assert.throws(() => validateRules([{ require: { roles: ['god'] } }]), /unknown role/);
    assert.throws(() => validateRules([{ when: { decision: 'vibes' } }]), /unknown decision kind/);
    assert.doesNotThrow(() => validateRules([{ when: { hot: true }, require: { approvals: 2, per_page: true } }]));
    assert.ok(globToRegExp('pricing-*').test('pricing-eu'));
    assert.ok(!globToRegExp('pricing-*').test('beta'));
  });
});
