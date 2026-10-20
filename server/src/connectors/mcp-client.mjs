/**
 * mcp-client.mjs — Almagest as an MCP *client*: resolve a connector's `mcp`,
 * connect over the right transport, and keep the connection pooled.
 *
 * `mcp` is either a key in `.mcp.json` → `mcpServers` (the file Claude Code
 * reads, so one declaration serves the harness and the service) or an inline
 * object in brain.config.yaml:
 *
 *   mcp: google-drive                                   # .mcp.json key
 *   mcp: https://mcp.example.com/mcp                    # a bare Streamable HTTP url
 *   mcp: { url: https://mcp.example.com/mcp, headers: { Authorization: "Bearer ${TOKEN}" } }
 *   mcp: { type: sse, url: https://legacy.example.com/sse }
 *   mcp: { command: npx, args: ["-y", "@acme/mcp"], env: { ACME_KEY: "${ACME_KEY}" } }
 *
 * `${VAR}` / `${VAR:-default}` expand exactly as in core/config.mjs. A
 * `${VAR}` with no default and no value is reported, not silently emptied —
 * an empty bearer token is the most common reason a hosted server says 401.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { expandEnv } from '../core/config.mjs';

export const CLIENT_INFO = { name: 'almagest', version: '0.2.0' };
export const DEFAULT_TIMEOUT_MS = 30_000;
const IDLE_CLOSE_MS = 5 * 60_000;

export class NeedsLoginError extends Error {
  constructor(connectorOrServer) {
    super(`MCP server "${connectorOrServer}" needs OAuth authorization — run: almagest connectors login ${connectorOrServer}`);
    this.name = 'NeedsLoginError';
    this.code = 'NEEDS_LOGIN';
  }
}

/** `.mcp.json` → `mcpServers`, or `{}` when there is no file. */
export function readMcpJson(file) {
  if (!file || !fs.existsSync(file)) return {};
  const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return doc && typeof doc.mcpServers === 'object' ? doc.mcpServers : {};
}

/** Names of `${VAR}` references with no default whose variable is unset. */
export function missingEnv(value, env = process.env) {
  const missing = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\$\{([A-Z0-9_]+)(:-[^}]*)?\}/gi)) if (!m[2] && env[m[1]] === undefined) missing.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return [...missing];
}

/**
 * Normalise `mcp` to a transport spec.
 * @returns {{ key: string, label: string, type: 'stdio'|'http'|'sse', url?: string, headers?: object,
 *             command?: string, args?: string[], env?: object, cwd?: string, missingEnv: string[] }}
 */
export function resolveServer(mcp, { mcpServers = {}, env = process.env, cwd } = {}) {
  let raw;
  let key;
  if (typeof mcp === 'string' && /^https?:\/\//i.test(mcp)) {
    raw = { url: mcp };
    key = mcp;
  } else if (typeof mcp === 'string') {
    raw = mcpServers[mcp];
    key = mcp;
    if (!raw) {
      const known = Object.keys(mcpServers);
      throw new Error(`MCP server "${mcp}" is not in .mcp.json → mcpServers${known.length ? ` (known: ${known.join(', ')})` : ''}`);
    }
  } else if (mcp && typeof mcp === 'object') {
    raw = mcp;
    // Inline servers are pooled (and their OAuth logins stored) by this key.
    // Two stdio servers that differ only in env are different servers.
    key = mcp.name || mcp.url || [mcp.command, ...(mcp.args || [])].join(' ');
    if (!mcp.name && !mcp.url && mcp.env && Object.keys(mcp.env).length) {
      key += ` #${crypto.createHash('sha256').update(JSON.stringify(mcp.env)).digest('hex').slice(0, 8)}`;
    }
  } else {
    throw new Error('connector has no `mcp` — name a .mcp.json server or give { url } / { command }');
  }

  const missing = missingEnv(raw, env);
  const spec = expandEnv(raw, env);
  const declared = String(spec.type || spec.transport || '').toLowerCase();
  let type;
  if (declared === 'stdio' || (!declared && spec.command)) type = 'stdio';
  else if (declared === 'sse') type = 'sse';
  else if (['http', 'streamable-http', 'streamablehttp', ''].includes(declared) && spec.url) type = 'http';
  else throw new Error(`MCP server "${key}": cannot tell the transport (type "${declared || '?'}", no url or command)`);

  // `label` is what may be written down — snapshot headers, manifest `server`.
  // It never carries a query string, a header, an argument or an env value,
  // any of which can hold a credential.
  const label = typeof mcp === 'string' && !/^https?:/i.test(mcp)
    ? mcp
    : raw.name
      ? String(raw.name)
      : type === 'stdio'
        ? `stdio:${String(spec.command).split(/[\\/]/).pop()}`
        : (() => { const u = new URL(String(spec.url)); return `${u.origin}${u.pathname}`; })();

  if (type === 'stdio') {
    return {
      key, label, type, missingEnv: missing,
      command: String(spec.command),
      args: (spec.args || []).map(String),
      env: Object.fromEntries(Object.entries(spec.env || {}).map(([k, v]) => [k, String(v)])),
      cwd: spec.cwd || cwd,
    };
  }
  return {
    key, label, type, missingEnv: missing,
    url: String(spec.url),
    headers: Object.fromEntries(Object.entries(spec.headers || {}).map(([k, v]) => [k, String(v)])),
  };
}

