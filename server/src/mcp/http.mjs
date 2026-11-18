/**
 * http.mjs — Almagest over Streamable HTTP at `/mcp`, for chats with no clone.
 *
 * One McpServer + transport per MCP session (`Mcp-Session-Id`), bound to the
 * human who initialised it: a later request on that session with someone
 * else's token is refused, and sessions idle past `session_idle_minutes` are
 * closed. Each request is authenticated afresh — a session id is not a
 * credential.
 *
 * Unauthenticated requests get 401 with
 * `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`,
 * which is how an MCP client discovers where to log in (RFC 9728): the IdP
 * issuer under `oidc`, or this server's own OAuth front door under `token`.
 *
 * DNS-rebinding protection: on a loopback bind, Host must be a loopback name
 * (or base_url's host, or `mcp.allowed_hosts`) and Origin, when sent, must be
 * one of those too (or `mcp.allowed_origins`). A web page on evil.example that
 * rebinds its name to 127.0.0.1 fails both.
 */
import crypto from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { humanActor } from '../core/auth.mjs';
import { HttpError } from '../core/http.mjs';

const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function jsonRpcError(res, status, code, message, headers = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body);
}

export async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export const ANONYMOUS = Object.freeze({ ...humanActor({ id: 'usr_anonymous', display: 'anonymous', roles: ['viewer'] }), anonymous: true });

/**
 * @param {object} ctx
 * @param {object} cfg          resolved mcp config
 * @param {object} deps
 * @param {(session) => McpServer} deps.buildServer
 * @param {string} deps.authorizationServer   issuer URL for the protected-resource metadata, or ''
 */
export function createHttpEndpoint(ctx, cfg, { buildServer, authorizationServer }) {
  const sessions = new Map();   // id → { transport, server, humanId, lastSeen }
  const baseUrl = ctx.config.service.http.base_url.replace(/\/$/, '');
  const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
  const loopbackBind = LOOPBACK_BINDS.has(String(ctx.config.service.http.host));

  const allowedHostnames = new Set([...cfg.allowed_hosts.map((h) => String(h).toLowerCase())]);
  try { allowedHostnames.add(new URL(baseUrl).hostname.toLowerCase()); } catch { /* bad base_url → loopback names only */ }
  const allowedOrigins = new Set(cfg.allowed_origins.map((o) => String(o).replace(/\/$/, '').toLowerCase()));

  /** @returns {string} '' when acceptable, else the reason */
  function originProblem(req) {
    const origin = req.headers.origin;
    if (loopbackBind) {
      const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
      if (!LOOPBACK_NAMES.has(host) && !allowedHostnames.has(host)) return `Host "${req.headers.host}" is not allowed`;
    }
    if (!origin) return '';
    if (allowedOrigins.has(origin.toLowerCase())) return '';
    let hostname = '';
    try { hostname = new URL(origin).hostname.toLowerCase(); } catch { return `Origin "${origin}" is not allowed`; }
    if (loopbackBind && (LOOPBACK_NAMES.has(hostname) || allowedHostnames.has(hostname))) return '';
    if (!loopbackBind && allowedOrigins.size === 0) return '';   // remote bind, no allow-list configured
    return `Origin "${origin}" is not allowed`;
  }

  function unauthorized(res, presented) {
    const challenge = `Bearer resource_metadata="${resourceMetadataUrl}"${presented ? ', error="invalid_token", error_description="the access token is invalid or expired"' : ''}`;
    jsonRpcError(res, 401, -32001, presented ? 'invalid or expired access token' : 'authentication required', { 'www-authenticate': challenge });
  }

  function closeSession(id) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    s.transport.close().catch(() => {});
    s.server.close().catch(() => {});
  }

  function evictIfFull() {
    if (sessions.size < cfg.max_sessions) return;
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
    if (oldest) closeSession(oldest[0]);
  }

  /**
   * The `/mcp` handler (POST / GET / DELETE per the Streamable HTTP spec).
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {object} [authed]   { actor } when the router already authenticated the request
   */
  async function handle(req, res, authed) {
    const problem = originProblem(req);
    if (problem) return jsonRpcError(res, 403, -32000, `Forbidden: ${problem}`);

    let human = authed?.actor !== undefined ? authed.actor : await ctx.auth.authenticate(req);
    const presented = Boolean(ctx.auth.bearer?.(req) || req.headers['x-almagest-token']);
    if (!human) {
      if (!cfg.allow_anonymous || presented) return unauthorized(res, presented);
      human = ANONYMOUS;
    }

    const sid = req.headers['mcp-session-id'];
    let parsed;
    if (req.method === 'POST') {
      const raw = await readRaw(req, 4 * 1024 * 1024);
      try { parsed = JSON.parse(raw.toString('utf-8')); }
      catch { return jsonRpcError(res, 400, -32700, 'Parse error'); }
    }

    if (sid) {
      const s = sessions.get(String(sid));
      if (!s) return jsonRpcError(res, 404, -32001, 'Session not found — initialize a new session');
      if (s.humanId !== human.id) return jsonRpcError(res, 403, -32000, 'Forbidden: this session belongs to someone else');
      s.lastSeen = Date.now();
      return s.transport.handleRequest(req, res, parsed);
    }

    const initializing = req.method === 'POST' && (Array.isArray(parsed) ? parsed.some(isInitializeRequest) : isInitializeRequest(parsed));
    if (!initializing) return jsonRpcError(res, 400, -32000, 'Bad Request: no valid session id; send initialize first');

    evictIfFull();
    let entry = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        entry = { transport, server, humanId: human.id, lastSeen: Date.now() };
        sessions.set(id, entry);
      },
      onsessionclosed: (id) => { sessions.delete(id); },
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    const server = buildServer({ human, sessionId: '', transport: 'http' });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
    if (!entry) { await transport.close().catch(() => {}); await server.close().catch(() => {}); }
  }

  function protectedResourceMetadata() {
    return {
      resource: `${baseUrl}/mcp`,
      ...(authorizationServer ? { authorization_servers: [authorizationServer] } : {}),
      bearer_methods_supported: ['header'],
      scopes_supported: ['almagest'],
      resource_name: ctx.config.v1?.raw?.name ? `Almagest — ${ctx.config.v1.raw.name}` : 'Almagest',
      resource_documentation: 'https://github.com/oleharland/Almagest/blob/main/docs/v2/mcp.md',
    };
  }

  function sweep() {
    const cutoff = Date.now() - cfg.session_idle_minutes * 60_000;
    for (const [id, s] of sessions) if (s.lastSeen < cutoff) closeSession(id);
  }

  async function closeAll() {
    for (const id of [...sessions.keys()]) closeSession(id);
  }

  return { handle, sessions, sweep, closeAll, protectedResourceMetadata, resourceMetadataUrl };
}

/**
 * `POST /hooks/git` signature check. Accepts GitHub's `X-Hub-Signature-256`,
 * a generic `X-Almagest-Signature` (same format: `sha256=<hex HMAC of the
 * body>`), or GitLab's `X-Gitlab-Token` (the shared secret itself).
 */
export function verifyGitWebhook(headers, body, secret) {
  if (!secret) return false;
  const sig = headers['x-hub-signature-256'] || headers['x-almagest-signature'];
  if (sig) {
    const want = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    const a = Buffer.from(String(sig));
    const b = Buffer.from(want);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const gl = headers['x-gitlab-token'];
  if (gl) {
    const a = Buffer.from(crypto.createHash('sha256').update(String(gl)).digest());
    const b = Buffer.from(crypto.createHash('sha256').update(secret).digest());
    return crypto.timingSafeEqual(a, b);
  }
  return false;
}
