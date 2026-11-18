/**
 * auth.mjs — who is acting, and the one rule about approval that no config can
 * change.
 *
 * Providers turn an HTTP request into an Actor. `token` ships here; `oidc`
 * (JWT bearer validation) and browser sessions register themselves from their
 * own modules via `registerAuthProvider`, so core stays dependency-free.
 */
import crypto from 'node:crypto';

import { APPROVER_ROLES, ROLES } from './schemas.mjs';

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export class ForbiddenError extends AuthError {
  constructor(message) {
    super(message, 403);
    this.name = 'ForbiddenError';
  }
}

// ── actors ───────────────────────────────────────────────────────────────────

export function humanActor({ id, display, email = '', roles = ['viewer'], teams = [] }) {
  for (const r of roles) if (!ROLES.includes(r)) throw new Error(`unknown role "${r}"`);
  return { id, kind: 'human', display: display || id, email, roles: [...roles], teams: [...teams] };
}

/**
 * An agent acting for someone. MCP sessions are always this, even when the
 * bearer token is a human's: the chat model holds the token, not the person.
 */
export function agentActor(name, onBehalfOf = null) {
  return {
    id: `agent:${name}`,
    kind: 'agent',
    display: name,
    roles: ['contributor'],
    teams: onBehalfOf?.teams ?? [],
    onBehalfOf: onBehalfOf ? { id: onBehalfOf.id, display: onBehalfOf.display } : null,
  };
}

export function serviceActor(name) {
  return { id: `svc:${name}`, kind: 'service', display: name, roles: [], teams: [] };
}

export function hasRole(actor, ...roles) {
  return Boolean(actor?.roles?.some((r) => roles.includes(r) || r === 'admin'));
}

/**
 * Non-negotiable 1, in code. Only a human with an approver role approves.
 * There is deliberately no option, flag or config key that relaxes this —
 * an "auto-approve" setting would be an unattended merge to main with extra
 * steps, and the contract forbids that.
 */
export function assertCanApprove(actor) {
  if (!actor) throw new AuthError('approval needs an authenticated actor');
  if (actor.kind !== 'human') {
    throw new ForbiddenError(`${actor.kind} actors cannot approve — only a human can merge to main`);
  }
  if (!actor.roles?.some((r) => APPROVER_ROLES.includes(r))) {
    throw new ForbiddenError(`${actor.display} has no approver role (${APPROVER_ROLES.join(' | ')})`);
  }
}

// ── providers ────────────────────────────────────────────────────────────────

const PROVIDERS = new Map();

/** @param {string} name  @param {(ctx) => { authenticate(req): Promise<Actor|null> }} factory */
export function registerAuthProvider(name, factory) {
  PROVIDERS.set(name, factory);
}

function bearer(req) {
  const h = req.headers?.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * `ALMAGEST_TOKENS="ada:owner,reviewer:s3cret;bot:contributor:t0ken"` →
 * one human actor per entry. Solo profile: one entry, role owner. These are
 * API tokens (bearer, MCP): they read and submit, and never sign in to the
 * inbox — see parseLogins.
 */
export function parseTokens(spec) {
  const out = [];
  for (const entry of String(spec || '').split(';').map((s) => s.trim()).filter(Boolean)) {
    const [name, roles, ...rest] = entry.split(':');
    const secret = rest.join(':');
    if (!name || !secret) throw new Error(`malformed token entry "${name || entry}" — expected name:roles:secret`);
    out.push({ secret, actor: humanActor({ id: `usr_${name}`, display: name, roles: (roles || 'viewer').split(',').filter(Boolean) }) });
  }
  return out;
}

/**
 * `ALMAGEST_LOGINS="ada:<secret>;bob:<secret>"` → inbox sign-in secrets, one
 * per person named in ALMAGEST_TOKENS (who they are and their roles stay
 * there). Kept apart from API tokens on purpose: an API token sits in a chat's
 * MCP config, where an agent can read it, so it must never open a browser
 * session — and a sign-in secret is never accepted as a bearer token.
 */
export function parseLogins(spec) {
  const out = [];
  for (const entry of String(spec || '').split(';').map((s) => s.trim()).filter(Boolean)) {
    const i = entry.indexOf(':');
    const name = i > 0 ? entry.slice(0, i) : '';
    const secret = i > 0 ? entry.slice(i + 1) : '';
    if (!name || !secret) throw new Error(`malformed sign-in entry "${name || entry.split(':')[0]}" — expected name:secret`);
    out.push({ name, id: `usr_${name}`, secret });
  }
  return out;
}

/**
 * The sign-in secrets that work, joined to the person they sign in as, and
 * why any others do not. A secret that is also an API token is not usable:
 * whoever holds the token would hold the sign-in too.
 */
export function resolveLogins(tokens, logins, { loginsEnv = 'ALMAGEST_LOGINS', tokensEnv = 'ALMAGEST_TOKENS' } = {}) {
  const usable = [];
  const problems = [];
  for (const l of logins) {
    const person = tokens.find((t) => t.actor.id === l.id)?.actor;
    if (!person) { problems.push(`${loginsEnv}: "${l.name}" is not in ${tokensEnv}, so it cannot sign in — add them there with their roles`); continue; }
    if (tokens.some((t) => safeEqual(t.secret, l.secret))) { problems.push(`${loginsEnv}: the sign-in secret for "${l.name}" is also an API token in ${tokensEnv} — pick a different one; until then it cannot sign in`); continue; }
    usable.push({ id: l.id, secret: l.secret, actor: person });
  }
  return { usable, problems };
}

registerAuthProvider('token', (ctx) => {
  const envName = ctx.config.service.auth.tokens_env || 'ALMAGEST_TOKENS';
  const tokens = parseTokens(process.env[envName] || '');
  return {
    name: 'token',
    tokens,
    async authenticate(req) {
      const presented = bearer(req) || req.headers?.['x-almagest-token'] || '';
      if (!presented) return null;
      const hit = tokens.find((t) => safeEqual(t.secret, presented));
      return hit ? hit.actor : null;
    },
  };
});

/**
 * Builds `ctx.auth`. Additional providers (browser sessions, Slack user
 * mapping) can be chained with `use(provider)` — first non-null actor wins.
 */
export function createAuth(ctx) {
  const name = ctx.config.service.auth.provider;
  const factory = PROVIDERS.get(name);
  if (!factory) {
    throw new Error(`auth provider "${name}" is not registered — known: ${[...PROVIDERS.keys()].join(', ')}`);
  }
  const chain = [factory(ctx)];

  return {
    provider: name,
    use(provider) { chain.unshift(provider); },
    async authenticate(req) {
      for (const p of chain) {
        const actor = await p.authenticate(req);
        if (actor) return actor;
      }
      return null;
    },
    bearer,
  };
}