/** A header that carries a credential with an actual value in it. */
export function hasStaticAuth(spec) {
  return Object.entries(spec.headers || {}).some(([k, v]) =>
    /^(authorization|private-token|x-api-key|api-key)$/i.test(k) && String(v).replace(/^bearer\s*/i, '').trim() !== '');
}

/** Build the SDK transport for a spec. `authProvider` applies to HTTP and SSE only. */
export function makeTransport(spec, { authProvider, onStderr } = {}) {
  if (spec.type === 'stdio') {
    const t = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: { ...getDefaultEnvironment(), ...spec.env },
      cwd: spec.cwd,
      stderr: 'pipe',
    });
    if (onStderr) t.stderr?.on('data', (chunk) => onStderr(String(chunk)));
    return t;
  }
  const opts = { requestInit: { headers: spec.headers || {} }, ...(authProvider ? { authProvider } : {}) };
  const url = new URL(spec.url);
  return spec.type === 'sse' ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts);
}

export function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The text a tool call produced, as a value: `structuredContent` when the
 * server sends it, else the text blocks (and embedded text resources) joined
 * and parsed as JSON when they parse, else the raw string.
 */
export function toolResultValue(result) {
  if (result?.isError) {
    const msg = (result.content || []).map((c) => c.text || '').join(' ').trim();
    throw new Error(`tool returned an error: ${msg || 'no message'}`);
  }
  if (result?.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  if (result?.toolResult !== undefined) return result.toolResult;   // pre-2025 compatibility shape
  // An embedded text resource is the payload; text blocks beside it are the
  // server talking about the payload ("successfully downloaded …").
  const content = result?.content || [];
  const embedded = content.filter((c) => c.type === 'resource' && typeof c.resource?.text === 'string').map((c) => c.resource.text);
  const texts = embedded.length ? embedded : content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text);
  if (texts.length === 1) return parseMaybeJson(texts[0]);
  if (texts.length > 1) {
    const parsed = texts.map(parseMaybeJson);
    return parsed.every((p) => typeof p === 'string') ? texts.join('\n\n') : parsed;
  }
  return '';
}

function parseMaybeJson(text) {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return text;
  try { return JSON.parse(t); } catch { return text; }
}

/**
 * Connection pool keyed by server. One live client per server, shared by
 * every connector that names it; idle connections close after five minutes;
 * `closeAll()` is what `ctx.connectors.stop()` calls.
 *
 * @param {object} o
 * @param {(spec, extra) => object|undefined} [o.authProviderFor]  OAuth provider for an HTTP/SSE spec
 * @param {(spec) => Promise<{client, close}>} [o.connect] replace the transport layer (tests)
 * @param {object} [o.log]
 */
export function createPool({ authProviderFor, connect: connectOverride, log, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const live = new Map();

  async function open(spec, extra) {
    if (connectOverride) return connectOverride(spec, extra);
    const wantsOAuth = spec.type !== 'stdio' && !hasStaticAuth(spec) && extra?.oauth !== false;
    const authProvider = wantsOAuth ? authProviderFor?.(spec, extra) : undefined;
    const transport = makeTransport(spec, {
      authProvider,
      onStderr: (line) => log?.debug('mcp server stderr', { server: spec.key, line: line.trim().slice(0, 500) }),
    });
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    try {
      await withTimeout(client.connect(transport, { timeout: timeoutMs }), timeoutMs, `connecting to "${spec.key}"`);
    } catch (err) {
      await transport.close?.().catch(() => {});
      if (err instanceof NeedsLoginError) throw err;
      if (err?.name === 'UnauthorizedError' || /unauthorized|needs oauth/i.test(err?.message || '')) throw new NeedsLoginError(spec.key);
      throw err;
    }
    return { client, close: () => client.close() };
  }

  /** @param {object} spec  resolveServer() output  @param {object} [extra]  { oauth } from the connector */
  async function get(spec, extra) {
    let entry = live.get(spec.key);
    if (!entry) {
      entry = { promise: open(spec, extra), timer: null };
      live.set(spec.key, entry);
      entry.promise.catch(() => live.delete(spec.key));
    }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => drop(spec.key), IDLE_CLOSE_MS);
    entry.timer.unref?.();
    return (await entry.promise).client;
  }

  async function drop(key) {
    const entry = live.get(key);
    if (!entry) return;
    live.delete(key);
    clearTimeout(entry.timer);
    try { await (await entry.promise).close(); } catch { /* already gone */ }
  }

  async function closeAll() {
    await Promise.all([...live.keys()].map(drop));
  }

  return { get, drop, closeAll, get size() { return live.size; } };
}
