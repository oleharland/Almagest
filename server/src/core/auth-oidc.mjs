/**
 * auth-oidc.mjs — the `oidc` auth provider: validate a JWT bearer token issued
 * by the organisation's IdP and turn its claims into a human Actor.
 *
 * No JOSE dependency. Node's crypto already does everything a resource server
 * needs: `createPublicKey({ format: 'jwk' })` imports the IdP's published key
 * and `crypto.verify` checks the signature. What a library would add is
 * algorithm agility, and agility is exactly what JWT attacks exploit — so the
 * accepted algorithms are a closed list (RS256, ES256), `none` and HMAC are
 * refused outright, and the key type must match the algorithm.
 *
 *   service.auth:
 *     provider: oidc
 *     oidc:
 *       issuer: https://login.acme.com/realms/brain    # exact `iss`
 *       audience: almagest                            # required `aud` (defaults to client_id)
 *       roles_claim: realm_access.roles               # dotted path; array or space/comma string
 *       teams_claim: groups
 *       role_map: { brain-owners: owner }             # IdP value → Almagest role (optional)
 *       default_roles: [viewer]                       # when no claim maps to a role
 *       jwks_uri: …                                   # optional; skips discovery
 *       clock_skew_seconds: 60
 *
 * Registered as a side effect of importing this file. app.mjs imports it next
 * to createAuth, because createAuth resolves the provider before any module's
 * create(ctx) runs.
 */
import crypto from 'node:crypto';

import { humanActor, registerAuthProvider } from './auth.mjs';
import { ROLES } from './schemas.mjs';

const ALGORITHMS = {
  RS256: { kty: 'RSA', hash: 'sha256' },
  ES256: { kty: 'EC', crv: 'P-256', hash: 'sha256', dsaEncoding: 'ieee-p1363' },
};

export class JwtError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JwtError';
  }
}

function b64json(part, what) {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf-8')); }
  catch { throw new JwtError(`malformed JWT ${what}`); }
}

