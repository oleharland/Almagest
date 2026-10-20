import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createMemoryStore } from '../../src/core/store/memory.mjs';
import { createConfirmations } from '../../src/governance/confirmations.mjs';
import { html, raw, safeNext, safeUrl } from '../../src/governance/html.mjs';
import { sign, verify } from '../../src/governance/signing.mjs';
import { ALPHA_V2, CLEAN_AUDIT, cleanup, client, DELTA, govApp, job, page, proposalBranch, repo } from './fixtures.mjs';

const TOKENS = 'ada:owner:ada-secret-1;bob:reviewer:bob-secret-2;vic:viewer:vic-secret-3';
let saved;
const live = [];
before(() => { saved = process.env.ALMAGEST_TOKENS; process.env.ALMAGEST_TOKENS = TOKENS; process.env.ALMAGEST_SECRET_KEY = 'test-secret'; });
after(async () => {
  for (const a of live) await a.stop().catch(() => {});
  process.env.ALMAGEST_TOKENS = saved;
  cleanup();
});
const headFrom = (text) => (text.match(/name="headSha" value="([0-9a-f]{40})"/) || [])[1];

async function serve(files, overrides = {}) {
  const r = repo();
  const app = await govApp(r, { overrides: { service: { http: { port: 0 } }, ...overrides } });
  const server = await app.start();
  live.push({ stop: () => app.stop() });
  const stop = app.stop.bind(app);
  let stopped = false;
  app.stop = async () => { if (!stopped) { stopped = true; await stop(); } };
  live[live.length - 1].stop = () => app.stop();
  const base = `http://127.0.0.1:${server.address().port}`;
  const b = await proposalBranch(app, 'ingest/q3-board-deck-abcdef1', files || { 'brain/wiki/alpha.md': ALPHA_V2, 'brain/wiki/delta.md': DELTA });
  const p = await app.ctx.governance.createFromJob(job(b.branch), { ...b, audit: CLEAN_AUDIT });
  return { app, base, p, r };
}

async function login(base, token = 'ada-secret-1') {
  const c = client(base);
  const page1 = await c.get('/inbox/login');
  const res = await c.post('/inbox/login', { form: { csrf: c.csrfFrom(page1.text), token, next: '/inbox' } });
  return { c, res };
}

describe('html escaping', () => {
  it('escapes by default and keeps nested html', () => {
    const evil = '<script>alert(1)</script>"\'`';
    assert.equal(String(html`<p title="${evil}">${evil}</p>`), '<p title="&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&#96;">&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&#96;</p>');
    assert.equal(String(html`<ul>${['<a>', 'b'].map((x) => html`<li>${x}</li>`)}</ul>`), '<ul><li>&lt;a&gt;</li><li>b</li></ul>');
    assert.equal(String(html`${raw('<b>ok</b>')}${null}${false}${0}`), '<b>ok</b>0');
    assert.equal(safeUrl('javascript:alert(1)'), '#');
    assert.equal(safeUrl('//evil.example'), '#');
    assert.equal(safeNext('https://evil.example'), '/inbox');
    assert.equal(safeNext('/inbox/p/1'), '/inbox/p/1');
  });

  it('signed values reject tampering, the wrong purpose and expiry', () => {
    const t = sign('k', 'session', { sid: 'a', exp: Date.now() + 1000 });
    assert.equal(verify('k', 'session', t).sid, 'a');
    assert.equal(verify('k', 'csrf', t), null);
    assert.equal(verify('other', 'session', t), null);
    assert.equal(verify('k', 'session', t.replace(/^./, 'x')), null);
    assert.equal(verify('k', 'session', sign('k', 'session', { exp: Date.now() - 1 })), null);
  });
});

