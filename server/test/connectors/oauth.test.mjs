import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createConnectors } from '../../src/connectors/index.mjs';
import { createOAuthProvider, OAUTH_NS } from '../../src/connectors/oauth.mjs';
import { createMemoryStore } from '../../src/core/store/memory.mjs';
import { makeApp, makeTempRepo, rmrf } from '../helpers.mjs';
import { buildFakeServer } from './fixtures/fake-server-lib.mjs';

const SECRET = 'test-secret-key';
const repos = [];
const apps = [];
let previousKey;
before(() => { previousKey = process.env.ALMAGEST_SECRET_KEY; process.env.ALMAGEST_SECRET_KEY = SECRET; });
after(async () => {
  for (const a of apps) await a.stop().catch(() => {});
  repos.forEach(rmrf);
  if (previousKey === undefined) delete process.env.ALMAGEST_SECRET_KEY; else process.env.ALMAGEST_SECRET_KEY = previousKey;
});

/**
 * One node:http server playing both roles a hosted MCP server plays: the
 * protected resource at /mcp, and its OAuth 2.1 authorization server
 * (metadata, dynamic registration, authorize with PKCE, token + refresh).
 */
async function startOAuthMcp() {
  const state = { docs: [{ id: 'd1', title: 'Doc', updatedAt: '2026-01-01', body: 'secret roadmap' }] };
  const valid = new Set();
  const codes = new Map();
  const log = { registrations: 0, refreshes: 0, exchanges: 0 };
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(req.url, base);
    const body = await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
    const json = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };

    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      log.registrations++;
      return json(201, { ...JSON.parse(body), client_id: `client-${log.registrations}` });
    }
    if (url.pathname === '/authorize') {
      const code = `code-${++n}`;
      codes.set(code, { challenge: url.searchParams.get('code_challenge'), redirect: url.searchParams.get('redirect_uri') });
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') || '');
      res.writeHead(302, { location: String(back) });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        const c = codes.get(form.get('code'));
        const expected = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
        if (!c || c.challenge !== expected) return json(400, { error: 'invalid_grant' });
        log.exchanges++;
        const t = `access-${++n}`;
        valid.add(t);
        return json(200, { access_token: t, token_type: 'Bearer', expires_in: 3600, refresh_token: `refresh-${n}` });
      }
      if (form.get('grant_type') === 'refresh_token') {
        log.refreshes++;
        const t = `access-${++n}`;
        valid.add(t);
        return json(200, { access_token: t, token_type: 'Bearer', expires_in: 3600, refresh_token: form.get('refresh_token') });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/mcp') {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!valid.has(token)) {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
        return res.end();
      }
      if (req.method !== 'POST') { res.writeHead(405).end(); return undefined; }
      const mcp = buildFakeServer(() => state);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      res.on('close', () => { transport.close(); mcp.close(); });
      return transport.handleRequest(req, res, JSON.parse(body));
    }
    res.writeHead(404).end();
    return undefined;
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, valid, log, close: () => new Promise((r) => server.close(r)) };
}

/** Plays the browser: follow the authorization redirect back to the loopback listener. */
async function browser(url) {
  const res = await fetch(url, { redirect: 'manual' });
  await fetch(res.headers.get('location'));
}

const RECIPE = {
  recipe: 'custom',
  list: { tool: 'list_docs', items: 'docs[*]', ref: 'id', title: 'title' },
  fetch: { tool: 'get_doc', args: { id: '{{item.ref}}' }, render: 'json-to-markdown' },
};

describe('OAuth 2.1 + PKCE', () => {
  it('stores client registration and tokens sealed — never in the clear', async () => {
    const store = createMemoryStore();
    const p = createOAuthProvider({ store, serverKey: 'notion', secret: SECRET });
    await p.saveTokens({ access_token: 'plain-access-token', token_type: 'Bearer', refresh_token: 'plain-refresh' });
    await p.saveClientInformation({ client_id: 'cid' });
    const raw = JSON.stringify(await store.kv.get(OAUTH_NS, 'notion'));
    assert.ok(!raw.includes('plain-access-token') && !raw.includes('plain-refresh') && !raw.includes('cid'));
    assert.match(raw, /"sealed":"v1\./);
    assert.equal((await p.tokens()).access_token, 'plain-access-token');
    assert.equal((await p.clientInformation()).client_id, 'cid');
    // A different key cannot read it.
    await assert.rejects(() => createOAuthProvider({ store, serverKey: 'notion', secret: 'other' }).tokens());
    await p.invalidateCredentials('tokens');
    assert.equal(await p.tokens(), undefined);
    assert.equal((await p.clientInformation()).client_id, 'cid');
  });

  it('the service provider never opens a browser: it says which command to run', async () => {
    const p = createOAuthProvider({ store: createMemoryStore(), serverKey: 'linear', secret: SECRET });
    await assert.rejects(() => p.redirectToAuthorization(new URL('https://x')), /almagest connectors login linear/);
  });

  it('login runs the browser flow, sync then uses the token, and an expired token is refreshed', async () => {
    const as = await startOAuthMcp();
    const repo = makeTempRepo();
    repos.push(repo);
    const app = await makeApp({ repoRoot: repo, overrides: { connectors: [{ id: 'hosted', mcp: { url: `${as.base}/mcp` }, ...RECIPE }] } });
    apps.push(app);
    const svc = createConnectors(app.ctx);
    try {
      // Before login the server answers 401 and the service names the fix.
      await assert.rejects(() => svc.sync('hosted'), /connectors login/);

      let seen = null;
      const r = await svc.login('hosted', { onUrl: async (u) => { seen = u; await browser(u); } });
      assert.equal(r.result, 'AUTHORIZED');
      assert.equal(seen.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(seen.searchParams.get('state'));
      assert.equal(as.log.exchanges, 1);
      const sealed = JSON.stringify(await app.ctx.store.kv.get(OAUTH_NS, `${as.base}/mcp`));
      assert.ok(!/access-\d/.test(sealed), 'no token in the clear');
      const audit = await app.ctx.store.audit.list({ action: 'connector.login' });
      assert.equal(audit[0].target, 'hosted');

      const refs = await svc.sync('hosted');
      assert.equal(refs.length, 1);

      // Expire every token; a fresh connection must refresh, not re-prompt.
      as.valid.clear();
      await svc.stop();
      const again = await svc.syncDetailed('hosted', { full: true });
      assert.equal(again.errors.length, 0);
      assert.equal(as.log.refreshes, 1);
    } finally {
      await svc.stop();
      await as.close();
    }
  });
});
