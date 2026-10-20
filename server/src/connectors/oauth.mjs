/**
 * oauth.mjs — OAuth 2.1 + PKCE for hosted MCP servers (Linear, Notion,
 * Granola, Google, …), on the SDK's own client machinery.
 *
 * The SDK does the protocol: discovery (protected-resource and
 * authorization-server metadata), dynamic client registration, PKCE, the
 * code exchange, and refreshing an expired access token. What it asks of us
 * is an `OAuthClientProvider` — somewhere to keep the client registration,
 * the tokens and the code verifier. Ours keeps them in `store.kv`
 * (namespace `connector-oauth`, keyed by MCP server), **sealed** with
 * `ALMAGEST_SECRET_KEY` (core/schemas.mjs → seal). The database never holds a
 * token in the clear.
 *
 * Tokens belong to the server, not the connector: two connectors on the same
 * Notion workspace share one login.
 *
 * In the service the provider is non-interactive. When the SDK would have to
 * send a human to a browser, it throws NeedsLoginError instead, and the
 * message names the command that fixes it: `almagest connectors login <id>`.
 * That command is the only interactive path (see `login` below).
 */
import crypto from 'node:crypto';
import http from 'node:http';

import { auth } from '@modelcontextprotocol/sdk/client/auth.js';

import { seal, unseal } from '../core/schemas.mjs';
import { NeedsLoginError, withTimeout } from './mcp-client.mjs';

export const OAUTH_NS = 'connector-oauth';
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const SERVICE_REDIRECT = 'http://127.0.0.1/almagest/oauth/callback';

/**
 * @param {object} o
 * @param {object} o.store         ctx.store
 * @param {string} o.serverKey     the MCP server name (or url)
 * @param {string} [o.redirectUrl] loopback callback; only needed while logging in
 * @param {string} [o.scope]
 * @param {{client_id: string, client_secret?: string}} [o.staticClient]  pre-registered client
 * @param {boolean} [o.interactive]
 * @param {(url: URL) => void|Promise<void>} [o.onRedirect]
 * @param {string} [o.secret]      sealing key (default ALMAGEST_SECRET_KEY)
 */
export function createOAuthProvider({ store, serverKey, redirectUrl, scope, staticClient, interactive = false, onRedirect, secret }) {
  const sealKey = secret ?? process.env.ALMAGEST_SECRET_KEY;

  async function read() {
    const row = await store.kv.get(OAUTH_NS, serverKey);
    if (!row?.sealed) return {};
    return JSON.parse(unseal(row.sealed, sealKey));
  }

  async function write(patch) {
    const next = { ...(await read()), ...patch };
    await store.kv.set(OAUTH_NS, serverKey, { sealed: seal(JSON.stringify(next), sealKey), updatedAt: new Date().toISOString() });
    return next;
  }

  // The SDK reads "no redirect URL" as a machine-to-machine (client
  // credentials) flow. A service-side provider is still an authorization-code
  // client — it just cannot open a browser — so it reports the URL the login
  // registered (or a placeholder) and refuses in redirectToAuthorization.
  const effectiveRedirect = redirectUrl || SERVICE_REDIRECT;

  return {
    get redirectUrl() { return effectiveRedirect; },

    get clientMetadata() {
      return {
        client_name: 'Almagest',
        client_uri: 'https://github.com/oleharland/Almagest',
        redirect_uris: [String(effectiveRedirect)],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: staticClient?.client_secret ? 'client_secret_post' : 'none',
        ...(scope ? { scope } : {}),
      };
    },

    async state() {
      const value = crypto.randomBytes(16).toString('base64url');
      await write({ state: value });
      return value;
    },

    async clientInformation() {
      if (staticClient?.client_id) return { ...staticClient };
      const rec = await read();
      if (!interactive) {
        // Registering a client is the first step of a login, and logins happen in the CLI.
        if (!rec.clientInformation) throw new NeedsLoginError(serverKey);
        return rec.clientInformation;
      }
      // A registration made for another loopback port cannot complete this login.
      if (rec.redirectUrl && rec.redirectUrl !== String(effectiveRedirect)) return undefined;
      return rec.clientInformation;
    },

    async saveClientInformation(info) {
      await write({ clientInformation: info, redirectUrl: redirectUrl ? String(redirectUrl) : '' });
    },

    async tokens() {
      return (await read()).tokens;
    },

    async saveTokens(tokens) {
      await write({ tokens, tokensSavedAt: new Date().toISOString() });
    },

    async redirectToAuthorization(url) {
      if (!interactive) throw new NeedsLoginError(serverKey);
      await onRedirect?.(url);
    },

    async saveCodeVerifier(verifier) {
      await write({ codeVerifier: verifier });
    },

    async codeVerifier() {
      const v = (await read()).codeVerifier;
      if (!v) throw new Error('no PKCE code verifier saved — restart the login');
      return v;
    },

    async saveDiscoveryState(state) {
      await write({ discoveryState: state });
    },

    async discoveryState() {
      return (await read()).discoveryState;
    },

    async invalidateCredentials(what) {
      const rec = await read();
      if (what === 'all') { await store.kv.delete(OAUTH_NS, serverKey); return; }
      if (what === 'client') delete rec.clientInformation;
      if (what === 'tokens') delete rec.tokens;
      if (what === 'verifier') delete rec.codeVerifier;
      if (what === 'discovery') delete rec.discoveryState;
      await store.kv.set(OAUTH_NS, serverKey, { sealed: seal(JSON.stringify(rec), sealKey), updatedAt: new Date().toISOString() });
    },

    /** Not part of the SDK interface: the state the last authorization URL carried. */
    async expectedState() {
      return (await read()).state;
    },
  };
}

