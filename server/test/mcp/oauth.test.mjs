import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { redirectMatches, validRedirectUri } from '../../src/mcp/oauth.mjs';
import { rmrf } from '../helpers.mjs';
import { makeRepo, mcpApp } from './_util.mjs';

const BASE = 'http://127.0.0.1:4747';
const TOKENS = 'ada:owner:ada-secret-0123456789';
const REDIRECT = 'http://localhost:33418/callback';

let t;
let url;
let repoRoot;
before(async () => {
  process.env.ALMAGEST_TOKENS = TOKENS;
  repoRoot = makeRepo();
  t = await mcpApp({ repoRoot, overrides: { service: { http: { port: 0, base_url: BASE } } } });
  const server = await t.app.start();
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await t.ctx.mcp.close();
  await t.app.stop();
  rmrf(repoRoot);
  delete process.env.ALMAGEST_TOKENS;
});

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};
const form = (obj) => new URLSearchParams(obj).toString();
const postForm = (p, obj, headers = {}) => fetch(`${url}${p}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: form(obj) });

async function register(extra = {}) {
  const res = await fetch(`${url}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], ...extra }),
  });
  return { status: res.status, body: await res.json() };
}

async function authorize(clientId, { challenge, token = 'ada-secret-0123456789', redirect = REDIRECT, state = 'st-1' } = {}) {
  const res = await postForm('/oauth/authorize', {
    response_type: 'code', client_id: clientId, redirect_uri: redirect, state,
    code_challenge: challenge, code_challenge_method: 'S256', token, decision: 'approve',
  });
  return res;
}

async function codeFor(clientId, challenge, redirect = REDIRECT) {
  const res = await authorize(clientId, { challenge, redirect });
  assert.equal(res.status, 302);
  return new URL(res.headers.get('location')).searchParams.get('code');
}

const exchange = (clientId, code, verifier, extra = {}) => postForm('/oauth/token', {
  grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT, ...extra,
});

