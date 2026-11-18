import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { actorFromClaims, claimAt, createOidcVerifier } from '../../src/core/auth-oidc.mjs';
import { rmrf } from '../helpers.mjs';
import { makeRepo, mcpApp } from './_util.mjs';

// ── a fake IdP: discovery + JWKS on a local port ────────────────────────────

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsa2 = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = (kp, kid, alg) => ({ ...kp.publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' });

let idp;
let issuer;
let published;
let jwksHits = 0;
let discoveryIssuer = null;

before(async () => {
  published = [jwk(rsa, 'k1', 'RS256'), jwk(ec, 'e1', 'ES256')];
  idp = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/realms/brain/.well-known/openid-configuration') {
      return res.end(JSON.stringify({ issuer: discoveryIssuer || issuer, jwks_uri: `${issuer}/certs` }));
    }
    if (req.url === '/realms/brain/certs') { jwksHits++; return res.end(JSON.stringify({ keys: published })); }
    res.statusCode = 404; return res.end('{}');
  });
  await new Promise((r) => idp.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${idp.address().port}/realms/brain`;
});
after(() => idp.close());

function sign(claims, { kid = 'k1', alg = 'RS256', key = rsa.privateKey, header = {} } = {}) {
  const h = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT', ...header })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const data = Buffer.from(`${h}.${p}`);
  let sig;
  if (alg === 'RS256') sig = crypto.sign('sha256', data, key);
  else if (alg === 'ES256') sig = crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' });
  else if (alg === 'HS256') sig = crypto.createHmac('sha256', 'secret').update(data).digest();
  else sig = Buffer.alloc(0);
  return `${h}.${p}.${sig.toString('base64url')}`;
}

const now = () => Math.floor(Date.now() / 1000);
const claims = (extra = {}) => ({
  iss: issuer, aud: 'almagest', sub: 'u-123', exp: now() + 300, iat: now(), name: 'Ada Lovelace', email: 'ada@acme.com',
  realm_access: { roles: ['brain-reviewers', 'offline_access'] }, groups: ['/engineering', '/sales'], ...extra,
});

describe('OIDC JWT validation', () => {
  const verifier = () => createOidcVerifier({ issuer, audience: 'almagest', minRefetchMs: 0 });

  it('accepts a valid RS256 token and maps nested role / team claims', async () => {
    const c = await verifier().verify(sign(claims()));
    assert.equal(c.sub, 'u-123');
    assert.deepEqual(claimAt(c, 'realm_access.roles'), ['brain-reviewers', 'offline_access']);
    const actor = actorFromClaims(c, { roles_claim: 'realm_access.roles', teams_claim: 'groups', role_map: { 'brain-reviewers': 'reviewer' } }, ['engineering']);
    assert.equal(actor.kind, 'human');
    assert.equal(actor.id, 'usr_u-123');
    assert.equal(actor.display, 'Ada Lovelace');
    assert.deepEqual(actor.roles, ['reviewer']);
    assert.deepEqual(actor.teams, ['engineering']);
    assert.deepEqual(actorFromClaims({ sub: 'x' }, {}).roles, ['viewer'], 'no role claim → default viewer');
  });

  it('accepts ES256', async () => {
    assert.equal((await verifier().verify(sign(claims(), { kid: 'e1', alg: 'ES256', key: ec.privateKey }))).sub, 'u-123');
  });

  it('rejects expired, not-yet-valid, wrong audience and wrong issuer', async () => {
    const v = verifier();
    await assert.rejects(() => v.verify(sign(claims({ exp: now() - 120 }))), /expired/);
    assert.ok(await v.verify(sign(claims({ exp: now() - 30 }))), 'within clock skew');
    await assert.rejects(() => v.verify(sign(claims({ nbf: now() + 600 }))), /not yet valid/);
    await assert.rejects(() => v.verify(sign(claims({ aud: 'some-other-app' }))), /audience/);
    assert.ok(await v.verify(sign(claims({ aud: ['x', 'almagest'] }))), 'aud array');
    await assert.rejects(() => v.verify(sign(claims({ iss: 'https://evil.example/' }))), /issuer/);
    await assert.rejects(() => v.verify(sign({ ...claims(), exp: undefined })), /no exp/);
  });

  it('rejects unknown kids after one JWKS refetch, and picks up rotated keys', async () => {
    const v = verifier();
    await v.verify(sign(claims()));
    const before = jwksHits;
    await assert.rejects(() => v.verify(sign(claims(), { kid: 'k2', key: rsa2.privateKey })), /unknown signing key/);
    assert.equal(jwksHits, before + 1, 'refetched once on a kid miss');
    published = [...published, jwk(rsa2, 'k2', 'RS256')];
    try {
      assert.equal((await v.verify(sign(claims(), { kid: 'k2', key: rsa2.privateKey }))).sub, 'u-123');
    } finally {
      published = published.filter((k) => k.kid !== 'k2');
    }
  });

  it('rejects alg none, HMAC, a key/alg mismatch and a bad signature', async () => {
    const v = verifier();
    await assert.rejects(() => v.verify(sign(claims(), { alg: 'none' })), /not accepted/);
    await assert.rejects(() => v.verify(sign(claims(), { alg: 'HS256' })), /not accepted/);
    await assert.rejects(() => v.verify(sign(claims(), { kid: 'e1', alg: 'RS256' })), /does not match|is for/);
    const good = sign(claims());
    const [h, , s] = good.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify(claims({ sub: 'admin' }))).toString('base64url')}.${s}`;
    await assert.rejects(() => v.verify(forged), /bad signature/);
    await assert.rejects(() => v.verify('a.b'), /not a JWT/);
  });

  it('refuses a discovery document for a different issuer', async () => {
    discoveryIssuer = 'https://impostor.example';
    try {
      await assert.rejects(() => createOidcVerifier({ issuer, audience: 'almagest' }).verify(sign(claims())), /does not match/);
    } finally {
      discoveryIssuer = null;
    }
  });

  it('requires an audience', () => {
    assert.throws(() => createOidcVerifier({ issuer }), /audience/);
  });
});

