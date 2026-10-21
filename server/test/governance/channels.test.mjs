import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { registerAuthProvider } from '../../src/core/auth.mjs';
import { verifyGithub } from '../../src/governance/channels/github-pr.mjs';
import { rfc822 } from '../../src/governance/channels/email.mjs';
import { verifySlack } from '../../src/governance/channels/slack.mjs';
import { ALPHA_V2, CLEAN_AUDIT, cleanup, client, DELTA, govApp, job, proposalBranch, repo } from './fixtures.mjs';

const ENV = {
  ALMAGEST_SECRET_KEY: 'test-secret',
  ALMAGEST_TOKENS: 'ada:owner:ada-secret-1',
  T_SLACK_SECRET: 'slack-signing',
  T_GH_SECRET: 'gh-hook',
};
const saved = {};
before(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; } });
after(() => { for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } cleanup(); });

/** A local HTTP sink: records every request, answers with `reply(req, body)`. */
async function sink(reply = () => ({ status: 200, body: '{}' })) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    hits.push({ method: req.method, url: req.url, headers: req.headers, body });
    const out = await reply(req, body);
    res.writeHead(out.status || 200, { 'content-type': out.type || 'application/json', ...(out.headers || {}) });
    res.end(out.body ?? '');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { hits, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function serve(channels, extra = {}) {
  const r = repo();
  const app = await govApp(r, { overrides: { service: { http: { port: 0 }, ...(extra.service || {}) }, governance: { channels, ...(extra.governance || {}) } } });
  const server = await app.start();
  const base = `http://127.0.0.1:${server.address().port}`;
  const b = await proposalBranch(app, 'ingest/q3-board-deck-abcdef1', { 'brain/wiki/alpha.md': ALPHA_V2, 'brain/wiki/delta.md': DELTA });
  const p = await app.ctx.governance.createFromJob(job(b.branch), { ...b, audit: CLEAN_AUDIT });
  await app.ctx.bus.drain();
  return { app, base, p };
}

function slackSigned(secret, body, ts = Math.floor(Date.now() / 1000)) {
  const sig = `v0=${crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
  return { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig, 'content-type': 'application/x-www-form-urlencoded' };
}

describe('channel registry', () => {
  it('an unknown channel kind stops startup', async () => {
    await assert.rejects(() => govApp(repo(), { overrides: { governance: { channels: [{ kind: 'carrier-pigeon' }] } } }), /unknown channel kind "carrier-pigeon"/);
    await assert.rejects(() => govApp(repo(), { overrides: { governance: { channels: [{ kind: 'mcp' }, { kind: 'mcp' }] } } }), /listed twice/);
  });

  it('web is always on, and a failing channel never blocks the action', async () => {
    const app = await govApp(repo(), { overrides: { governance: { channels: [{ kind: 'slack', webhook_env: 'T_SLACK_DEAD' }] } } });
    process.env.T_SLACK_DEAD = 'http://127.0.0.1:1/dead';
    assert.deepEqual(app.ctx.governance.channels.map((c) => c.kind), ['web', 'slack']);
    delete process.env.T_SLACK_DEAD;
    await app.stop();
  });
});

describe('slack', () => {
  it('verifies signatures: good, bad, stale, replayed', () => {
    const body = 'payload=%7B%7D';
    const seen = new Map();
    const h = slackSigned('s', body);
    assert.deepEqual(verifySlack('s', h, body, { seen }), { ok: true });
    assert.equal(verifySlack('s', h, body, { seen }).reason, 'replayed request');
    assert.equal(verifySlack('s', { ...h, 'x-slack-signature': 'v0=00' }, body).reason, 'bad signature');
    assert.equal(verifySlack('s', h, `${body}x`).reason, 'bad signature');
    assert.equal(verifySlack('s', slackSigned('s', body, Math.floor(Date.now() / 1000) - 301), body).reason, 'request is too old');
    assert.equal(verifySlack('s', {}, body).reason, 'missing signature');
  });

  it('notifies with Block Kit and approves only for mapped users', async () => {
    const hook = await sink();
    process.env.T_SLACK_HOOK = `${hook.url}/hook`;
    const { app, base, p } = await serve([
      { kind: 'web' },
      { kind: 'slack', webhook_env: 'T_SLACK_HOOK', signing_secret_env: 'T_SLACK_SECRET', users: { U_ADA: { id: 'usr_ada', display: 'Ada', roles: ['owner'] } } },
    ]);
    const msg = JSON.parse(hook.hits[0].body);
    assert.match(msg.blocks[0].text.text, /New material to review: New material from “Q3 board deck”/);
    const buttons = msg.blocks[1].elements;
    assert.deepEqual(buttons.map((b) => b.action_id), ['almagest_approve', 'almagest_changes', 'almagest_open']);
    assert.deepEqual(JSON.parse(buttons[0].value), { p: p.id, h: p.headSha });
    assert.equal(buttons[2].url, `${app.ctx.config.service.http.base_url}/inbox/p/${p.id}`);

    const press = async (user, value = buttons[0].value) => {
      const body = `payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions', user: { id: user }, actions: [{ action_id: 'almagest_approve', value }] }))}`;
      const res = await fetch(`${base}/channels/slack/actions`, { method: 'POST', headers: slackSigned(ENV.T_SLACK_SECRET, body), body });
      return { status: res.status, json: await res.json() };
    };
    const bad = await fetch(`${base}/channels/slack/actions`, { method: 'POST', headers: slackSigned('wrong', 'payload=%7B%7D'), body: 'payload=%7B%7D' });
    assert.equal(bad.status, 401);

    const stranger = await press('U_EVE');
    assert.match(stranger.json.text, /isn't linked to Almagest/);
    assert.equal((await app.ctx.governance.getProposal(p.id)).approvals.length, 0);

    const stale = await press('U_ADA', JSON.stringify({ p: p.id, h: 'oldsha' }));
    assert.match(stale.json.text, /changed after this message was sent/);

    const ok = await press('U_ADA');
    assert.equal(ok.status, 200);
    assert.match(ok.json.text, /Approved — it is now part of the knowledge base/);
    const after4 = await app.ctx.governance.getProposal(p.id);
    assert.equal(after4.status, 'merged');
    assert.equal(after4.approvals[0].channel, 'slack');
    await app.stop();
    await hook.close();
    delete process.env.T_SLACK_HOOK;
  });

  it('with require_sso_for_approval there is no approve button and presses are refused', async () => {
    const hook = await sink();
    process.env.T_SLACK_HOOK = `${hook.url}/hook`;
    registerAuthProvider('oidc', () => ({ name: 'oidc', authenticate: async () => null }));
    const { app } = await serve(
      [{ kind: 'web' }, { kind: 'slack', webhook_env: 'T_SLACK_HOOK', signing_secret_env: 'T_SLACK_SECRET', users: {} }],
      { governance: { require_sso_for_approval: true } },
    );
    const buttons = JSON.parse(hook.hits[0].body).blocks[1].elements;
    assert.ok(!buttons.some((b) => b.action_id === 'almagest_approve'));
    assert.ok(buttons.some((b) => b.text.text === 'Review and approve'));
    await app.stop();
    await hook.close();
    delete process.env.T_SLACK_HOOK;
  });
});

