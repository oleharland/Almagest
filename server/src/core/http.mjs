/**
 * http.mjs — a tiny router over node:http. No framework, on purpose: the
 * service has a dozen routes, and every dependency is one more thing an
 * enterprise security review has to sign off.
 *
 *   ctx.http.route('GET', '/inbox/p/:id', handler, { auth: 'human' })
 *   handler(req, res, { params, query, actor, body }) → value | undefined
 *
 * A handler that returns a value gets it sent as JSON (or as HTML when it is a
 * `{ html }` object); one that writes to `res` itself returns undefined.
 * `auth`: 'none' (default) · 'any' (any authenticated actor) · 'human'.
 * `raw: true` skips body parsing — the MCP transport reads the stream itself.
 */
import http from 'node:http';

import { AuthError } from './auth.mjs';

export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}

export async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf-8');
  if (!text) return {};
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) {
    try { return JSON.parse(text); } catch { throw new HttpError(400, 'invalid JSON body'); }
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return { text };
}

function compile(pattern) {
  const keys = [];
  const re = pattern.replace(/\/:([a-zA-Z_]+)/g, (_m, k) => { keys.push(k); return '/([^/]+)'; }).replace(/\*$/, '.*');
  return { re: new RegExp(`^${re}/?$`), keys };
}

export function createRouter({ auth, log } = {}) {
  const routes = [];

  function route(method, pattern, handler, options = {}) {
    routes.push({ method: method.toUpperCase(), pattern, handler, options, ...compile(pattern) });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const match = routes.find((r) => (r.method === 'ALL' || r.method === req.method) && r.re.test(url.pathname));
    if (!match) return sendJson(res, 404, { error: 'not found' });

    try {
      const m = url.pathname.match(match.re);
      const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const query = Object.fromEntries(url.searchParams);

      const actor = auth ? await auth.authenticate(req) : null;
      const need = match.options.auth || 'none';
      if (need !== 'none' && !actor) throw new AuthError('authentication required');
      if (need === 'human' && actor.kind !== 'human') throw new AuthError('a human session is required', 403);

      const body = match.options.raw || req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const result = await match.handler(req, res, { params, query, actor, body, url });
      if (result === undefined || res.headersSent) return;
      if (result && typeof result.html === 'string') return sendHtml(res, result.status || 200, result.html, result.headers);
      return sendJson(res, 200, result);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log?.error('http handler failed', { path: url.pathname, error: err.stack || err.message });
      if (!res.headersSent) sendJson(res, status, { error: err.message, ...(err.detail ? { detail: err.detail } : {}) });
    }
  }

  function listen({ host = '127.0.0.1', port = 4747 } = {}) {
    const server = http.createServer(handle);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server));
    });
  }

  return { route, handle, listen, routes };
}