describe('built-in OAuth 2.1 server (token mode)', () => {
  it('publishes RFC 8414 metadata with PKCE S256 only', async () => {
    const md = await (await fetch(`${url}/.well-known/oauth-authorization-server`)).json();
    assert.equal(md.issuer, BASE);
    assert.equal(md.authorization_endpoint, `${BASE}/oauth/authorize`);
    assert.equal(md.registration_endpoint, `${BASE}/oauth/register`);
    assert.deepEqual(md.code_challenge_methods_supported, ['S256']);
  });

  it('validates redirect URIs at registration', async () => {
    assert.equal(validRedirectUri('https://claude.ai/api/mcp/auth_callback'), true);
    assert.equal(validRedirectUri('http://127.0.0.1:5555/cb'), true);
    assert.equal(validRedirectUri('cursor://anysphere.cursor-retrieval/oauth/callback'), true);
    assert.equal(validRedirectUri('http://evil.example/cb'), false);
    assert.equal(validRedirectUri('javascript:alert(1)'), false);
    assert.equal(validRedirectUri('https://x.example/cb#frag'), false);
    assert.equal(redirectMatches('http://localhost:1234/callback', 'http://localhost:33418/callback'), true, 'loopback: any port');
    assert.equal(redirectMatches('https://a.example/cb2', 'https://a.example/cb'), false);
    assert.equal((await register({ redirect_uris: ['http://evil.example/cb'] })).status, 400);
    assert.equal((await register({ redirect_uris: [] })).status, 400);
  });

  it('runs the full authorization-code + PKCE flow, and the token works on /mcp', async () => {
    const { status, body: client } = await register();
    assert.equal(status, 201);
    assert.match(client.client_id, /^cli_/);
    assert.equal(client.client_secret, undefined, 'public client');
    const { verifier, challenge } = pkce();

    const page = await fetch(`${url}/oauth/authorize?${form({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, state: 's', code_challenge: challenge, code_challenge_method: 'S256' })}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    const html = await page.text();
    assert.match(html, /Connect Claude to this brain/);
    assert.match(html, /name="token"/);

    const bad = await authorize(client.client_id, { challenge, token: 'not-the-token' });
    assert.equal(bad.status, 401);

    const res = await authorize(client.client_id, { challenge, state: 'xyz' });
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, REDIRECT);
    assert.equal(loc.searchParams.get('state'), 'xyz');
    assert.equal(loc.searchParams.get('iss'), BASE);
    const code = loc.searchParams.get('code');

    const tok = await exchange(client.client_id, code, verifier);
    assert.equal(tok.status, 200);
    assert.equal(tok.headers.get('cache-control'), 'no-store');
    const tokens = await tok.json();
    assert.match(tokens.access_token, /^alm_at_/);
    assert.match(tokens.refresh_token, /^alm_rt_/);
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.expires_in, 3600);

    // the code is single-use
    const again = await exchange(client.client_id, code, verifier);
    assert.equal(again.status, 400);
    assert.equal((await again.json()).error, 'invalid_grant');

    // the access token is a working MCP credential …
    const c = new Client({ name: 'claude-ai', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
    assert.ok((await c.listTools()).tools.some((x) => x.name === 'submit_source'), 'acts as the owner who consented');
    await c.callTool({ name: 'search', arguments: { query: 'alpha' } });
    assert.equal(t.events.at(-1).actorId, 'usr_ada');
    await c.close();

    // … and nothing else: off /mcp it does not authenticate (the inbox is where approvals happen)
    assert.equal(await t.ctx.auth.authenticate({ headers: { authorization: `Bearer ${tokens.access_token}` }, url: '/inbox/p/prp_x' }), null);
    assert.equal((await t.ctx.auth.authenticate({ headers: { authorization: `Bearer ${tokens.access_token}` }, url: '/mcp' })).id, 'usr_ada');
  });

  it('rejects a wrong PKCE verifier, a missing challenge, and a non-S256 method', async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const code = await codeFor(client.client_id, challenge);
    const res = await exchange(client.client_id, code, pkce().verifier);
    assert.equal(res.status, 400);
    const err = await res.json();
    assert.equal(err.error, 'invalid_grant');
    assert.match(err.error_description, /PKCE/);

    const noPkce = await fetch(`${url}/oauth/authorize?${form({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, state: 's' })}`, { redirect: 'manual' });
    assert.equal(noPkce.status, 302);
    assert.equal(new URL(noPkce.headers.get('location')).searchParams.get('error'), 'invalid_request');

    const plain = await fetch(`${url}/oauth/authorize?${form({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'plain' })}`, { redirect: 'manual' });
    assert.equal(new URL(plain.headers.get('location')).searchParams.get('error'), 'invalid_request');

    const wrongRedirect = await fetch(`${url}/oauth/authorize?${form({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: challenge, code_challenge_method: 'S256' })}`, { redirect: 'manual' });
    assert.equal(wrongRedirect.status, 400, 'never redirect to an unregistered URI');
  });

  it('refuses a code issued to another client, and Almagest-issued tokens on the consent form', async () => {
    const { body: a } = await register();
    const { body: b } = await register();
    const { verifier, challenge } = pkce();
    const code = await codeFor(a.client_id, challenge);
    assert.equal((await exchange(b.client_id, code, verifier)).status, 400);

    const { verifier: v2, challenge: c2 } = pkce();
    const tokens = await (await exchange(a.client_id, await codeFor(a.client_id, c2), v2)).json();
    assert.equal((await authorize(a.client_id, { challenge: c2, token: tokens.access_token })).status, 401);
  });

  it('rotates refresh tokens; replaying a rotated one revokes the whole grant', async () => {
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const first = await (await exchange(client.client_id, await codeFor(client.client_id, challenge), verifier)).json();

    const r1 = await postForm('/oauth/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: first.refresh_token });
    assert.equal(r1.status, 200);
    const second = await r1.json();
    assert.notEqual(second.access_token, first.access_token);
    const who = (tok) => t.ctx.auth.authenticate({ headers: { authorization: `Bearer ${tok}` }, url: '/mcp' });
    assert.equal((await who(second.access_token)).id, 'usr_ada');

    const replay = await postForm('/oauth/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: first.refresh_token });
    assert.equal(replay.status, 400);
    assert.equal(await who(second.access_token), null, 'family revoked');
    assert.equal(await who(first.access_token), null);
  });

  it('confidential clients must authenticate at the token endpoint', async () => {
    const { body: client } = await register({ token_endpoint_auth_method: 'client_secret_post' });
    assert.ok(client.client_secret);
    const { verifier, challenge } = pkce();
    const code = await codeFor(client.client_id, challenge);
    const noSecret = await exchange(client.client_id, code, verifier);
    assert.equal(noSecret.status, 401);
    const code2 = await codeFor(client.client_id, challenge);
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    const ok = await postForm('/oauth/token', { grant_type: 'authorization_code', code: code2, code_verifier: verifier, redirect_uri: REDIRECT }, { authorization: `Basic ${basic}` });
    assert.equal(ok.status, 200);
  });

  it('removing a person from ALMAGEST_TOKENS cuts off every token issued to them', async () => {
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const tokens = await (await exchange(client.client_id, await codeFor(client.client_id, challenge), verifier)).json();
    const who = () => t.ctx.auth.authenticate({ headers: { authorization: `Bearer ${tokens.access_token}` }, url: '/mcp' });
    assert.equal((await who()).id, 'usr_ada');
    process.env.ALMAGEST_TOKENS = 'someone:viewer:other-secret-0123456789';
    try {
      assert.equal(await who(), null);
      const r = await postForm('/oauth/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token });
      assert.equal(r.status, 400);
    } finally {
      process.env.ALMAGEST_TOKENS = TOKENS;
    }
  });

  it('can be revoked, and expired codes are swept', async () => {
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const tokens = await (await exchange(client.client_id, await codeFor(client.client_id, challenge), verifier)).json();
    assert.equal((await postForm('/oauth/revoke', { client_id: client.client_id, token: tokens.refresh_token })).status, 200);
    assert.equal(await t.ctx.auth.authenticate({ headers: { authorization: `Bearer ${tokens.access_token}` }, url: '/mcp' }), null);
    await t.ctx.mcp.sweep();
  });
});