/** Is there a sealed token record for this server? Never unseals. */
export async function hasLogin(store, serverKey) {
  return Boolean((await store.kv.get(OAUTH_NS, serverKey))?.sealed);
}

function listenForCallback({ port = 0, host = '127.0.0.1' } = {}) {
  let resolveCode;
  let rejectCode;
  const code = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const err = url.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    if (err) {
      res.end(`Almagest: authorization failed (${err}). You can close this tab.`);
      rejectCode(new Error(`authorization server returned error: ${err} ${url.searchParams.get('error_description') || ''}`.trim()));
      return;
    }
    res.end('Almagest: authorized. You can close this tab and return to the terminal.');
    resolveCode({ code: url.searchParams.get('code') || '', state: url.searchParams.get('state') || '' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      resolve({ redirectUrl: `http://${host}:${actual}/callback`, code, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/**
 * The browser flow: listen on a loopback port, hand the authorization URL to
 * `onUrl` (the CLI prints it), wait for the redirect, check `state`, exchange
 * the code. Tokens land sealed in the store via the provider.
 *
 * @param {object} o
 * @param {object} o.store
 * @param {{ key: string, url: string }} o.spec   an HTTP/SSE server spec
 * @param {(url: URL) => void} o.onUrl
 * @param {object} [o.oauth]   connector `oauth:` block — { scope, client_id, client_secret, redirect_port }
 * @param {Function} [o.fetchFn]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<'AUTHORIZED'>}
 */
export async function login({ store, spec, onUrl, oauth = {}, fetchFn, timeoutMs = LOGIN_TIMEOUT_MS, secret }) {
  if (spec.type === 'stdio') throw new Error(`"${spec.key}" is a stdio server — OAuth applies to HTTP servers only`);
  const listener = await listenForCallback({ port: Number(oauth.redirect_port || 0) });
  try {
    const provider = createOAuthProvider({
      store,
      serverKey: spec.key,
      redirectUrl: listener.redirectUrl,
      scope: oauth.scope,
      staticClient: oauth.client_id ? { client_id: oauth.client_id, ...(oauth.client_secret ? { client_secret: oauth.client_secret } : {}) } : undefined,
      interactive: true,
      onRedirect: onUrl,
      secret,
    });
    // Force a fresh authorization rather than silently reusing a refresh token.
    await provider.invalidateCredentials('tokens');
    const first = await auth(provider, { serverUrl: spec.url, scope: oauth.scope, fetchFn });
    if (first === 'AUTHORIZED') return first;

    const { code, state } = await withTimeout(listener.code, timeoutMs, 'waiting for the browser authorization');
    const expected = await provider.expectedState();
    if (!code) throw new Error('authorization redirect carried no code');
    if (expected && state !== expected) throw new Error('authorization redirect carried the wrong state — possible CSRF, aborted');
    const result = await auth(provider, { serverUrl: spec.url, authorizationCode: code, scope: oauth.scope, fetchFn });
    if (result !== 'AUTHORIZED') throw new Error(`authorization did not complete (${result})`);
    return result;
  } finally {
    await listener.close();
  }
}
