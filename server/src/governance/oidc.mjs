/**
 * oidc.mjs — OpenID Connect, with node:crypto and fetch only.
 *
 *   createOidc(config.service.auth.oidc, { baseUrl }) →
 *     .discover()                         the issuer's discovery document (cached)
 *     .authorizeUrl({ state, nonce, verifier })
 *     .exchange(code, verifier)           → token response
 *     .verifyJwt(token, { nonce?, audience? }) → claims  (signature via JWKS, iss, aud, exp, nbf)
 *     .actorFromClaims(claims)            → Actor (kind human, idp 'oidc')
 *
 * Config keys (`service.auth.oidc`): issuer, client_id, client_secret_env,
 * audience, scopes, roles_claim, teams_claim, role_map, default_roles,
 * redirect_path.
 *
 * This is the browser half only (sign-in redirect, code exchange, ID token).
 * Bearer-JWT validation for API and MCP callers is core/auth-oidc.mjs, which
 * registers the `oidc` auth provider; this file does not register one.
 */
import crypto from 'node:crypto';

import { humanActor } from '../core/auth.mjs';
import { ROLES } from '../core/schemas.mjs';

const ALGS = {
  RS256: { hash: 'sha256' }, RS384: { hash: 'sha384' }, RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: true }, PS384: { hash: 'sha384', pss: true }, PS512: { hash: 'sha512', pss: true },
  ES256: { hash: 'sha256', ec: true }, ES384: { hash: 'sha384', ec: true }, ES512: { hash: 'sha512', ec: true },
  EdDSA: { hash: null },
};

export class OidcError extends Error {
  constructor(message) { super(message); this.name = 'OidcError'; this.status = 401; }
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf-8'));

export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function claimList(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(/[\s,]+/).filter(Boolean);
  return [];
}

/** Read a dotted claim path: `realm_access.roles`. */
function claimAt(claims, dotted) {
  return String(dotted || '').split('.').filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), claims);
}

export function createOidc(oidc = {}, { baseUrl = '', fetchImpl = globalThis.fetch, env = process.env, now = () => Date.now() } = {}) {
  const issuer = String(oidc.issuer || '').replace(/\/+$/, '');
  let discovery = null;
  let jwks = null;
  let jwksAt = 0;

  async function discover() {
    if (discovery) return discovery;
    if (!issuer) throw new OidcError('service.auth.oidc.issuer is not set');
    const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new OidcError(`OIDC discovery failed (${res.status})`);
    const doc = await res.json();
    if (String(doc.issuer || '').replace(/\/+$/, '') !== issuer) throw new OidcError('OIDC discovery issuer does not match the configured issuer');
    discovery = doc;
    return doc;
  }

  async function keys(force = false) {
    if (jwks && !force && now() - jwksAt < 10 * 60 * 1000) return jwks;
    const { jwks_uri: uri } = await discover();
    const res = await fetchImpl(uri);
    if (!res.ok) throw new OidcError(`could not fetch the issuer's signing keys (${res.status})`);
    jwks = (await res.json()).keys || [];
    jwksAt = now();
    return jwks;
  }

  const redirectUri = () => `${String(baseUrl).replace(/\/+$/, '')}${oidc.redirect_path || '/inbox/auth/callback'}`;

  async function authorizeUrl({ state, nonce, challenge }) {
    const d = await discover();
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', oidc.client_id);
    u.searchParams.set('redirect_uri', redirectUri());
    u.searchParams.set('scope', ['openid', 'email', 'profile', ...claimList(oidc.scopes)].filter((v, i, a) => a.indexOf(v) === i).join(' '));
    u.searchParams.set('state', state);
    u.searchParams.set('nonce', nonce);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  async function exchange(code, verifier) {
    const d = await discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri(), client_id: oidc.client_id, code_verifier: verifier,
    });
    const secret = oidc.client_secret_env ? env[oidc.client_secret_env] : '';
    if (secret) body.set('client_secret', secret);
    const res = await fetchImpl(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
    if (!res.ok) throw new OidcError(`the identity provider refused the sign-in (${res.status})`);
    return res.json();
  }

  async function verifyJwt(token, { nonce, audience = oidc.audience || oidc.client_id } = {}) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new OidcError('malformed token');
    let header;
    let claims;
    try { header = b64json(parts[0]); claims = b64json(parts[1]); } catch { throw new OidcError('malformed token'); }
    const alg = ALGS[header.alg];
    if (!alg) throw new OidcError(`unsupported token algorithm ${header.alg}`);

    let list = await keys();
    let jwk = list.find((k) => (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig'));
    if (!jwk) { list = await keys(true); jwk = list.find((k) => !header.kid || k.kid === header.kid); }
    if (!jwk) throw new OidcError('token signed with an unknown key');

    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = Buffer.from(parts[2], 'base64url');
    const opts = { key };
    if (alg.pss) { opts.padding = crypto.constants.RSA_PKCS1_PSS_PADDING; opts.saltLength = crypto.constants.RSA_PSS_SALTLEN_DIGEST; }
    if (alg.ec) opts.dsaEncoding = 'ieee-p1363';
    if (!crypto.verify(alg.hash, data, opts, sig)) throw new OidcError('token signature is invalid');

    const t = Math.floor(now() / 1000);
    const skew = 60;
    if (String(claims.iss || '').replace(/\/+$/, '') !== issuer) throw new OidcError('token issuer does not match');
    const aud = claimList(claims.aud);
    if (audience && !aud.includes(audience)) throw new OidcError('token audience does not match');
    if (typeof claims.exp !== 'number' || claims.exp + skew < t) throw new OidcError('token has expired');
    if (typeof claims.nbf === 'number' && claims.nbf - skew > t) throw new OidcError('token is not valid yet');
    if (nonce !== undefined && claims.nonce !== nonce) throw new OidcError('sign-in nonce does not match');
    return claims;
  }

  function actorFromClaims(claims) {
    const map = oidc.role_map || {};
    const rawRoles = claimList(claimAt(claims, oidc.roles_claim || 'roles'));
    const roles = [...new Set(rawRoles.map((r) => map[r] || r).filter((r) => ROLES.includes(r)))];
    const teams = claimList(claimAt(claims, oidc.teams_claim || 'groups'));
    const email = String(claims.email || '');
    const handle = String(email || claims.preferred_username || claims.sub || '').toLowerCase();
    const actor = humanActor({
      id: `usr_${handle}`,
      display: String(claims.name || claims.preferred_username || email || claims.sub || 'unknown'),
      email,
      roles: roles.length ? roles : claimList(oidc.default_roles || ['viewer']).filter((r) => ROLES.includes(r)),
      teams,
    });
    return { ...actor, idp: 'oidc', sub: String(claims.sub || '') };
  }

  return { issuer, discover, authorizeUrl, exchange, verifyJwt, actorFromClaims, redirectUri };
}
