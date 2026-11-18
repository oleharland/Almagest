/**
 * oauth.mjs — a minimal OAuth 2.1 authorization server for `token` mode, so a
 * solo brain can be added to claude.ai as a custom connector. claude.ai's
 * connectors speak OAuth (or nothing); a static bearer token cannot be pasted
 * into them. This is the smallest correct front door for that:
 *
 *   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata
 *   POST /oauth/register                           RFC 7591 dynamic client registration
 *   GET  /oauth/authorize                          consent page — the human pastes their Almagest token
 *   POST /oauth/authorize                          → 302 redirect_uri?code=…&state=…&iss=…
 *   POST /oauth/token                              code (+ PKCE S256 verifier) → access + refresh token
 *   POST /oauth/revoke                             RFC 7009
 *
 * Rules it holds to: PKCE S256 is required (no `plain`, no PKCE-less flow);
 * redirect URIs match exactly what was registered; codes are single-use and
 * expire in minutes; refresh tokens rotate, and replaying a rotated one
 * revokes the whole family; every code and token is stored as a sha256 hash
 * in `store.kv`, never in clear.
 *
 * Issued access tokens are accepted on `/mcp` only. They are minted for a
 * chat client, and a chat client must never be able to reach the web inbox
 * with one — that is where approvals happen.
 *
 * The human behind a token is re-resolved from ALMAGEST_TOKENS on every
 * request, so removing someone from that list (or changing their roles)
 * takes effect immediately for every token issued to them.
 *
 * Enterprises: use your IdP (`service.auth.provider: oidc`) instead. This
 * exists for the solo profile.
 */
import crypto from 'node:crypto';

import { parseTokens } from '../core/auth.mjs';
import { HttpError, sendHtml } from '../core/http.mjs';

const NS = { client: 'mcp.oauth.client', code: 'mcp.oauth.code', token: 'mcp.oauth.token' };
export const ACCESS_PREFIX = 'alm_at_';
export const REFRESH_PREFIX = 'alm_rt_';
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const SCOPE = 'almagest';

const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function sendOAuthJson(res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', pragma: 'no-cache', ...extra });
  res.end(body);
}

class OAuthError extends Error {
  constructor(error, description, status = 400) {
    super(description);
    this.error = error;
    this.status = status;
  }
}

/** RFC 8252 + OAuth 2.1: https anywhere, http only on loopback, private-use schemes for native apps. */
export function validRedirectUri(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return !['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:', 'ftp:', 'ws:', 'wss:'].includes(u.protocol) && /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol);
}

/**
 * Exact match, except that a loopback http redirect may use any port
 * (RFC 8252 §7.3) — native clients like Claude Code bind an ephemeral one.
 */
