/**
 * sessions.mjs — browser sign-in for the review inbox, and CSRF.
 *
 * Ways in, chosen by `service.auth.provider`:
 *
 *   token — /inbox/login shows a form for a sign-in secret from
 *           ALMAGEST_LOGINS (`name:secret`, for a person named in
 *           ALMAGEST_TOKENS). API tokens from ALMAGEST_TOKENS never sign in:
 *           they sit in chat configs, where an agent can read them. Or
 *           `almagest login [name]` prints a one-time link, signed with
 *           ALMAGEST_SECRET_KEY and valid for minutes (/inbox/login/link/:token).
 *   oidc  — /inbox/login sends you to the identity provider (authorization
 *           code + PKCE), and back to /inbox/auth/callback.
 *
 * Either way the result is an HMAC-signed session cookie (HttpOnly,
 * SameSite=Lax, Secure on https) naming a server-side session record, so
 * signing out — or removing someone's entry — ends the session for real.
 *
 * Roles: under tokens, a session's person and roles are re-read from
 * ALMAGEST_TOKENS on every request, and a changed or removed sign-in secret
 * ends it. Under single sign-on they are what the IdP said at sign-in — or at
 * the person's latest sign-in anywhere, when newer. `session.rolesAt` says
 * since when; the service sends a session whose roles are too old to sign in
 * again before it approves or turns anything down (service.mjs).
 *
 * CSRF: every browser gets a random `almagest_csrf` cookie; forms carry
 * HMAC(secret, nonce + session id). A POST whose token does not match, or
 * whose Origin / Sec-Fetch-Site names another site, is refused. A POST made
 * before signing in (the sign-in forms) has no session to bind its token to —
 * anyone can fetch the form and its cookie first — so it must also carry the
 * browser's same-origin signal: a request with neither header is refused.
 */
import { humanActor, parseLogins, parseTokens, resolveLogins } from '../core/auth.mjs';
import { html, safeNext } from './html.mjs';
import { createOidc, pkcePair } from './oidc.mjs';
import { hmac, randomToken, safeEqual, sign, verify } from './signing.mjs';
import { vouch } from './trust.mjs';
import { layout, newNonce, securityHeaders } from './web/layout.mjs';

export const SESSION_COOKIE = 'almagest_session';
export const CSRF_COOKIE = 'almagest_csrf';
const OIDC_COOKIE = 'almagest_oidc';
const NS = 'governance.session';
const LINK_NS = 'governance.login-link';
const LINK_PURPOSE = 'login-link';
export const LOGIN_LINK_MINUTES = 10;
const LOGIN_LINK_MAX_MINUTES = 60;

const envNames = (config) => ({
  tokensEnv: config.service.auth.tokens_env || 'ALMAGEST_TOKENS',
  loginsEnv: config.service.auth.logins_env || 'ALMAGEST_LOGINS',
});

/**
 * A one-time sign-in link, for `almagest login` (token sign-in only). Signed
 * with ALMAGEST_SECRET_KEY, so it works only when the CLI runs with the
 * service's key; the service enforces single use and the expiry.
 */
export function loginLink(config, { name = '', next = '/inbox', minutes = LOGIN_LINK_MINUTES, env = process.env, now = Date.now() } = {}) {
  if (config.service.auth.provider === 'oidc') throw new Error('this instance signs in with single sign-on — open the inbox and use that');
  const key = env.ALMAGEST_SECRET_KEY;
  if (!key) throw new Error('ALMAGEST_SECRET_KEY is not set — use the value the service runs with; the link is signed with it');
  const { tokensEnv } = envNames(config);
  const people = parseTokens(env[tokensEnv] || '');
  if (!people.length) throw new Error(`${tokensEnv} is empty — add the person there (name:roles:secret) first`);
  const known = people.map((t) => t.actor.display).join(', ');
  let person;
  if (name) {
    person = people.find((t) => t.actor.display === name || t.actor.id === name)?.actor;
    if (!person) throw new Error(`"${name}" is not in ${tokensEnv} — known: ${known}`);
  } else if (people.length === 1) {
    person = people[0].actor;
  } else {
    throw new Error(`say who to sign in as: almagest login <name> — known: ${known}`);
  }
  const mins = Math.min(LOGIN_LINK_MAX_MINUTES, Math.max(1, Number(minutes) || LOGIN_LINK_MINUTES));
  const exp = now + mins * 60 * 1000;
  const token = sign(key, LINK_PURPOSE, { id: person.id, jti: randomToken(12), next: safeNext(next), exp });
  return { url: `${String(config.service.http.base_url).replace(/\/+$/, '')}/inbox/login/link/${token}`, actor: person, expiresAt: new Date(exp).toISOString() };
}

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

