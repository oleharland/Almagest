/**
 * sessions.mjs — browser sign-in for the review inbox, and CSRF.
 *
 * Two ways in, chosen by `service.auth.provider`:
 *
 *   token — /inbox/login shows a form; paste a token from ALMAGEST_TOKENS.
 *   oidc  — /inbox/login sends you to the identity provider (authorization
 *           code + PKCE), and back to /inbox/auth/callback.
 *
 * Either way the result is an HMAC-signed session cookie (HttpOnly,
 * SameSite=Lax, Secure on https) naming a server-side session record, so
 * signing out — or removing someone's token — ends the session for real.
 *
 * CSRF: every browser gets a random `almagest_csrf` cookie; forms carry
 * HMAC(secret, nonce + session id). A POST whose token does not match, or
 * whose Origin is another site, is refused.
 */
import { humanActor, parseTokens } from '../core/auth.mjs';
import { html, safeNext } from './html.mjs';
import { createOidc, pkcePair } from './oidc.mjs';
import { hmac, randomToken, safeEqual, sign, verify } from './signing.mjs';
import { layout, newNonce, securityHeaders } from './web/layout.mjs';

export const SESSION_COOKIE = 'almagest_session';
export const CSRF_COOKIE = 'almagest_csrf';
const OIDC_COOKIE = 'almagest_oidc';
const NS = 'governance.session';

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers?.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