describe('inbox: sign-in, CSRF, rendering', () => {
  it('redirects to sign-in, logs in with a token, and logs out for real', async () => {
    const { app, base } = await serve();
    const anon = client(base);
    const r1 = await anon.get('/inbox');
    assert.equal(r1.status, 303);
    assert.equal(r1.location, '/inbox/login?next=%2Finbox');

    const bad = client(base);
    const lp = await bad.get('/inbox/login');
    const wrong = await bad.post('/inbox/login', { form: { csrf: bad.csrfFrom(lp.text), token: 'nope' } });
    assert.equal(wrong.status, 401);
    assert.match(wrong.text, /didn&#39;t work/);

    const { c, res } = await login(base);
    assert.equal(res.status, 303);
    assert.equal(res.location, '/inbox');
    const inbox = await c.get('/inbox');
    assert.equal(inbox.status, 200);
    assert.match(inbox.text, /New material from “Q3 board deck”/);
    assert.match(inbox.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(inbox.headers.get('x-frame-options'), 'DENY');
    const cookie = res.headers.getSetCookie().find((h) => h.startsWith('almagest_session='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);

    const stolen = c.jar.get('almagest_session');
    const out = await c.post('/inbox/logout', { form: { csrf: c.csrfFrom(inbox.text) } });
    assert.equal(out.location, '/inbox/login?m=bye');
    const replay = client(base);
    replay.jar.set('almagest_session', stolen);
    assert.equal((await replay.get('/inbox')).status, 303, 'a revoked session cookie no longer works');
    await app.stop();
  });

  it('refuses POSTs without a valid CSRF token or from another origin', async () => {
    const { app, base, p } = await serve();
    const { c } = await login(base);
    const pageRes = await c.get(`/inbox/p/${p.id}`);
    const csrf = c.csrfFrom(pageRes.text);
    assert.equal((await c.post(`/inbox/p/${p.id}/approve`, { form: { scope: 'all' } })).status, 403);
    assert.equal((await c.post(`/inbox/p/${p.id}/approve`, { form: { csrf: 'forged', scope: 'all' } })).status, 403);
    assert.equal((await c.post(`/inbox/p/${p.id}/approve`, { form: { csrf, scope: 'all' }, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await app.ctx.governance.getProposal(p.id)).approvals.length, 0);
    // A bearer token cannot drive the inbox forms, even with a token in the form.
    const bearer = await fetch(`${base}/inbox/p/${p.id}/approve`, { method: 'POST', headers: { authorization: 'Bearer ada-secret-1', 'content-type': 'application/x-www-form-urlencoded' }, body: 'scope=all' });
    assert.equal(bearer.status, 403);

    // The form names the version shown. Without it, or with an older one, nothing is approved.
    const headSha = headFrom(pageRes.text);
    assert.equal(headSha, p.headSha);
    assert.equal((await c.post(`/inbox/p/${p.id}/approve`, { form: { csrf, scope: 'all' } })).status, 400);
    const stale = await c.post(`/inbox/p/${p.id}/approve`, { form: { csrf, scope: 'all', headSha: 'f'.repeat(40) } });
    assert.equal(stale.status, 409);
    assert.match(stale.text, /changed since you opened it/);
    assert.equal((await app.ctx.governance.getProposal(p.id)).approvals.length, 0);

    const ok = await c.post(`/inbox/p/${p.id}/approve`, { form: { csrf, scope: 'all', headSha } });
    assert.equal(ok.status, 303);
    assert.equal(ok.location, `/inbox/p/${p.id}?m=merged`);
    const after2 = await c.get(ok.location);
    assert.match(after2.text, /this is now part of the knowledge base/);
    await app.stop();
  });

  it('shows claims next to their source passages and escapes hostile page content', async () => {
    const hostile = page({
      title: 'Evil <img src=x onerror=alert(1)>',
      body: '## Details\n\nThe value is <script>alert("xss")</script> high. [source: alpha-pdf, p.3]',
    });
    const { app, base, p } = await serve({ 'brain/wiki/evil.md': hostile, 'brain/wiki/alpha.md': ALPHA_V2 });
    const { c } = await login(base);
    const res = await c.get(`/inbox/p/${p.id}`);
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('<script>alert'), 'no live script tag from page content');
    assert.ok(!res.text.includes('<img src=x'), 'no live img tag from the title');
    assert.ok(res.text.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
    assert.ok(res.text.includes('Evil &lt;img src=x onerror=alert(1)&gt;'));
    // The only <script> is ours, with the nonce.
    const nonce = res.headers.get('content-security-policy').match(/script-src 'nonce-([^']+)'/)[1];
    assert.equal((res.text.match(/<script/g) || []).length, 1);
    assert.ok(res.text.includes(`<script nonce="${nonce}">`));
    // Review surface: changed fact with old wording and the passage from the sidecar.
    assert.match(res.text, /Updated fact/);
    assert.match(res.text, /Was: <del>The scheduler retries on a fixed 30-second backoff\.<\/del>/);
    assert.match(res.text, /<blockquote class="excerpt"[^>]*>The scheduler retries on a fixed 30-second backoff\.<\/blockquote>/);
    assert.match(res.text, /Source: <strong>Alpha System Overview<\/strong>, page 3/);
    await app.stop();
  });

  it('viewers can look but not act', async () => {
    const { app, base, p } = await serve();
    const { c } = await login(base, 'vic-secret-3');
    const res = await c.get(`/inbox/p/${p.id}`);
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('Approve all'));
    assert.match(res.text, /has no approver role/);
    const forced = await c.post(`/inbox/p/${p.id}/approve`, { form: { csrf: c.csrfFrom(res.text) } });
    assert.equal(forced.status, 403);
    await app.stop();
  });

  it('side pages tolerate telemetry being a stub', async () => {
    const { app, base } = await serve();
    const { c } = await login(base);
    for (const path of ['/inbox/reverify', '/inbox/gaps', '/inbox/activity']) {
      const res = await c.get(path);
      assert.equal(res.status, 200, path);
    }
    assert.match((await c.get('/inbox/reverify')).text, /isn&#39;t available/);
    assert.match((await c.get('/inbox/activity')).text, /new proposal arrived/);
    await app.stop();
  });
});

describe('JSON API', () => {
  it('bearer tokens can read but never act; a browser session with CSRF and the headSha can', async () => {
    const { app, base, p } = await serve();
    assert.equal((await fetch(`${base}/api/proposals`)).status, 401);
    const list = await (await fetch(`${base}/api/proposals`, { headers: { authorization: 'Bearer bob-secret-2' } })).json();
    assert.equal(list.proposals[0].id, p.id);
    assert.match(list.proposals[0].summary, /Q3 board deck/);
    const one = await (await fetch(`${base}/api/proposals/${p.id}`, { headers: { authorization: 'Bearer bob-secret-2' } })).json();
    assert.equal(one.evaluation.ready, false);
    assert.equal(one.proposal.worktree, undefined, 'no server filesystem paths in API output');
    assert.ok(!JSON.stringify(one).includes(app.ctx.repoRoot));

    // A reviewer's own token, as an agent with ALMAGEST_TOKEN in its env would hold it: refused for every action.
    const bearer = { authorization: 'Bearer bob-secret-2', 'content-type': 'application/json' };
    for (const [path, body] of [
      [`/api/proposals/${p.id}/approve`, { headSha: p.headSha }],
      [`/api/proposals/${p.id}/reject`, {}],
      [`/api/proposals/${p.id}/request-changes`, { feedback: 'x' }],
      [`/api/proposals/${p.id}/retry`, {}],
      [`/api/proposals/${p.id}/pages/delta/reject`, {}],
      ['/api/decisions/dec_x/resolve', { optionId: 'a' }],
    ]) {
      const r = await fetch(`${base}${path}`, { method: 'POST', headers: bearer, body: JSON.stringify(body) });
      assert.equal(r.status, 403, path);
    }
    const mcpToken = await fetch(`${base}/api/proposals/${p.id}/approve`, { method: 'POST', headers: { authorization: 'Bearer alm_at_abc', 'content-type': 'application/json' }, body: '{}' });
    assert.ok([401, 403].includes(mcpToken.status));
    assert.equal((await app.ctx.governance.getProposal(p.id)).approvals.length, 0);

    const { c } = await login(base);
    const page1 = await c.get(`/inbox/p/${p.id}`);
    const csrf = c.csrfFrom(page1.text);
    assert.equal((await c.post(`/api/proposals/${p.id}/approve`, { json: { headSha: p.headSha } })).status, 403, 'cookie without CSRF');
    assert.equal((await c.post(`/api/proposals/${p.id}/approve`, { json: { headSha: 'a'.repeat(40) }, headers: { 'x-almagest-csrf': csrf } })).status, 409);
    const ok = await c.post(`/api/proposals/${p.id}/approve`, { json: { headSha: p.headSha }, headers: { 'x-almagest-csrf': csrf } });
    assert.equal(ok.status, 200, ok.text);
    const body = JSON.parse(ok.text);
    assert.equal(body.status, 'merged');
    assert.equal(body.approvals[0].channel, 'web');
    assert.equal(body.worktree, undefined);
    await app.stop();
  });
});

describe('chat confirmations', () => {
  it('a chat code only leads to the full review; the person approves the version they see, once', async () => {
    const { app, base, p } = await serve();
    const conf = await app.ctx.governance.createConfirmation(p.id, { id: 'usr_ada', display: 'Ada', kind: 'human' }, 'approve');
    const path = new URL(conf.url).pathname;
    assert.equal((await client(base).get(path)).status, 303, 'signed-out → sign in first');

    const { c } = await login(base, 'bob-secret-2');
    const hop = await c.get(path);
    assert.equal(hop.status, 303);
    assert.equal(hop.location, `/inbox/p/${p.id}?confirm=${encodeURIComponent(conf.code)}`);
    assert.equal((await c.post(path, { form: {} })).status, 404, 'no approve-by-code endpoint');
    const view = await c.get(hop.location);
    assert.match(view.text, /A chat assistant asked on behalf of Ada for this to be approved/);
    assert.match(view.text, /Updated fact/, 'the full review, not just a title');
    assert.ok(view.text.includes(`name="confirm" value="${conf.code}"`));
    assert.equal((await app.ctx.governance.getProposal(p.id)).approvals.length, 0, 'opening the link does nothing');

    const done = await c.post(`/inbox/p/${p.id}/approve`, { form: { csrf: c.csrfFrom(view.text), headSha: headFrom(view.text), scope: 'all', confirm: conf.code } });
    assert.equal(done.status, 303);
    const after3 = await app.ctx.governance.getProposal(p.id);
    assert.equal(after3.status, 'merged');
    assert.equal(after3.approvals[0].actorId, 'usr_bob');
    assert.equal(after3.approvals[0].channel, 'mcp');
    const again = await c.get(path);
    assert.equal(again.status, 410);
    assert.match(again.text, /already been used/);
    await app.stop();
  });

  it('codes expire', async () => {
    let now = Date.parse('2026-10-20T10:00:00Z');
    const conf = createConfirmations({ store: createMemoryStore(), baseUrl: 'http://x', ttlMs: 60_000, now: () => now });
    const c = await conf.create({ proposalId: 'prp_1', action: 'approve' });
    assert.equal((await conf.peek(c.code)).state, 'ok');
    now += 61_000;
    assert.equal((await conf.peek(c.code)).state, 'expired');
    await assert.rejects(() => conf.consume(c.code), (e) => e.status === 410);
    assert.equal((await conf.peek('AAAA-BBBB-CCCC')).state, 'unknown');
  });

  it('a reject confirmation turns the proposal down', async () => {
    const { app, base, p } = await serve();
    const conf = await app.ctx.governance.createConfirmation(p.id, { id: 'usr_ada', display: 'Ada', kind: 'human' }, 'reject');
    const path = new URL(conf.url).pathname;
    const { c } = await login(base);
    const view = await c.get((await c.get(path)).location);
    assert.match(view.text, /for this to be turned down/);
    await c.post(`/inbox/p/${p.id}/reject`, { form: { csrf: c.csrfFrom(view.text), reason: 'chat said so', confirm: conf.code } });
    assert.equal((await app.ctx.governance.getProposal(p.id)).status, 'rejected');
    const [entry] = await app.ctx.store.audit.list({ action: 'proposal.reject' });
    assert.equal(entry.channel, 'mcp');
    await app.stop();
  });
});
