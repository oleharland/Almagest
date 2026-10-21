/**
 * Regression tests for the auth / roles review:
 *   B1  the API token was also an inbox sign-in → separate sign-in secrets
 *       (ALMAGEST_LOGINS) and one-time `almagest login` links; pre-session
 *       POSTs need the browser's same-origin signal
 *   B2a Slack / GitHub used roles cached at the last sign-in forever → max age
 *   B2b single sign-on sessions kept their roles all session → recent roles to act
 *   B2c stored approval roles outlived a demotion → counted with current roles
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { parseLogins, registerAuthProvider, resolveLogins, parseTokens } from '../../src/core/auth.mjs';
import { commands } from '../../src/governance/index.mjs';
import { capRoles, evaluate } from '../../src/governance/policy.mjs';
import { loginLink } from '../../src/governance/sessions.mjs';
import { sign } from '../../src/governance/signing.mjs';
import { ALPHA_V2, CLEAN_AUDIT, cleanup, client, DELTA, govApp, job, proposalBranch, repo, sess } from './fixtures.mjs';

const ENV = {
  ALMAGEST_SECRET_KEY: 'test-secret',
  ALMAGEST_TOKENS: 'ada:owner:ada-api-1;bob:reviewer:bob-api-2',
  ALMAGEST_LOGINS: 'ada:ada-signin-1;bob:bob-signin-2',
  T_SLACK_SECRET: 'slack-signing',
};
const saved = {};
const apps = [];
before(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; } });
after(async () => {
  for (const a of apps) await a.stop().catch(() => {});
  for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  cleanup();
});

// Single sign-on bearer validation lives in core/auth-oidc.mjs (the MCP module); a stand-in here.
registerAuthProvider('oidc', () => ({ name: 'oidc', authenticate: async () => null }));
const OIDC = { auth: { provider: 'oidc', oidc: { issuer: 'https://idp.test', client_id: 'c' } } };

async function serve({ service = {}, governance = {} } = {}) {
  const app = await govApp(repo(), { overrides: { service: { http: { port: 0 }, ...service }, governance } });
  apps.push(app);
  const server = await app.start();
  const base = `http://127.0.0.1:${server.address().port}`;
  const b = await proposalBranch(app, 'ingest/q3-board-deck-abcdef1', { 'brain/wiki/alpha.md': ALPHA_V2, 'brain/wiki/delta.md': DELTA });
  const p = await app.ctx.governance.createFromJob(job(b.branch), { ...b, audit: CLEAN_AUDIT });
  await app.ctx.bus.drain();
  return { app, base, p };
}

async function signIn(base, secret, headers = {}) {
  const c = client(base);
  const lp = await c.get('/inbox/login');
  const res = await c.post('/inbox/login', { form: { csrf: c.csrfFrom(lp.text), secret, next: '/inbox' }, headers });
  return { c, res };
}

/** A browser holding a session record written straight into the store. */
async function plantSession(app, base, rec) {
  const sid = crypto.randomBytes(9).toString('base64url');
  const at = new Date().toISOString();
  await app.ctx.store.kv.set('governance.session', sid, { createdAt: at, rolesAt: at, expiresAt: new Date(Date.now() + 3600e3).toISOString(), revoked: false, ...rec });
  const c = client(base);
  c.jar.set('almagest_session', encodeURIComponent(sign(ENV.ALMAGEST_SECRET_KEY, 'session', { sid, exp: Date.now() + 3600e3 })));
  return { c, sid };
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();

describe('B1 · API tokens and sign-in secrets are separate', () => {
  it('an API token posted to /inbox/login is refused, and no session is opened', async () => {
    const { base } = await serve();
    const { c, res } = await signIn(base, 'ada-api-1');
    assert.equal(res.status, 401);
    assert.match(res.text, /That&#39;s an API token/);
    assert.equal(c.jar.get('almagest_session'), undefined);
    assert.equal((await c.get('/inbox')).status, 303, 'still signed out');

    const ok = await signIn(base, 'ada-signin-1');
    assert.equal(ok.res.status, 303);
    assert.equal((await ok.c.get('/inbox')).status, 200);
  });

  it('a sign-in secret used as a bearer token is refused', async () => {
    const { base } = await serve();
    const api = await fetch(`${base}/api/proposals`, { headers: { authorization: 'Bearer ada-signin-1' } });
    assert.equal(api.status, 401);
    const header = await fetch(`${base}/api/proposals`, { headers: { 'x-almagest-token': 'ada-signin-1' } });
    assert.equal(header.status, 401);
    const real = await fetch(`${base}/api/proposals`, { headers: { authorization: 'Bearer ada-api-1' } });
    assert.equal(real.status, 200, 'the API token still reads');
  });

  it('a sign-in POST without a same-origin signal is refused; a browser\'s is accepted', async () => {
    const { base } = await serve();
    const none = await signIn(base, 'ada-signin-1', { origin: null });
    assert.equal(none.res.status, 403, 'no Origin, no Sec-Fetch-Site: a script, not a form');
    assert.equal(none.c.jar.get('almagest_session'), undefined);
    assert.equal((await signIn(base, 'ada-signin-1', { origin: 'null' })).res.status, 403);
    assert.equal((await signIn(base, 'ada-signin-1', { origin: 'https://evil.example' })).res.status, 403);
    assert.equal((await signIn(base, 'ada-signin-1', { origin: null, 'sec-fetch-site': 'cross-site' })).res.status, 403);
    // Under Referrer-Policy: no-referrer a browser sends Origin: null with Sec-Fetch-Site: same-origin.
    assert.equal((await signIn(base, 'ada-signin-1', { origin: 'null', 'sec-fetch-site': 'same-origin' })).res.status, 303);
    assert.equal((await signIn(base, 'ada-signin-1')).res.status, 303);
  });

  it('keeps the brute-force brake on the sign-in form', async () => {
    const { base } = await serve();
    for (let i = 0; i < 10; i++) assert.equal((await signIn(base, `wrong-${i}`)).res.status, 401);
    const blocked = await signIn(base, 'ada-signin-1');
    assert.equal(blocked.res.status, 429);
    assert.equal(blocked.c.jar.get('almagest_session'), undefined);
  });

  it('a secret that is also an API token, or names nobody, does not sign in', () => {
    const tokens = parseTokens('ada:owner:same-1;bob:reviewer:b-2');
    const { usable, problems } = resolveLogins(tokens, parseLogins('ada:same-1;bob:bob-ok;eve:eve-1'));
    assert.deepEqual(usable.map((l) => l.id), ['usr_bob']);
    assert.equal(problems.length, 2);
    assert.match(problems.join('\n'), /"ada" is also an API token/);
    assert.match(problems.join('\n'), /"eve" is not in ALMAGEST_TOKENS/);
    assert.throws(() => parseLogins('justaname'), /expected name:secret/);
  });

  it('changing someone\'s sign-in secret ends their sessions; old API-token sessions end too', async () => {
    const { app, base } = await serve();
    const { c } = await signIn(base, 'bob-signin-2');
    assert.equal((await c.get('/inbox')).status, 200);
    process.env.ALMAGEST_LOGINS = 'ada:ada-signin-1;bob:bob-rotated-3';
    try {
      assert.equal((await c.get('/inbox')).status, 303);
    } finally { process.env.ALMAGEST_LOGINS = ENV.ALMAGEST_LOGINS; }

    const legacy = await plantSession(app, base, { idp: 'token', actor: { id: 'usr_ada', kind: 'human', display: 'ada', roles: ['owner'], teams: [] } });
    assert.equal((await legacy.c.get('/inbox')).status, 303, 'a session opened with an API token before the split is over');
  });
});

describe('B1 · almagest login links', () => {
  it('a link signs in once, and not after it expires', async () => {
    const { app, base } = await serve();
    const config = app.ctx.config;
    const { url, actor } = loginLink(config, { name: 'bob', next: '/inbox/activity' });
    assert.equal(actor.id, 'usr_bob');
    const path = new URL(url).pathname;
    assert.match(path, /^\/inbox\/login\/link\//);

    const c = client(base);
    const shown = await c.get(path);
    assert.equal(shown.status, 200);
    assert.match(shown.text, /Continue as bob/);
    assert.equal(c.jar.get('almagest_session'), undefined, 'opening the link alone signs nobody in');
    const script = await c.post(path, { form: { csrf: c.csrfFrom(shown.text) }, headers: { origin: null } });
    assert.equal(script.status, 403, 'no same-origin signal');
    const ok = await c.post(path, { form: { csrf: c.csrfFrom(shown.text) } });
    assert.equal(ok.status, 303);
    assert.equal(ok.location, '/inbox/activity');
    assert.equal((await c.get('/inbox')).status, 200);
    const rec = await app.ctx.store.kv.get('governance.session', JSON.parse(Buffer.from(decodeURIComponent(c.jar.get('almagest_session')).split('.')[0], 'base64url').toString()).sid);
    assert.equal(rec.idp, 'login-link');

    const other = client(base);
    const used = await other.get(path);
    assert.equal(used.status, 410, 'used: the GET says so');
    const again = await other.post(path, { form: { csrf: other.csrfFrom(used.text) } });
    assert.equal(again.status, 410, 'used links do not sign in twice');
    assert.equal(other.jar.get('almagest_session'), undefined);

    const expired = loginLink(config, { name: 'ada', minutes: 10, now: Date.now() - 11 * 60 * 1000 });
    const e = client(base);
    assert.equal((await e.get(new URL(expired.url).pathname)).status, 410);

    const forged = loginLink(config, { name: 'ada', env: { ...process.env, ALMAGEST_SECRET_KEY: 'another-key' } });
    assert.equal((await client(base).get(new URL(forged.url).pathname)).status, 410, 'signed with another key');
  });

  it('the CLI explains what it needs, and prints a link', async () => {
    assert.throws(() => loginLink({ service: { auth: { provider: 'token' }, http: { base_url: 'http://x' } } }, { env: { ALMAGEST_TOKENS: 'a:owner:t' } }), /ALMAGEST_SECRET_KEY is not set/);
    assert.throws(() => loginLink({ service: { auth: { provider: 'token' }, http: { base_url: 'http://x' } } }, { env: { ALMAGEST_SECRET_KEY: 'k', ALMAGEST_TOKENS: 'a:owner:t;b:owner:u' } }), /say who to sign in as/);
    assert.throws(() => loginLink({ service: { auth: { provider: 'oidc' }, http: { base_url: 'http://x' } } }, { env: { ALMAGEST_SECRET_KEY: 'k' } }), /single sign-on/);

    const r = repo();
    const out = [];
    const write = process.stdout.write;
    process.stdout.write = (s) => { out.push(String(s)); return true; };
    let code;
    try { code = await commands.login.run(['ada'], { repoRoot: r }); } finally { process.stdout.write = write; }
    assert.equal(code, 0);
    assert.match(out.join(''), /Sign-in link for ada\. It works once/);
    assert.match(out.join(''), /\/inbox\/login\/link\//);
  });
});

describe('B2a · Slack approvals need recently confirmed roles', () => {
  it('a Slack approve with cached roles past the max age does not count', async () => {
    const { app, base, p } = await serve({
      service: OIDC,
      governance: { channel_roles_max_age_hours: 24, channels: [{ kind: 'web' }, { kind: 'slack', signing_secret_env: 'T_SLACK_SECRET', users: { U_ADA: { email: 'ada@acme.test' } } }] },
    });
    const reg = app.ctx.governance.identities;
    await reg.remember({ id: 'usr_sub-ada', kind: 'human', email: 'ada@acme.test', display: 'Ada', roles: ['owner'], idp: 'oidc' });
    const rec = await app.ctx.store.kv.get('governance.identity', 'id:usr_sub-ada');
    await app.ctx.store.kv.set('governance.identity', 'id:usr_sub-ada', { ...rec, confirmedAt: hoursAgo(25) });

    const press = async (ts = Math.floor(Date.now() / 1000)) => {
      const body = `payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions', user: { id: 'U_ADA' }, actions: [{ action_id: 'almagest_approve', value: JSON.stringify({ p: p.id, h: p.headSha }) }] }))}`;
      const sig = `v0=${crypto.createHmac('sha256', ENV.T_SLACK_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
      const res = await fetch(`${base}/channels/slack/actions`, { method: 'POST', headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig, 'content-type': 'application/x-www-form-urlencoded' }, body });
      return res.json();
    };
    const stale = await press();
    assert.match(stale.text, /more than 24 hours ago\. Sign in there again/);
    assert.equal((await app.ctx.governance.getProposal(p.id)).approvals.length, 0);

    // Signing in again refreshes them; then the same button works.
    await reg.remember({ id: 'usr_sub-ada', kind: 'human', email: 'ada@acme.test', display: 'Ada', roles: ['owner'], idp: 'oidc' });
    assert.match((await press(Math.floor(Date.now() / 1000) - 1)).text, /Approved/);   // a new request, not a replay
    assert.equal((await app.ctx.governance.getProposal(p.id)).approvals[0].channel, 'slack');
  });

  it('re-reading cached roles (an email link) never makes them look fresh', async () => {
    const { app } = await serve({ service: OIDC });
    const reg = app.ctx.governance.identities;
    await reg.remember({ id: 'usr_sub-bob', kind: 'human', email: 'bob@acme.test', roles: ['reviewer'], idp: 'oidc' });
    const rec = await app.ctx.store.kv.get('governance.identity', 'id:usr_sub-bob');
    await app.ctx.store.kv.set('governance.identity', 'id:usr_sub-bob', { ...rec, confirmedAt: hoursAgo(30) });
    await reg.remember({ id: 'usr_sub-bob', kind: 'human', email: 'bob@acme.test', roles: ['admin'], idp: 'email-link' }, { confirmed: false });
    const now = await reg.byId('usr_sub-bob');
    assert.ok(Date.parse(now.confirmedAt) < Date.now() - 29 * 3600e3, 'age kept');
    assert.deepEqual(now.roles, ['reviewer'], 'roles kept');
    assert.ok((await reg.resolveMapped({ email: 'bob@acme.test' }, { mode: 'oidc' })).stale);
  });
});

describe('B2b · a session acts only on recently confirmed roles', () => {
  it('a stale single sign-on session cannot approve and is sent to sign in again', async () => {
    const { app, base, p } = await serve({ service: OIDC });
    const ada = { id: 'usr_sub-ada', kind: 'human', display: 'Ada', email: 'ada@acme.test', roles: ['owner'], teams: [] };
    const { c } = await plantSession(app, base, { idp: 'oidc', actor: ada, createdAt: hoursAgo(2), rolesAt: hoursAgo(2) });
    const page = await c.get(`/inbox/p/${p.id}`);
    assert.equal(page.status, 200, 'reading is fine');
    const res = await c.post(`/inbox/p/${p.id}/approve`, { form: { csrf: c.csrfFrom(page.text), scope: 'all', headSha: p.headSha } });
    assert.equal(res.status, 303);
    assert.equal(res.location, `/inbox/login?m=reauth&next=${encodeURIComponent(`/inbox/p/${p.id}`)}`);
    assert.equal((await app.ctx.governance.getProposal(p.id)).approvals.length, 0);
    const login = await c.get(res.location);
    assert.equal(login.status, 200, 'the sign-in page shows although a session exists');
    assert.match(login.text, /Please sign in again/);

    const rej = await c.post(`/inbox/p/${p.id}/reject`, { form: { csrf: c.csrfFrom(page.text), reason: 'no' } });
    assert.match(rej.location, /m=reauth/);
    assert.equal((await app.ctx.governance.getProposal(p.id)).status, 'open');

    // A fresh sign-in elsewhere confirms the roles again, for this session too.
    await app.ctx.governance.identities.remember({ ...ada, idp: 'oidc' });
    const ok = await c.post(`/inbox/p/${p.id}/approve`, { form: { csrf: c.csrfFrom(page.text), scope: 'all', headSha: p.headSha } });
    assert.equal(ok.location, `/inbox/p/${p.id}?m=merged`);
  });

  it('the service refuses an old session for every review action', async () => {
    const { app, p } = await serve({ service: OIDC });
    const gov = app.ctx.governance;
    const old = sess({ id: 'usr_ada', kind: 'human', display: 'Ada', roles: ['owner'], teams: [] }, { rolesAt: hoursAgo(2) });
    const reauth = (err) => err.code === 'reauth' && /sign in again/.test(err.message);
    await assert.rejects(() => gov.approve(p.id, old, { headSha: p.headSha }), reauth);
    await assert.rejects(() => gov.reject(p.id, old), reauth);
    await assert.rejects(() => gov.rejectPage(p.id, 'delta', old), reauth);
    await assert.rejects(() => gov.requestChanges(p.id, old, { feedback: 'x' }), reauth);
    await assert.rejects(() => gov.retryMerge(p.id, old), reauth);
    const noTime = sess({ id: 'usr_ada', kind: 'human', display: 'Ada', roles: ['owner'], teams: [] }, { rolesAt: '' });
    await assert.rejects(() => gov.approve(p.id, noTime, { headSha: p.headSha }), reauth);
  });

  it('a demotion seen at a later sign-in applies to the sessions already open', async () => {
    const { app, base, p } = await serve({ service: OIDC });
    const bob = { id: 'usr_sub-bob', kind: 'human', display: 'Bob', email: 'bob@acme.test', roles: ['reviewer'], teams: [] };
    const { c } = await plantSession(app, base, { idp: 'oidc', actor: bob });
    await app.ctx.governance.identities.remember({ ...bob, roles: ['viewer'], idp: 'oidc' });
    const page = await c.get(`/inbox/p/${p.id}`);
    const res = await c.post(`/inbox/p/${p.id}/approve`, { form: { csrf: c.csrfFrom(page.text), scope: 'all', headSha: p.headSha } });
    assert.equal(res.status, 403);
    assert.match(res.text, /no approver role/);
  });
});

describe('B2c · approvals count with the approver\'s current roles', () => {
  it('capRoles never gives more than then or now', () => {
    assert.deepEqual(capRoles(['reviewer'], ['viewer']), []);
    assert.deepEqual(capRoles(['reviewer'], ['owner']), []);
    assert.deepEqual(capRoles(['owner', 'reviewer'], ['reviewer']), ['reviewer']);
    assert.deepEqual(capRoles(['admin'], ['owner']), ['owner']);
    assert.deepEqual(capRoles(['reviewer'], ['admin']), ['reviewer']);
  });

  it('an approval from a reviewer who is then demoted no longer satisfies the policy (tokens)', async () => {
    const { app, p } = await serve({ governance: { rules: [{ when: {}, require: { approvals: 2 } }] } });
    const gov = app.ctx.governance;
    const bob = sess({ id: 'usr_bob', kind: 'human', display: 'bob', roles: ['reviewer'], teams: [] });
    const ada = sess({ id: 'usr_ada', kind: 'human', display: 'ada', roles: ['owner'], teams: [] });
    await gov.approve(p.id, bob, { headSha: p.headSha });
    process.env.ALMAGEST_TOKENS = 'ada:owner:ada-api-1;bob:viewer:bob-api-2';
    try {
      const out = await gov.approve(p.id, ada, { headSha: p.headSha });
      assert.equal(out.status, 'open', 'one approval left that counts');
      const { evaluation } = await gov.evaluate(p.id);
      assert.equal(evaluation.ready, false);
      assert.match(evaluation.explanation, /Needs 1 more approval/);
      assert.deepEqual(evaluation.approvers.map((a) => a.actorId), ['usr_ada']);
    } finally { process.env.ALMAGEST_TOKENS = ENV.ALMAGEST_TOKENS; }
    assert.equal((await gov.evaluate(p.id)).evaluation.ready, true, 'restored, it counts again');
  });

  it('under single sign-on, the latest sign-in\'s roles apply', async () => {
    const { app, p } = await serve({ service: OIDC });
    const gov = app.ctx.governance;
    const bob = { id: 'usr_sub-bob', kind: 'human', display: 'Bob', email: 'bob@acme.test', roles: ['reviewer'], teams: [] };
    await gov.identities.remember({ ...bob, idp: 'oidc' });
    // Bob's approval as it was recorded, before any merge attempt.
    const approval = { actorId: bob.id, display: 'Bob', email: bob.email, kind: 'human', roles: ['reviewer'], teams: [], idp: 'oidc', at: new Date().toISOString(), scope: 'all', channel: 'web', headSha: p.headSha };
    await app.ctx.store.proposals.update(p.id, { approvals: [approval] });
    assert.equal((await gov.evaluate(p.id)).evaluation.ready, true);
    await gov.identities.remember({ ...bob, roles: ['viewer'], idp: 'oidc' });
    const { evaluation } = await gov.evaluate(p.id);
    assert.equal(evaluation.ready, false, 'demoted at the IdP, seen at the next sign-in: the approval no longer counts');
  });

  it('evaluate() without current roles keeps the stored ones (pure callers)', () => {
    const approvals = [{ actorId: 'usr_b', kind: 'human', roles: ['reviewer'], headSha: 'h', scope: 'all' }];
    const base = { headSha: 'h', status: 'open', audit: { exit: 0 }, changes: [{ slug: 'a', pageStatus: 'pending' }], approvals, files: [] };
    assert.equal(evaluate({ proposal: base }).ready, true);
    assert.equal(evaluate({ proposal: base, options: { currentRoles: new Map([['usr_b', ['viewer']]]) } }).ready, false);
  });
});