export function cookieHeader(name, value, { maxAge, secure = false, httpOnly = true, sameSite = 'Lax' } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${sameSite}`];
  if (httpOnly) bits.push('HttpOnly');
  if (secure) bits.push('Secure');
  if (maxAge !== undefined) bits.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return bits.join('; ');
}

/** Append a Set-Cookie without clobbering ones already queued on `res`. */
export function addCookie(res, header) {
  const prev = res.getHeader('set-cookie');
  res.setHeader('set-cookie', [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), header]);
}

export function redirect(res, location, status = 303) {
  res.statusCode = status;
  res.setHeader('location', location);
  res.end();
}

export function createSessions(ctx, { secret, ttlHours = 12, now = () => Date.now() }) {
  const { config, store, log } = ctx;
  const mode = config.service.auth.provider;
  const secure = String(config.service.http.base_url).startsWith('https:');
  const ttlMs = ttlHours * 3600 * 1000;
  const oidc = mode === 'oidc' ? createOidc(config.service.auth.oidc || {}, { baseUrl: config.service.http.base_url, ownerTeams: config.v1.ownerTeams, now }) : null;
  const failures = new Map();   // ip → { n, until }

  const currentTokens = () => parseTokens(process.env[config.service.auth.tokens_env || 'ALMAGEST_TOKENS'] || '');

  function readSigned(req) {
    const raw = parseCookies(req)[SESSION_COOKIE];
    return raw ? verify(secret, 'session', raw, now()) : null;
  }

  /** The AuthProvider registered with ctx.auth.use(). First in the chain, so a cookie wins over a bearer header. */
  const provider = {
    name: 'session',
    async authenticate(req) {
      const s = readSigned(req);
      if (!s?.sid) return null;
      const rec = await store.kv.get(NS, s.sid);
      if (!rec || rec.revoked || Date.parse(rec.expiresAt) < now()) return null;
      let actor = rec.actor;
      if (rec.idp === 'token') {
        // A token removed from ALMAGEST_TOKENS ends its sessions; role changes apply at once.
        const hit = currentTokens().find((t) => t.actor.id === actor.id);
        if (!hit) return null;
        actor = hit.actor;
      }
      return { ...actor, kind: 'human', idp: rec.idp, session: { sid: s.sid } };
    },
  };

  async function issue(res, actor, idp) {
    const sid = randomToken(18);
    const expiresAt = new Date(now() + ttlMs).toISOString();
    const snapshot = { id: actor.id, kind: 'human', display: actor.display, email: actor.email || '', roles: [...(actor.roles || [])], teams: [...(actor.teams || [])] };
    await store.kv.set(NS, sid, { actor: snapshot, idp, createdAt: new Date(now()).toISOString(), expiresAt, revoked: false });
    addCookie(res, cookieHeader(SESSION_COOKIE, sign(secret, 'session', { sid, exp: now() + ttlMs }), { maxAge: ttlMs / 1000, secure }));
    log?.info('signed in', { actor: actor.id, idp });
    return sid;
  }

  async function revoke(res, actor) {
    if (actor?.session?.sid) {
      const rec = await store.kv.get(NS, actor.session.sid);
      if (rec) await store.kv.set(NS, actor.session.sid, { ...rec, revoked: true });
    }
    addCookie(res, cookieHeader(SESSION_COOKIE, '', { maxAge: 0, secure }));
  }

  /** The CSRF token for this browser + session, queuing the nonce cookie when it is new. */
  function csrfToken(req, res, actor = null) {
    let nonce = parseCookies(req)[CSRF_COOKIE];
    if (!nonce || nonce.length < 16) {
      nonce = req.__almagestCsrf || randomToken(18);
      req.__almagestCsrf = nonce;
      if (res && !res.headersSent) addCookie(res, cookieHeader(CSRF_COOKIE, nonce, { secure }));
      // A cookie set on this very response is not on the request yet; remember it.
    }
    return hmac(secret, `csrf.${nonce}.${actor?.session?.sid || ''}`);
  }

  /** True when `supplied` is the token for this browser + session and the request is same-origin. */
  function checkCsrf(req, supplied, actor = null) {
    const origin = req.headers?.origin;
    if (origin && origin !== 'null') {
      try { if (new URL(origin).host !== req.headers.host) return false; } catch { return false; }
    } else if (origin === 'null') {
      return false;
    }
    const nonce = parseCookies(req)[CSRF_COOKIE];
    if (!nonce || !supplied) return false;
    return safeEqual(supplied, hmac(secret, `csrf.${nonce}.${actor?.session?.sid || ''}`));
  }

  // ── pages ──────────────────────────────────────────────────────────────────

  function page(req, res, { status = 200, body, title = 'Sign in' }) {
    const nonce = newNonce();
    return { status, headers: securityHeaders(nonce), html: String(layout({ title, nonce, body })) };
  }

  function loginPage(req, res, { error = '', next = '/inbox', notice = '' } = {}) {
    const csrf = csrfToken(req, res);
    const body = mode === 'oidc'
      ? html`<div class="login card">
          <h1>Sign in to review</h1>
          <p class="lede">Use your company account. You'll come straight back here.</p>
          ${error ? html`<div class="flash flash--err" role="alert">${error}</div>` : ''}
          ${notice ? html`<div class="flash flash--ok">${notice}</div>` : ''}
          <a class="btn btn--primary" href="/inbox/login/sso?next=${encodeURIComponent(next)}">Sign in with single sign-on</a>
        </div>`
      : html`<div class="login card">
          <h1>Sign in to review</h1>
          <p class="lede">Paste your access token. Whoever runs this knowledge base can give you one.</p>
          ${error ? html`<div class="flash flash--err" role="alert">${error}</div>` : ''}
          ${notice ? html`<div class="flash flash--ok">${notice}</div>` : ''}
          <form method="post" action="/inbox/login">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="next" value="${safeNext(next)}">
            <label for="token" class="faint">Access token</label>
            <input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
            <p><button class="btn btn--primary" type="submit">Sign in</button></p>
          </form>
        </div>`;
    return page(req, res, { status: error ? 401 : 200, body });
  }

  function throttled(req) {
    const ip = req.socket?.remoteAddress || 'unknown';
    const f = failures.get(ip);
    return f && f.n >= 10 && f.until > now();
  }
  function fail(req) {
    const ip = req.socket?.remoteAddress || 'unknown';
    const f = failures.get(ip);
    const fresh = !f || f.until < now();
    failures.set(ip, { n: fresh ? 1 : f.n + 1, until: now() + 10 * 60 * 1000 });
  }

  function routes(http) {
    http.route('GET', '/inbox/login', async (req, res, { query, actor }) => {
      if (actor?.kind === 'human' && actor.session) { redirect(res, safeNext(query.next)); return undefined; }
      return loginPage(req, res, { next: safeNext(query.next), notice: query.m === 'bye' ? 'You are signed out.' : '' });
    });

    http.route('POST', '/inbox/login', async (req, res, { body }) => {
      const next = safeNext(body?.next);
      if (!checkCsrf(req, body?.csrf)) return loginPage(req, res, { error: 'That form expired. Please try again.', next });
      if (mode !== 'token') return loginPage(req, res, { error: 'Sign in with single sign-on instead.', next });
      if (throttled(req)) return loginPage(req, res, { error: 'Too many attempts. Wait a few minutes and try again.', next });
      const presented = String(body?.token || '').trim();
      const hit = presented && currentTokens().find((t) => safeEqual(t.secret, presented));
      if (!hit) { fail(req); return loginPage(req, res, { error: "That token didn't work.", next }); }
      await issue(res, hit.actor, 'token');
      redirect(res, next);
      return undefined;
    });

    http.route('POST', '/inbox/logout', async (req, res, { body, actor }) => {
      if (actor?.session && !checkCsrf(req, body?.csrf, actor)) return loginPage(req, res, { error: 'That form expired. Please try again.' });
      await revoke(res, actor);
      redirect(res, '/inbox/login?m=bye');
      return undefined;
    });

    http.route('GET', '/inbox/login/sso', async (req, res, { query }) => {
      if (!oidc) { redirect(res, '/inbox/login'); return undefined; }
      const { verifier, challenge } = pkcePair();
      const state = randomToken(18);
      const nonce = randomToken(18);
      const url = await oidc.authorizeUrl({ state, nonce, challenge });
      addCookie(res, cookieHeader(OIDC_COOKIE, sign(secret, 'oidc', { state, nonce, verifier, next: safeNext(query.next), exp: now() + 10 * 60 * 1000 }), { maxAge: 600, secure }));
      redirect(res, url, 302);
      return undefined;
    });

    http.route('GET', '/inbox/auth/callback', async (req, res, { query }) => {
      if (!oidc) { redirect(res, '/inbox/login'); return undefined; }
      const pending = verify(secret, 'oidc', parseCookies(req)[OIDC_COOKIE], now());
      addCookie(res, cookieHeader(OIDC_COOKIE, '', { maxAge: 0, secure }));
      if (query.error) return loginPage(req, res, { error: `The sign-in was cancelled (${query.error}).` });
      if (!pending || !query.state || !safeEqual(pending.state, query.state)) {
        return loginPage(req, res, { error: 'That sign-in link expired. Please try again.' });
      }
      try {
        const tokens = await oidc.exchange(String(query.code || ''), pending.verifier);
        const claims = await oidc.verifyJwt(tokens.id_token, { nonce: pending.nonce, audience: config.service.auth.oidc?.client_id });
        const actor = oidc.actorFromClaims(claims);
        await issue(res, actor, 'oidc');
        redirect(res, safeNext(pending.next));
        return undefined;
      } catch (err) {
        log?.warn('oidc sign-in failed', { error: err.message });
        return loginPage(req, res, { error: 'Sign-in failed. Please try again, or ask your administrator.' });
      }
    });
  }

  return { provider, issue, revoke, csrfToken, checkCsrf, routes, loginPage, mode, oidc, humanActor };
}