export function redirectMatches(presented, registered) {
  if (presented === registered) return true;
  try {
    const a = new URL(presented);
    const b = new URL(registered);
    const loopback = (u) => u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    return loopback(a) && loopback(b) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
}

function consentPage({ client, params, error = '' }) {
  const hidden = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
    .map((k) => (params[k] ? `<input type="hidden" name="${k}" value="${escapeHtml(params[k])}">` : '')).join('');
  const redirect = (() => { try { return new URL(params.redirect_uri).origin; } catch { return params.redirect_uri; } })();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Almagest</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f}
input[type=password]{width:100%;padding:.6rem;font:inherit;box-sizing:border-box}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}
.err{color:#b00020}.muted{color:#666;font-size:.9rem}</style></head><body>
<h1>Connect ${escapeHtml(client.client_name || 'an MCP client')} to this brain</h1>
<p><strong>${escapeHtml(client.client_name || client.client_id)}</strong> is asking to read this Almagest brain and submit sources <em>as you</em>.
It will be redirected to <code>${escapeHtml(redirect)}</code>.</p>
<p class="muted">It can search and read pages, and queue sources for ingest. It cannot approve or merge anything — approvals only happen in the review inbox, by you.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/oauth/authorize">${hidden}
<label for="token">Your Almagest token</label>
<input id="token" name="token" type="password" autocomplete="current-password" required>
<p><button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny" formnovalidate>Deny</button></p>
</form></body></html>`;
}

const PAGE_HEADERS = { 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

/**
 * @param {object} ctx
 * @param {object} cfg   resolved mcp config
 * @returns {{ issuer, metadata(), provider, sweep() }}
 */
export function createOAuthServer(ctx, cfg) {
  const issuer = ctx.config.service.http.base_url.replace(/\/$/, '');
  const kv = ctx.store.kv;
  const o = cfg.oauth;
  const envName = ctx.config.service.auth.tokens_env || 'ALMAGEST_TOKENS';
  const failures = new Map();   // ip → { n, since } — brute-force brake on the consent form

  /** The static Almagest tokens — the only credential the consent page accepts. */
  function staticTokens() {
    try { return parseTokens(process.env[envName] || ''); } catch { return []; }
  }
  const humanById = (id) => staticTokens().find((t) => t.actor.id === id)?.actor || null;

  function metadata() {
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
    };
  }

  async function issuePair({ humanId, clientId, scope, resource, family = random(12) }) {
    const access = ACCESS_PREFIX + random();
    const refresh = REFRESH_PREFIX + random();
    const now = Date.now();
    await kv.set(NS.token, hash(access), { kind: 'access', humanId, clientId, scope, resource, family, expiresAt: now + o.access_token_ttl_seconds * 1000 });
    await kv.set(NS.token, hash(refresh), { kind: 'refresh', humanId, clientId, scope, resource, family, expiresAt: now + o.refresh_token_ttl_seconds * 1000 });
    return { access_token: access, token_type: 'Bearer', expires_in: o.access_token_ttl_seconds, refresh_token: refresh, scope };
  }

  async function revokeFamily(family) {
    for (const { key, value } of await kv.list(NS.token)) if (value?.family === family) await kv.delete(NS.token, key);
  }

  /** client_id + client authentication per the client's registered method. */
  async function authenticateClient(body, req) {
    let clientId = body.client_id;
    let secret = body.client_secret;
    const basic = (req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
    if (basic) {
      const [id, ...rest] = Buffer.from(basic[1], 'base64').toString('utf-8').split(':');
      clientId = decodeURIComponent(id);
      secret = decodeURIComponent(rest.join(':'));
    }
    if (!clientId) throw new OAuthError('invalid_client', 'client_id is required', 401);
    const client = await kv.get(NS.client, clientId);
    if (!client) throw new OAuthError('invalid_client', 'unknown client', 401);
    if (client.token_endpoint_auth_method !== 'none') {
      if (!secret || !safeEqual(hash(secret), client.secretHash)) throw new OAuthError('invalid_client', 'client authentication failed', 401);
    }
    return client;
  }

  async function loadAuthorizeRequest(params) {
    const client = params.client_id ? await kv.get(NS.client, params.client_id) : null;
    if (!client) throw new HttpError(400, 'unknown client_id — register the client first');
    const redirectUri = params.redirect_uri || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : '');
    if (!redirectUri || !client.redirect_uris.some((r) => redirectMatches(redirectUri, r))) throw new HttpError(400, 'redirect_uri does not match a registered redirect URI');
    return { client, redirectUri };
  }

  function redirectWith(res, redirectUri, values) {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(values)) if (v) u.searchParams.set(k, v);
    res.writeHead(302, { location: u.href, 'cache-control': 'no-store' });
    res.end();
  }

  function protocolErrors(params) {
    if (params.response_type !== 'code') return ['unsupported_response_type', 'response_type must be code'];
    if (!params.code_challenge) return ['invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256'];
    if (params.code_challenge_method !== 'S256') return ['invalid_request', 'code_challenge_method must be S256'];
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge)) return ['invalid_request', 'code_challenge is not a base64url SHA-256'];
    return null;
  }

  // ── routes ────────────────────────────────────────────────────────────────

  const http = ctx.http;

  http.route('GET', '/.well-known/oauth-authorization-server', async () => metadata());

  http.route('POST', '/oauth/register', async (_req, res, { body }) => {
    try {
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
      if (!uris.length) throw new OAuthError('invalid_redirect_uri', 'redirect_uris is required');
      const bad = uris.find((u) => !validRedirectUri(u));
      if (bad) throw new OAuthError('invalid_redirect_uri', `redirect URI not allowed: ${bad}`);
      const method = body.token_endpoint_auth_method || 'none';
      if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) throw new OAuthError('invalid_client_metadata', `unsupported token_endpoint_auth_method ${method}`);
      const grants = body.grant_types || ['authorization_code', 'refresh_token'];
      if (grants.some((g) => !['authorization_code', 'refresh_token'].includes(g))) throw new OAuthError('invalid_client_metadata', 'only authorization_code and refresh_token grants are supported');
      if ((await kv.list(NS.client)).length >= o.max_clients) throw new OAuthError('invalid_client_metadata', 'client registration limit reached', 429);

      const clientId = `cli_${random(16)}`;
      const secret = method === 'none' ? '' : random();
      const record = {
        client_id: clientId,
        client_name: String(body.client_name || '').slice(0, 120),
        redirect_uris: uris,
        token_endpoint_auth_method: method,
        grant_types: grants,
        response_types: ['code'],
        client_id_issued_at: Math.floor(Date.now() / 1000),
        ...(secret ? { secretHash: hash(secret) } : {}),
      };
      await kv.set(NS.client, clientId, record);
      const { secretHash: _h, ...pub } = record;
      return sendOAuthJson(res, 201, { ...pub, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}) });
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      return sendOAuthJson(res, err.status, { error: err.error, error_description: err.message });
    }
  });

  http.route('GET', '/oauth/authorize', async (_req, res, { query }) => {
    const { client, redirectUri } = await loadAuthorizeRequest(query);
    const problem = protocolErrors(query);
    if (problem) return redirectWith(res, redirectUri, { error: problem[0], error_description: problem[1], state: query.state, iss: issuer });
    return sendHtml(res, 200, consentPage({ client, params: { ...query, redirect_uri: redirectUri } }), PAGE_HEADERS);
  });

  http.route('POST', '/oauth/authorize', async (req, res, { body }) => {
    const params = body || {};
    const { client, redirectUri } = await loadAuthorizeRequest(params);
    const problem = protocolErrors(params);
    if (problem) return redirectWith(res, redirectUri, { error: problem[0], error_description: problem[1], state: params.state, iss: issuer });
    if (params.decision !== 'approve') return redirectWith(res, redirectUri, { error: 'access_denied', state: params.state, iss: issuer });

    const ip = req.socket?.remoteAddress || '?';
    const f = failures.get(ip);
    if (f && f.n >= 10 && Date.now() - f.since < 10 * 60_000) {
      return sendHtml(res, 429, consentPage({ client, params, error: 'Too many failed attempts. Try again in a few minutes.' }), PAGE_HEADERS);
    }
    const presented = String(params.token || '').trim();
    const hit = presented && !presented.startsWith(ACCESS_PREFIX) && !presented.startsWith(REFRESH_PREFIX)
      ? staticTokens().find((t) => safeEqual(t.secret, presented))
      : null;
    if (!hit) {
      failures.set(ip, f && Date.now() - f.since < 10 * 60_000 ? { n: f.n + 1, since: f.since } : { n: 1, since: Date.now() });
      return sendHtml(res, 401, consentPage({ client, params, error: 'That token is not valid for this brain.' }), PAGE_HEADERS);
    }
    failures.delete(ip);

    const code = random();
    await kv.set(NS.code, hash(code), {
      clientId: client.client_id,
      redirectUri,
      codeChallenge: params.code_challenge,
      humanId: hit.actor.id,
      scope: SCOPE,
      resource: params.resource || '',
      expiresAt: Date.now() + o.code_ttl_seconds * 1000,
    });
    ctx.log.info('oauth consent granted', { client: client.client_id, human: hit.actor.id });
    return redirectWith(res, redirectUri, { code, state: params.state, iss: issuer });
  });

  http.route('POST', '/oauth/token', async (req, res, { body }) => {
    try {
      const params = body || {};
      const client = await authenticateClient(params, req);

      if (params.grant_type === 'authorization_code') {
        if (!params.code) throw new OAuthError('invalid_request', 'code is required');
        const key = hash(params.code);
        const rec = await kv.get(NS.code, key);
        if (rec) await kv.delete(NS.code, key);                 // single use, whatever happens next
        if (!rec || rec.expiresAt < Date.now()) throw new OAuthError('invalid_grant', 'code is invalid or expired');
        if (rec.clientId !== client.client_id) throw new OAuthError('invalid_grant', 'code was issued to another client');
        if ((params.redirect_uri || rec.redirectUri) !== rec.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
        if (!VERIFIER_RE.test(params.code_verifier || '')) throw new OAuthError('invalid_grant', 'code_verifier is missing or malformed');
        const challenge = crypto.createHash('sha256').update(params.code_verifier).digest('base64url');
        if (!safeEqual(challenge, rec.codeChallenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed');
        if (!humanById(rec.humanId)) throw new OAuthError('invalid_grant', 'the account behind this code no longer exists');
        return sendOAuthJson(res, 200, await issuePair({ humanId: rec.humanId, clientId: client.client_id, scope: rec.scope, resource: rec.resource }));
      }

      if (params.grant_type === 'refresh_token') {
        const key = hash(params.refresh_token || '');
        const rec = await kv.get(NS.token, key);
        if (!rec || rec.kind !== 'refresh') throw new OAuthError('invalid_grant', 'refresh token is invalid');
        if (rec.clientId !== client.client_id) throw new OAuthError('invalid_grant', 'refresh token was issued to another client');
        if (rec.rotatedAt) {
          await revokeFamily(rec.family);   // replay of a rotated token: assume theft, kill the line
          throw new OAuthError('invalid_grant', 'refresh token was already used — all tokens from this grant are revoked');
        }
        if (rec.expiresAt < Date.now()) throw new OAuthError('invalid_grant', 'refresh token expired');
        if (!humanById(rec.humanId)) throw new OAuthError('invalid_grant', 'the account behind this token no longer exists');
        await kv.set(NS.token, key, { ...rec, rotatedAt: Date.now() });
        return sendOAuthJson(res, 200, await issuePair({ humanId: rec.humanId, clientId: client.client_id, scope: rec.scope, resource: rec.resource, family: rec.family }));
      }

      throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      return sendOAuthJson(res, err.status, { error: err.error, error_description: err.message },
        err.status === 401 ? { 'www-authenticate': 'Basic realm="almagest"' } : {});
    }
  });

  http.route('POST', '/oauth/revoke', async (req, res, { body }) => {
    try {
      const client = await authenticateClient(body || {}, req);
      const rec = await kv.get(NS.token, hash(body?.token || ''));
      if (rec && rec.clientId === client.client_id) await revokeFamily(rec.family);
      res.writeHead(200, { 'cache-control': 'no-store' });
      return res.end();
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      return sendOAuthJson(res, err.status, { error: err.error, error_description: err.message });
    }
  });

  /** Auth provider for issued access tokens, chained in front of `token` via ctx.auth.use. */
  const provider = {
    name: 'mcp-oauth',
    async authenticate(req) {
      const m = (req.headers?.authorization || '').match(/^Bearer\s+(alm_at_[A-Za-z0-9_-]+)$/);
      if (!m) return null;
      const pathname = new URL(req.url || '/', 'http://localhost').pathname;
      if (pathname !== '/mcp' && !pathname.startsWith('/mcp/')) return null;
      const rec = await kv.get(NS.token, hash(m[1]));
      if (!rec || rec.kind !== 'access' || rec.expiresAt < Date.now()) return null;
      return humanById(rec.humanId);
    },
  };

  /** Drop expired codes and tokens. Called from the MCP sweeper. */
  async function sweep() {
    const now = Date.now();
    for (const ns of [NS.code, NS.token]) {
      for (const { key, value } of await kv.list(ns)) if (!value || value.expiresAt < now) await kv.delete(ns, key);
    }
  }

  return { issuer, metadata, provider, sweep };
}