describe('github-pr', () => {
  const ghBody = (p, login, extra = {}) => JSON.stringify({
    action: 'closed',
    pull_request: { merged: true, merge_commit_sha: 'f'.repeat(40), head: { ref: p.branch, sha: p.headSha, repo: { full_name: 'acme/brain' } }, base: { ref: 'main' }, merged_by: { login }, ...extra },
  });
  const ghSig = (secret, body) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

  it('verifies X-Hub-Signature-256', () => {
    assert.equal(verifyGithub('s', ghSig('s', 'x'), 'x'), true);
    assert.equal(verifyGithub('s', ghSig('s', 'x'), 'y'), false);
    assert.equal(verifyGithub('s', 'sha256=00', 'x'), false);
    assert.equal(verifyGithub('', ghSig('', 'x'), 'x'), false);
  });

  // The full path, with a remote and real merge commits, is in github-pr.test.mjs.
  it('a merged PR is the merging user\'s approval; unmapped merges are recorded as violations', async () => {
    const { app, base, p } = await serve([{ kind: 'web' }, { kind: 'github-pr', repo: 'acme/brain', webhook_secret_env: 'T_GH_SECRET', users: { octo: { id: 'usr_ada', display: 'Ada', roles: ['owner'] } } }]);
    const post = (body, sig = ghSig(ENV.T_GH_SECRET, body), event = 'pull_request') => fetch(`${base}/channels/github/webhook`, { method: 'POST', headers: { 'x-github-event': event, 'x-hub-signature-256': sig, 'content-type': 'application/json' }, body });

    assert.equal((await post(ghBody(p, 'octo'), 'sha256=bad')).status, 401);
    assert.equal((await app.ctx.governance.getProposal(p.id)).status, 'open');
    assert.equal((await post('{}', undefined, 'ping')).status, 200);

    const res = await post(ghBody(p, 'octo'));
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.policyMet, true);
    // No remote, so the merge commit cannot be fetched and checked: local main stays put.
    assert.equal(out.status, 'merged_unaccepted');
    assert.equal(out.reason, 'shape');
    const merged = await app.ctx.governance.getProposal(p.id);
    assert.equal(merged.approvals[0].channel, 'github-pr');
    assert.equal(merged.merge.external, true);
    assert.equal(merged.merge.accepted, false);
    await app.stop();

    const second = await serve([{ kind: 'web' }, { kind: 'github-pr', repo: 'acme/brain', webhook_secret_env: 'T_GH_SECRET', users: {} }]);
    const body = ghBody(second.p, 'mallory');
    const r2 = await fetch(`${second.base}/channels/github/webhook`, { method: 'POST', headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': ghSig(ENV.T_GH_SECRET, body) }, body });
    assert.equal((await r2.json()).policyMet, false);
    const violations = await second.app.ctx.store.audit.list({ action: 'policy.violation' });
    assert.equal(violations.length, 1);
    assert.match(violations[0].detail.reason, /mallory is not a reviewer/);
    await second.app.stop();
  });
});

describe('email', () => {
  it('builds header-safe messages', () => {
    const m = rfc822({ from: 'a@b', to: 'c@d\r\nBcc: evil@x', subject: 'Hi\r\nBcc: evil@x', text: 't', html: '<p>h</p>' });
    const headers = m.split('\r\n\r\n')[0];
    assert.ok(!/^Bcc:/m.test(headers));
  });

  it('sends personal single-use links that sign the recipient in once', async () => {
    const api = await sink();
    const { app, base, p } = await serve([
      { kind: 'web' },
      { kind: 'email', transport: 'http', http: { url: `${(api.url)}/emails`, token_env: 'ALMAGEST_SECRET_KEY' }, from: 'kb@acme.test',
        recipients: [{ email: 'ada@acme.test', id: 'usr_ada', display: 'Ada', roles: ['owner'] }] },
    ]);
    assert.equal(api.hits.length, 1);
    const mail = JSON.parse(api.hits[0].body);
    assert.deepEqual(mail.to, ['ada@acme.test']);
    assert.match(mail.subject, /To review: New material/);
    assert.equal(api.hits[0].headers.authorization, 'Bearer test-secret');
    const link = mail.text.match(/Open it: (\S+)/)[1];
    const path = new URL(link).pathname;
    assert.match(path, /^\/inbox\/l\//);

    const c = client(base);
    const view = await c.get(path);
    assert.match(view.text, /Continue as Ada/);
    const go = await c.post(path, { form: { csrf: c.csrfFrom(view.text) } });
    assert.equal(go.status, 303);
    assert.equal(go.location, `/inbox/p/${p.id}`);
    assert.equal((await c.get(go.location)).status, 200, 'signed in by the link');
    const again = await client(base).get(path);
    assert.equal(again.status, 410);
    assert.equal((await client(base).get('/inbox/l/forged.token')).status, 410);
    await app.stop();
    await api.close();
  });
});

describe('oidc browser sign-in', () => {
  it('authorization code + PKCE against the issuer, roles and teams from claims', async () => {
    registerAuthProvider('oidc', () => ({ name: 'oidc', authenticate: async () => null }));   // stands in for core/auth-oidc.mjs
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
    let issuer = '';
    let lastNonce = '';
    let verifierSeen = '';
    const idp = await sink((req, body) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/.well-known/openid-configuration') {
        return { body: JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }) };
      }
      if (u.pathname === '/jwks') return { body: JSON.stringify({ keys: [jwk] }) };
      if (u.pathname === '/token') {
        verifierSeen = new URLSearchParams(body).get('code_verifier');
        const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const now = Math.floor(Date.now() / 1000);
        const head = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
        const claims = enc({ iss: issuer, aud: 'almagest-web', sub: 'abc', email: 'ada@acme.test', name: 'Ada L', exp: now + 300, iat: now, nonce: lastNonce, roles: ['kb-owners'], groups: ['engineering'] });
        const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), privateKey).toString('base64url');
        return { body: JSON.stringify({ id_token: `${head}.${claims}.${sig}`, token_type: 'Bearer' }) };
      }
      return { status: 404, body: '{}' };
    });
    issuer = idp.url;
    const { app, base } = await serve([{ kind: 'web' }], {
      service: { auth: { provider: 'oidc', oidc: { issuer, client_id: 'almagest-web', role_map: { 'kb-owners': 'owner' }, roles_claim: 'roles', teams_claim: 'groups' } } },
    });
    const c = client(base);
    const start = await c.get('/inbox/login/sso?next=/inbox/activity');
    assert.equal(start.status, 302);
    const auth = new URL(start.location);
    assert.equal(auth.origin + auth.pathname, `${issuer}/authorize`);
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    lastNonce = auth.searchParams.get('nonce');

    const forged = await c.get(`/inbox/auth/callback?code=x&state=wrong`);
    assert.equal(forged.status, 401);
    const again = await c.get('/inbox/login/sso?next=/inbox/activity');
    const a2 = new URL(again.location);
    lastNonce = a2.searchParams.get('nonce');
    const cb = await c.get(`/inbox/auth/callback?code=the-code&state=${encodeURIComponent(a2.searchParams.get('state'))}`);
    assert.equal(cb.status, 303, cb.text);
    assert.equal(cb.location, '/inbox/activity');
    const challenge = crypto.createHash('sha256').update(verifierSeen).digest('base64url');
    assert.equal(challenge, a2.searchParams.get('code_challenge'), 'PKCE verifier matches the challenge');

    const sid = verifySession(c);
    const rec = await app.ctx.store.kv.get('governance.session', sid);
    assert.equal(rec.idp, 'oidc');
    assert.deepEqual(rec.actor.roles, ['owner']);
    assert.deepEqual(rec.actor.teams, ['engineering']);
    assert.equal(rec.actor.id, 'usr_abc');
    assert.equal((await c.get('/inbox')).status, 200);
    await app.stop();
    await idp.close();
  });
});

function verifySession(c) {
  const raw = decodeURIComponent(c.jar.get('almagest_session'));
  return JSON.parse(Buffer.from(raw.split('.')[0], 'base64url').toString()).sid;
}