/** `realm_access.roles` → claims.realm_access.roles. Also accepts URL-style claim names containing dots when they exist verbatim. */
export function claimAt(claims, claimPath) {
  if (!claimPath) return undefined;
  if (Object.hasOwn(claims, claimPath)) return claims[claimPath];
  let cur = claims;
  for (const key of String(claimPath).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function listClaim(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  return String(v).split(/[\s,]+/).filter(Boolean);
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

/**
 * The verifier on its own, so it can be tested without a ctx.
 *
 * @param {object} options
 * @param {string} options.issuer
 * @param {string} options.audience
 * @param {string} [options.jwksUri]          skip discovery
 * @param {number} [options.clockSkewSeconds]
 * @param {Function} [options.fetch]
 * @param {() => number} [options.now]        ms
 */
export function createOidcVerifier(options) {
  const {
    issuer,
    audience,
    jwksUri = '',
    clockSkewSeconds = 60,
    fetch: fetchImpl = globalThis.fetch,
    now = Date.now,
    timeoutMs = 5000,
    minRefetchMs = 30_000,
  } = options;
  if (!issuer) throw new Error('oidc: `issuer` is required');
  if (!audience) throw new Error('oidc: `audience` (or `client_id`) is required — without it any token the IdP issues for any app would be accepted');

  let discovered = jwksUri ? { jwks_uri: jwksUri, issuer } : null;
  let keys = new Map();          // kid → KeyObject + jwk
  let lastFetch = 0;
  let inflight = null;

  async function discover() {
    if (discovered) return discovered;
    const doc = await fetchJson(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, fetchImpl, timeoutMs);
    // OpenID Connect Discovery §4.3: the document's issuer MUST equal the one we asked.
    if (doc.issuer !== issuer) throw new Error(`oidc: discovery issuer "${doc.issuer}" does not match configured "${issuer}"`);
    if (!doc.jwks_uri) throw new Error('oidc: discovery document has no jwks_uri');
    discovered = doc;
    return doc;
  }

  async function loadKeys() {
    if (inflight) return inflight;
    inflight = (async () => {
      const { jwks_uri } = await discover();
      const doc = await fetchJson(jwks_uri, fetchImpl, timeoutMs);
      const next = new Map();
      for (const jwk of Array.isArray(doc.keys) ? doc.keys : []) {
        if (jwk.use && jwk.use !== 'sig') continue;
        if (!jwk.kid) continue;
        try { next.set(jwk.kid, { jwk, key: crypto.createPublicKey({ key: jwk, format: 'jwk' }) }); }
        catch { /* a key Node cannot import is a key nobody can verify with — skip it */ }
      }
      keys = next;
      lastFetch = now();
    })().finally(() => { inflight = null; });
    return inflight;
  }

  /** Key for `kid`; refetches the JWKS once on a miss (key rotation), rate-limited. */
  async function keyFor(kid) {
    if (!keys.size) await loadKeys();
    if (!keys.has(kid) && now() - lastFetch >= minRefetchMs) await loadKeys();
    const hit = keys.get(kid);
    if (!hit) throw new JwtError(`unknown signing key "${kid}"`);
    return hit;
  }

  /** @returns {Promise<object>} the verified claims; throws JwtError otherwise. */
  async function verify(token) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new JwtError('not a JWT');
    const [h, p, s] = parts;
    const header = b64json(h, 'header');
    const alg = ALGORITHMS[header.alg];
    if (!alg) throw new JwtError(`algorithm "${header.alg}" is not accepted (RS256, ES256)`);
    if (!header.kid) throw new JwtError('JWT header has no kid');

    const { jwk, key } = await keyFor(header.kid);
    if (jwk.kty !== alg.kty || (alg.crv && jwk.crv !== alg.crv)) throw new JwtError(`key "${header.kid}" does not match ${header.alg}`);
    if (jwk.alg && jwk.alg !== header.alg) throw new JwtError(`key "${header.kid}" is for ${jwk.alg}, not ${header.alg}`);

    const signature = Buffer.from(s, 'base64url');
    const ok = crypto.verify(alg.hash, Buffer.from(`${h}.${p}`), alg.dsaEncoding ? { key, dsaEncoding: alg.dsaEncoding } : key, signature);
    if (!ok) throw new JwtError('bad signature');

    const claims = b64json(p, 'payload');
    const t = now() / 1000;
    if (claims.iss !== issuer) throw new JwtError(`issuer "${claims.iss}" is not "${issuer}"`);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw new JwtError(`audience does not include "${audience}"`);
    if (typeof claims.exp !== 'number') throw new JwtError('JWT has no exp');
    if (claims.exp + clockSkewSeconds < t) throw new JwtError('token expired');
    if (typeof claims.nbf === 'number' && claims.nbf - clockSkewSeconds > t) throw new JwtError('token not yet valid');
    if (!claims.sub) throw new JwtError('JWT has no sub');
    return claims;
  }

  return { verify, discover, get issuer() { return issuer; } };
}

/** Claims → human Actor, per the configured claim paths. */
export function actorFromClaims(claims, oidc = {}, ownerTeams = []) {
  const roleMap = oidc.role_map || {};
  const roles = new Set();
  for (const value of listClaim(claimAt(claims, oidc.roles_claim || 'roles'))) {
    const mapped = roleMap[value] ?? value;
    if (ROLES.includes(mapped)) roles.add(mapped);
  }
  if (!roles.size) {
    // `default_roles` (list) and `default_role` (scalar) are both accepted —
    // the inbox and MCP docs grew one each before this mapping was shared.
    const defaults = [].concat(oidc.default_roles ?? oidc.default_role ?? 'viewer').map(String).filter((r) => ROLES.includes(r));
    for (const r of defaults.length ? defaults : ['viewer']) roles.add(r);
  }

  let teams = listClaim(claimAt(claims, oidc.teams_claim || 'groups')).map((t) => t.replace(/^\//, ''));
  if (ownerTeams.length) teams = teams.filter((t) => ownerTeams.includes(t));

  const actor = humanActor({
    id: `usr_${String(claims.sub).replace(/[^A-Za-z0-9._@-]/g, '_')}`,
    display: claims.name || claims.preferred_username || claims.email || String(claims.sub),
    email: claims.email || '',
    roles: [...roles],
    teams,
  });
  // The id is keyed on `sub`, never on email: emails get reassigned, and
  // separation of duties compares ids — the bearer token a chat presents and
  // the browser session that approves must resolve to the same person.
  return { ...actor, idp: 'oidc', sub: String(claims.sub) };
}

registerAuthProvider('oidc', (ctx) => {
  const oidc = ctx.config.service.auth.oidc || {};
  const verifier = createOidcVerifier({
    issuer: oidc.issuer,
    audience: oidc.audience || oidc.client_id,
    jwksUri: oidc.jwks_uri,
    clockSkewSeconds: oidc.clock_skew_seconds ?? 60,
  });
  const ownerTeams = ctx.config.v1?.ownerTeams || [];
  return {
    name: 'oidc',
    issuer: oidc.issuer,
    verifier,
    async authenticate(req) {
      const m = (req.headers?.authorization || '').match(/^Bearer\s+(\S+\.\S+\.\S+)$/i);
      if (!m) return null;
      try {
        return actorFromClaims(await verifier.verify(m[1]), oidc, ownerTeams);
      } catch (err) {
        // Never throw: every route authenticates, including `auth: 'none'` ones.
        ctx.log?.debug('oidc token rejected', { reason: err.message });
        return null;
      }
    },
  };
});