export function createSessions(ctx, { secret, identities = null, ttlHours = 12, now = () => Date.now() }) {
  const { config, store, log } = ctx;
  const mode = config.service.auth.provider;
  const base = String(config.service.http.base_url);
  const secure = base.startsWith('https:');
  let publicHost = '';
  try { publicHost = new URL(base).host; } catch { /* no base_url: Origin is compared with Host only */ }
  const ttlMs = ttlHours * 3600 * 1000;
  const oidc = mode === 'oidc' ? createOidc(config.service.auth.oidc || {}, { baseUrl: config.service.http.base_url, ownerTeams: config.v1.ownerTeams, now }) : null;
  const failures = new Map();   // ip → { n, until }
  const iso = () => new Date(now()).toISOString();
  let linkLock = Promise.resolve();

  const { tokensEnv, loginsEnv } = envNames(config);
  const currentTokens = () => parseTokens(process.env[tokensEnv] || '');
  const loginState = () => resolveLogins(currentTokens(), parseLogins(process.env[loginsEnv] || ''), { tokensEnv, loginsEnv });
  const currentLogins = () => loginState().usable;
  /** Fingerprint of a sign-in secret, kept on the session: change or remove the secret and the session ends. */
  const credOf = (loginSecret) => hmac(secret, `login.${loginSecret}`);

  if (mode !== 'oidc') {
    const { usable, problems } = loginState();   // a malformed entry stops startup here, not at the first sign-in
    for (const p of problems) log?.warn(p);
    if (!usable.length) {
      log?.warn(`nobody can sign in to the review inbox: API tokens in ${tokensEnv} do not sign in. Give each reviewer a sign-in secret in ${loginsEnv} ("<name>:<secret>"), or run \`almagest login <name>\` for a one-time link`);
    }
  }

  function readSigned(req) {
    const raw = parseCookies(req)[SESSION_COOKIE];
    return raw ? verify(secret, 'session', raw, now()) : null;
  }

  /** Who a session record stands for right now, and since when its roles are known — or null when it no longer stands. */
  async function liveActor(rec) {
    // 'token' sessions were opened with an API token, before sign-in secrets
    // were split from API tokens. They end; the person signs in again.
    if (rec.idp === 'token') return null;
    if (mode !== 'oidc') {
      // Re-read on every request: someone removed from ALMAGEST_TOKENS is
      // signed out, a role change applies at once.
      const hit = currentTokens().find((t) => t.actor.id === rec.actor.id);
      if (!hit) return null;
      if (rec.idp === 'login' && !currentLogins().some((l) => l.id === rec.actor.id && safeEqual(credOf(l.secret), rec.cred || ''))) return null;
      const teams = rec.actor.teams?.length ? rec.actor.teams : hit.actor.teams;
      return { actor: { ...hit.actor, email: rec.actor.email || hit.actor.email || '', teams: [...(teams || [])] }, rolesAt: iso() };
    }
    // Single sign-on: the IdP's word at sign-in, or at this person's latest
    // sign-in anywhere when that is as new or newer — a demotion seen there applies here.
    let actor = rec.actor;
    let rolesAt = rec.rolesAt ?? rec.createdAt;
    const latest = await identities?.byId(actor.id);
    if (latest?.confirmedAt && Date.parse(latest.confirmedAt) >= (Date.parse(rolesAt) || 0)) {
      actor = { ...actor, roles: [...(latest.roles || [])], teams: [...(latest.teams || [])] };
      rolesAt = latest.confirmedAt;
    }
    return { actor, rolesAt };
  }

  /** The AuthProvider registered with ctx.auth.use(). First in the chain, so a cookie wins over a bearer header. */
  const provider = {
    name: 'session',
    async authenticate(req) {
      const s = readSigned(req);
      if (!s?.sid) return null;
      const rec = await store.kv.get(NS, s.sid);
      if (!rec || rec.revoked || Date.parse(rec.expiresAt) < now()) return null;
      const live = await liveActor(rec);
      if (!live) return null;
      // Vouched: this actor came from a browser session, the one path allowed to act (trust.mjs).
      return vouch({ ...live.actor, kind: 'human', idp: rec.idp, session: { sid: s.sid, authAt: rec.createdAt, rolesAt: live.rolesAt } }, 'session');
    },
  };

  async function issue(res, actor, idp, { cred = '' } = {}) {
    const sid = randomToken(18);
    const expiresAt = new Date(now() + ttlMs).toISOString();
    const snapshot = { id: actor.id, kind: 'human', display: actor.display, email: actor.email || '', roles: [...(actor.roles || [])], teams: [...(actor.teams || [])] };
    // An email link under single sign-on carries roles read from the identity
    // registry: they are as old as that record, not as new as this session.
    const cached = mode === 'oidc' && idp === 'email-link';
    const rolesAt = cached ? ((await identities?.byId(actor.id))?.confirmedAt || '') : iso();
    await store.kv.set(NS, sid, { actor: snapshot, idp, createdAt: iso(), rolesAt, expiresAt, revoked: false, ...(cred ? { cred } : {}) });
    await identities?.remember({ ...snapshot, idp }, { confirmed: !cached });
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

  /**
   * The browser's own word on where a POST came from. Sec-Fetch-Site counts
   * when present (it survives `Referrer-Policy: no-referrer`, under which
   * browsers send `Origin: null`); otherwise Origin must name this service.
   * With neither header, only `strict: false` lets the request through.
   */
  function sameOrigin(req, { strict = false } = {}) {
    const site = String(req.headers?.['sec-fetch-site'] || '');
    const origin = req.headers?.origin;
    if (site && site !== 'same-origin') return false;
    let originOk = false;
    if (origin && origin !== 'null') {
      let host;
      try { host = new URL(origin).host; } catch { return false; }
      if (host !== req.headers?.host && host !== publicHost) return false;
      originOk = true;
    }
    if (site === 'same-origin' || originOk) return true;
    if (origin === 'null') return false;
    return !strict;
  }

  /**
   * True when `supplied` is the token for this browser + session and the
   * request is same-origin. Before sign-in (no session) the same-origin
   * signal is required, not merely "not another site".
   */
  function checkCsrf(req, supplied, actor = null) {
    if (!sameOrigin(req, { strict: !actor?.session?.sid })) return false;
    const nonce = parseCookies(req)[CSRF_COOKIE];
    if (!nonce || !supplied) return false;
    return safeEqual(supplied, hmac(secret, `csrf.${nonce}.${actor?.session?.sid || ''}`));
  }

  // ── pages ──────────────────────────────────────────────────────────────────

  function page(req, res, { status = 200, body, title = 'Sign in' }) {
    const nonce = newNonce();
    return { status, headers: securityHeaders(nonce), html: String(layout({ title, nonce, body })) };
  }

  function loginPage(req, res, { error = '', next = '/inbox', notice = '', status } = {}) {
    const csrf = csrfToken(req, res);
    const unset = mode !== 'oidc' && currentLogins().length === 0;
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
          <p class="lede">Enter your sign-in secret. Whoever runs this knowledge base can give you one, or a one-time sign-in link. An API token — the one a chat uses — doesn't work here.</p>
          ${error ? html`<div class="flash flash--err" role="alert">${error}</div>` : ''}
          ${notice ? html`<div class="flash flash--ok">${notice}</div>` : ''}
          ${unset ? html`<div class="flash" role="note">Sign-in isn't set up yet. On the machine that runs Almagest, run <code>almagest login</code> for a one-time link, or set ${loginsEnv}.</div>` : ''}
          <form method="post" action="/inbox/login">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="next" value="${safeNext(next)}">
            <label for="secret" class="faint">Sign-in secret</label>
            <input id="secret" name="secret" type="password" autocomplete="current-password" required autofocus>
            <p><button class="btn btn--primary" type="submit">Sign in</button></p>
          </form>
        </div>`;
    return page(req, res, { status: status ?? (error ? 401 : 200), body });
  }

  function continuePage(req, res, { display, token }) {
    const csrf = csrfToken(req, res);
    const body = html`<div class="login card">
      <h1>Continue as ${display}?</h1>
      <p class="lede">This sign-in link works once, for a few minutes.</p>
      <form method="post" action="/inbox/login/link/${encodeURIComponent(token)}">
        <input type="hidden" name="csrf" value="${csrf}">
        <p><button class="btn btn--primary" type="submit">Continue</button></p>
      </form>
    </div>`;
    return page(req, res, { body, title: 'Continue' });
  }

  /** Mark a sign-in link used; false when it already was. Serialised, so two clicks cannot both win. */
  function spendLink(v) {
    const run = linkLock.then(async () => {
      if (await store.kv.get(LINK_NS, v.jti)) return false;
      for (const { key, value } of await store.kv.list(LINK_NS)) if (!(value?.exp > now())) await store.kv.delete(LINK_NS, key);
      await store.kv.set(LINK_NS, v.jti, { id: v.id, usedAt: iso(), exp: v.exp });
      return true;
    });
    linkLock = run.catch(() => {});
    return run;
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
      // m=reauth: the service asked for a fresh sign-in, so the page shows even to a signed-in browser.
      if (actor?.kind === 'human' && actor.session && query.m !== 'reauth') { redirect(res, safeNext(query.next)); return undefined; }
      const notice = query.m === 'bye' ? 'You are signed out.'
        : query.m === 'reauth' ? 'Please sign in again. Approving or turning something down needs a recent sign-in, so that your roles are current.' : '';
      return loginPage(req, res, { next: safeNext(query.next), notice });
    });

    http.route('POST', '/inbox/login', async (req, res, { body }) => {
      const next = safeNext(body?.next);
      if (!checkCsrf(req, body?.csrf)) return loginPage(req, res, { error: 'That form expired. Reload the page and try again.', next, status: 403 });
      if (mode !== 'token') return loginPage(req, res, { error: 'Sign in with single sign-on instead.', next });
      if (throttled(req)) return loginPage(req, res, { error: 'Too many attempts. Wait a few minutes and try again.', next, status: 429 });
      const presented = String(body?.secret || '').trim();
      const hit = presented && currentLogins().find((l) => safeEqual(l.secret, presented));
      if (!hit) {
        fail(req);
        if (presented && currentTokens().some((t) => safeEqual(t.secret, presented))) {
          log?.warn('an API token was used to try to sign in to the inbox — refused', { ip: req.socket?.remoteAddress || '' });
          return loginPage(req, res, { error: "That's an API token. API tokens connect chats and scripts and can't sign in here — use your sign-in secret, or ask for a sign-in link.", next });
        }
        return loginPage(req, res, { error: "That didn't work. Check your sign-in secret.", next });
      }
      await issue(res, hit.actor, 'login', { cred: credOf(hit.secret) });
      redirect(res, next);
      return undefined;
    });

    // `almagest login` links. The GET only shows "Continue as …" (mail and
    // chat scanners prefetch links); the POST spends the link and signs in.
    const linkGone = (req, res) => loginPage(req, res, { error: 'That sign-in link has expired or was already used. Run almagest login again for a new one.', status: 410 });
    const readLink = (token) => (mode === 'oidc' ? null : verify(secret, LINK_PURPOSE, token, now()));
    const linkPerson = (v) => (v?.jti ? currentTokens().find((t) => t.actor.id === v.id)?.actor || null : null);

    http.route('GET', '/inbox/login/link/:token', async (req, res, { params }) => {
      const v = readLink(params.token);
      const person = linkPerson(v);
      if (!person || await store.kv.get(LINK_NS, v.jti)) return linkGone(req, res);
      return continuePage(req, res, { display: person.display, token: params.token });
    });

    http.route('POST', '/inbox/login/link/:token', async (req, res, { params, body }) => {
      if (!checkCsrf(req, body?.csrf)) return loginPage(req, res, { error: 'That form expired. Open the sign-in link again.', status: 403 });
      if (throttled(req)) return loginPage(req, res, { error: 'Too many attempts. Wait a few minutes and try again.', status: 429 });
      const v = readLink(params.token);
      const person = linkPerson(v);
      if (!person || !(await spendLink(v))) { fail(req); return linkGone(req, res); }
      await issue(res, person, 'login-link');
      redirect(res, safeNext(v.next));
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

  return { provider, issue, revoke, csrfToken, checkCsrf, sameOrigin, routes, loginPage, mode, oidc, humanActor };
}