describe('oidc provider behind /mcp', () => {
  let t;
  let url;
  let repoRoot;
  before(async () => {
    repoRoot = makeRepo();
    t = await mcpApp({
      repoRoot,
      overrides: {
        service: {
          http: { port: 0, base_url: 'https://brain.acme.com' },
          auth: { provider: 'oidc', oidc: { issuer, audience: 'almagest', roles_claim: 'realm_access.roles', role_map: { 'brain-reviewers': 'reviewer' } } },
        },
      },
    });
    const server = await t.app.start();
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await t.ctx.mcp.close();
    await t.app.stop();
    rmrf(repoRoot);
  });

  it('points clients at the IdP and accepts its tokens', async () => {
    const md = await (await fetch(`${url}/.well-known/oauth-protected-resource`)).json();
    assert.deepEqual(md.authorization_servers, [issuer]);
    assert.equal(md.resource, 'https://brain.acme.com/mcp');
    assert.equal((await fetch(`${url}/.well-known/oauth-authorization-server`)).status, 404, 'no built-in OAuth server under oidc');

    const unauth = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sign(claims({ aud: 'wrong' }))}` }, body: '{}' });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get('www-authenticate'), /resource_metadata="https:\/\/brain\.acme\.com\/\.well-known\/oauth-protected-resource", error="invalid_token"/);

    const c = new Client({ name: 'claude-desktop', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${sign(claims())}` } } }));
    const tools = (await c.listTools()).tools.map((x) => x.name);
    assert.ok(tools.includes('submit_source'), 'reviewer may submit');
    await c.callTool({ name: 'search', arguments: { query: 'beta' } });
    assert.equal(t.events.at(-1).actorId, 'usr_u-123');
    await c.close();
  });
});
