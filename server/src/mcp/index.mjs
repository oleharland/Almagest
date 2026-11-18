/**
 * mcp — WS4. Almagest as an MCP server. Spec: docs/v2/spec.md → Almagest MCP
 * server; operator guide: docs/v2/mcp.md.
 *
 *   ctx.mcp.serveStdio()          `almagest mcp` — a local clone, one client on stdin/stdout
 *   ctx.mcp.handleHttp(req, res)  Streamable HTTP at /mcp — remote, no clone needed
 *
 * Read side: main's snapshot only (ctx.snapshot), never the checkout. Write
 * side: `submit_source` → ctx.ingest.enqueue, which ends in a proposal; the
 * governance tools → ctx.governance, which can hand out a confirmation link
 * but never approve. Every tool call → ctx.telemetry.record.
 *
 * Routes registered here:
 *   ALL  /mcp                                     the MCP endpoint (raw body)
 *   GET  /.well-known/oauth-protected-resource    RFC 9728 (also …/mcp)
 *   POST /hooks/git                               HMAC-signed push hook → snapshot refresh with fetch
 *   …and the built-in OAuth server's routes in token mode (./oauth.mjs).
 */
import os from 'node:os';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import '../core/auth-oidc.mjs';
import { humanActor } from '../core/auth.mjs';
import { HttpError, sendJson } from '../core/http.mjs';

import { createBrain } from './brain.mjs';
import { mcpConfig } from './config.mjs';
import { createHttpEndpoint, readRaw, verifyGitWebhook } from './http.mjs';
import { createOAuthServer } from './oauth.mjs';
import { buildServer, newSessionId } from './tools.mjs';

export async function create(ctx) {
  const cfg = mcpConfig(ctx.config);
  const brain = createBrain(ctx, cfg);
  const hooks = {};   // test seams that only ever narrow behaviour (fetch address policy)
  const timers = [];

  const authProvider = ctx.config.service.auth.provider;
  let oauth = null;
  if (authProvider === 'token' && cfg.builtin_oauth) {
    oauth = createOAuthServer(ctx, cfg);
    ctx.auth.use(oauth.provider);
  }
  const authorizationServer = authProvider === 'oidc' ? String(ctx.config.service.auth.oidc?.issuer || '') : oauth ? oauth.issuer : '';

  const build = (session) => buildServer(ctx, cfg, brain, { ...session, sessionId: session.sessionId || '' }, hooks);
  const endpoint = createHttpEndpoint(ctx, cfg, { buildServer: build, authorizationServer });

  // ── routes ────────────────────────────────────────────────────────────────

  ctx.http.route('ALL', '/mcp', (req, res, { actor }) => endpoint.handle(req, res, { actor }), { raw: true });
  const metadata = async () => endpoint.protectedResourceMetadata();
  ctx.http.route('GET', '/.well-known/oauth-protected-resource', metadata);
  ctx.http.route('GET', '/.well-known/oauth-protected-resource/mcp', metadata);

  ctx.http.route('POST', '/hooks/git', async (req, res) => {
    const secret = process.env[cfg.git_webhook_secret_env] || '';
    if (!secret) throw new HttpError(404, `git webhook is not configured (set ${cfg.git_webhook_secret_env})`);
    const body = await readRaw(req, 1024 * 1024);
    if (!verifyGitWebhook(req.headers, body, secret)) throw new HttpError(401, 'bad webhook signature');
    const sha = await ctx.snapshot.refresh({ fetch: Boolean(ctx.config.service.git.remote) });
    ctx.log.info('snapshot refreshed by git webhook', { sha: sha.slice(0, 7) });
    return sendJson(res, 200, { ok: true, sha });
  }, { raw: true });

  // ── background: idle sessions, expired OAuth codes, remote refresh ────────

  const sweeper = setInterval(() => {
    endpoint.sweep();
    oauth?.sweep().catch((err) => ctx.log.warn('oauth sweep failed', { error: err.message }));
  }, 60_000);
  sweeper.unref();
  timers.push(sweeper);

  if (ctx.config.service.git.remote && cfg.refresh_seconds > 0) {
    const refresher = setInterval(() => {
      ctx.snapshot.refresh({ fetch: true }).catch((err) => ctx.log.warn('snapshot fetch-refresh failed', { error: err.message }));
    }, cfg.refresh_seconds * 1000);
    refresher.unref();
    timers.push(refresher);
  }

  // ── stdio ─────────────────────────────────────────────────────────────────

  /** Who a stdio session acts for: ALMAGEST_TOKEN's owner, else the local user with `mcp.stdio_role`. */
  async function stdioHuman(env = process.env) {
    const token = env.ALMAGEST_TOKEN;
    if (token) {
      const human = await ctx.auth.authenticate({ headers: { authorization: `Bearer ${token}` }, url: '/mcp' });
      if (!human) throw new Error('ALMAGEST_TOKEN does not match any token this brain accepts');
      return human;
    }
    let display = 'local';
    try { display = os.userInfo().username || display; } catch { /* no passwd entry in some containers */ }
    return humanActor({ id: 'usr_local', display, roles: [cfg.stdio_role] });
  }

  /**
   * Serve one client over stdio. Nothing else may write to stdout from here
   * on — the core logger already writes to stderr.
   */
  async function serveStdio({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
    const human = await stdioHuman(env);
    const server = build({ human, sessionId: newSessionId('stdio'), transport: 'stdio' });
    const transport = new StdioServerTransport(stdin, stdout);
    await server.connect(transport);
    ctx.log.info('mcp serving on stdio', { as: human.id, roles: human.roles.join(',') });
    return { server, transport, close: () => server.close() };
  }

  return {
    config: cfg,
    serveStdio,
    handleHttp: (req, res) => endpoint.handle(req, res),
    /** In-process server for one human (tests, embedding). */
    createServer: (session) => build({ transport: 'memory', ...session, sessionId: session.sessionId || newSessionId('mem') }),
    search: (query, options) => brain.search(query, options),
    get sessions() { return endpoint.sessions.size; },
    /** Close idle HTTP sessions and drop expired OAuth codes/tokens now (also runs every minute). */
    async sweep() { endpoint.sweep(); await oauth?.sweep(); },
    oauth,
    hooks,
    async close() {
      timers.forEach(clearInterval);
      await endpoint.closeAll();
    },
  };
}

export const commands = {};
