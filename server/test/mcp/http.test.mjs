import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { git, rmrf } from '../helpers.mjs';
import { makeRepo, mcpApp, page } from './_util.mjs';

const BASE = 'http://127.0.0.1:4747';
const TOKENS = 'ada:owner:ada-secret-0123456789;vic:viewer:vic-secret-0123456789';
const repos = [];
const running = [];
after(async () => {
  for (const { app } of running) { await app.ctx.mcp.close(); await app.stop(); }
  repos.forEach(rmrf);
});

async function serve(overrides = {}, files = {}) {
  process.env.ALMAGEST_TOKENS = TOKENS;
  const repoRoot = makeRepo(files);
  repos.push(repoRoot);
  const t = await mcpApp({ repoRoot, overrides: { ...overrides, service: { http: { port: 0, base_url: BASE }, ...(overrides.service || {}) } } });
  const server = await t.app.start();
  delete process.env.ALMAGEST_TOKENS;
  const url = `http://127.0.0.1:${server.address().port}`;
  const entry = { ...t, url, repoRoot };
  running.push(entry);
  return entry;
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '1' } } };
const post = (url, body, headers = {}) => fetch(`${url}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify(body),
});

async function client(url, token, name = 'claude-ai') {
  const c = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} },
  });
  await c.connect(transport);
  return { c, transport };
}

describe('mcp over HTTP', () => {
  it('401 carries WWW-Authenticate pointing at the protected-resource metadata', async () => {
    const { url } = await serve();
    const none = await post(url, INIT);
    assert.equal(none.status, 401);
    assert.equal(none.headers.get('www-authenticate'), `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
    const bad = await post(url, INIT, { authorization: 'Bearer nope' });
    assert.equal(bad.status, 401);
    assert.match(bad.headers.get('www-authenticate'), /error="invalid_token"/);
  });

  it('serves RFC 9728 protected-resource metadata naming the authorization server', async () => {
    const { url } = await serve();
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const md = await (await fetch(`${url}${p}`)).json();
      assert.equal(md.resource, `${BASE}/mcp`);
      assert.deepEqual(md.authorization_servers, [BASE]);   // token mode → the built-in OAuth server
      assert.deepEqual(md.bearer_methods_supported, ['header']);
    }
  });

  it('an SDK client with a bearer token gets a session, tools, and telemetry with its session id', async () => {
    const { url, events, ctx } = await serve();
    const { c, transport } = await client(url, 'ada-secret-0123456789');
    assert.ok(transport.sessionId, 'server issued Mcp-Session-Id');
    const tools = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes('submit_source'));
    const r = await c.callTool({ name: 'search', arguments: { query: 'alpha' } });
    assert.equal(r.structuredContent.results[0].slug, 'alpha');
    const evt = events.at(-1);
    assert.equal(evt.sessionId, transport.sessionId);
    assert.equal(evt.client, 'claude-ai');
    assert.equal(evt.actorId, 'usr_ada');
    assert.equal(ctx.mcp.sessions, 1);
    await transport.terminateSession();
    await c.close();
    assert.equal(ctx.mcp.sessions, 0);
  });

  it('a viewer token gets read tools only', async () => {
    const { url } = await serve();
    const { c } = await client(url, 'vic-secret-0123456789');
    const tools = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes('ask'));
    assert.ok(!tools.includes('submit_source'));
    await c.close();
  });

  it('a session is bound to the human who opened it', async () => {
    const { url } = await serve();
    const { c, transport } = await client(url, 'ada-secret-0123456789');
    const sid = transport.sessionId;
    const hijack = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: 'Bearer vic-secret-0123456789', 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' });
    assert.equal(hijack.status, 403);
    const unknown = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: 'Bearer ada-secret-0123456789', 'mcp-session-id': 'not-a-session' });
    assert.equal(unknown.status, 404);
    const noSession = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: 'Bearer ada-secret-0123456789' });
    assert.equal(noSession.status, 400);
    await c.close();
  });

  it('idle sessions are swept', async () => {
    const { url, ctx } = await serve({ mcp: { session_idle_minutes: 0 } });
    const { c } = await client(url, 'ada-secret-0123456789');
    assert.equal(ctx.mcp.sessions, 1);
    await new Promise((r) => setTimeout(r, 5));
    await ctx.mcp.sweep();
    assert.equal(ctx.mcp.sessions, 0);
    await c.close().catch(() => {});
  });

  it('rejects foreign Origin and Host headers on a loopback bind (DNS rebinding)', async () => {
    const { url } = await serve();
    const auth = { authorization: 'Bearer ada-secret-0123456789' };
    assert.equal((await post(url, INIT, { ...auth, origin: 'http://evil.example' })).status, 403);
    assert.equal((await post(url, INIT, { ...auth, origin: 'http://localhost:3000' })).status, 200);
    // fetch() will not let us forge Host; go through node:http for that one
    const http = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = http.request({ host: u.hostname, port: u.port, path: '/mcp', method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json', ...auth } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end(JSON.stringify(INIT));
    });
    assert.equal(status, 403);
  });

  it('allow_anonymous serves read tools without a token, and nothing else', async () => {
    const { url } = await serve({ mcp: { allow_anonymous: true } });
    const { c } = await client(url, '');
    const tools = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes('search'));
    assert.ok(!tools.includes('submit_source'));
    assert.ok(!tools.includes('list_proposals'));
    await c.close();
    assert.equal((await post(url, INIT, { authorization: 'Bearer wrong' })).status, 401, 'a bad token is still rejected');
  });

  it('POST /hooks/git refreshes the snapshot when the HMAC matches', async () => {
    const { url, repoRoot } = await serve({ mcp: { local_refresh_seconds: 0 } });
    const hook = (body, headers) => fetch(`${url}/hooks/git`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    assert.equal((await hook('{}', {})).status, 404, 'disabled until a secret is configured');

    process.env.ALMAGEST_GIT_WEBHOOK_SECRET = 'hook-secret';
    try {
      const { c } = await client(url, 'vic-secret-0123456789');
      assert.equal((await c.callTool({ name: 'search', arguments: { query: 'walrus' } })).structuredContent.results.length, 0);
      fs.writeFileSync(path.join(repoRoot, 'brain/wiki/walrus.md'), page({ title: 'Walrus Habitat', body: '## Summary\n\nIce floes.\n' }));
      git(repoRoot, 'add', '-A');
      git(repoRoot, 'commit', '-q', '-m', 'walrus');

      const body = JSON.stringify({ ref: 'refs/heads/main' });
      assert.equal((await hook(body, { 'x-hub-signature-256': 'sha256=deadbeef' })).status, 401);
      const sig = `sha256=${crypto.createHmac('sha256', 'hook-secret').update(body).digest('hex')}`;
      const ok = await hook(body, { 'x-hub-signature-256': sig });
      assert.equal(ok.status, 200);
      assert.match((await ok.json()).sha, /^[0-9a-f]{40}$/);
      assert.equal((await hook(body, { 'x-gitlab-token': 'hook-secret' })).status, 200);
      assert.equal((await c.callTool({ name: 'search', arguments: { query: 'walrus' } })).structuredContent.results[0].slug, 'walrus');
      await c.close();
    } finally {
      delete process.env.ALMAGEST_GIT_WEBHOOK_SECRET;
    }
  });
});
