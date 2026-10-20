/**
 * signing.mjs — HMAC-signed tokens, constant-time comparison, short codes.
 *
 * One secret, `ALMAGEST_SECRET_KEY`, signs browser sessions, CSRF tokens and
 * the links channels send. Purpose strings keep a token minted for one use
 * from being replayed as another (a CSRF token is not a session).
 */
import crypto from 'node:crypto';

let ephemeral = null;

/**
 * The signing secret. Without ALMAGEST_SECRET_KEY the service still runs (solo
 * on a laptop) with a per-process secret — every session and link dies on
 * restart, and the log says so once.
 */
export function secretKey({ env = process.env, log } = {}) {
  if (env.ALMAGEST_SECRET_KEY) return String(env.ALMAGEST_SECRET_KEY);
  if (!ephemeral) {
    ephemeral = crypto.randomBytes(32).toString('hex');
    log?.warn('ALMAGEST_SECRET_KEY is not set — using a temporary key; sign-ins and links stop working when the service restarts');
  }
  return ephemeral;
}

export function hmac(secret, data, encoding = 'base64url') {
  return crypto.createHmac('sha256', String(secret)).update(String(data)).digest(encoding);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** `<payload>.<sig>` where payload is base64url JSON and sig covers purpose + payload. */
export function sign(secret, purpose, value) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${hmac(secret, `${purpose}.${body}`)}`;
}

/** The signed value, or null when the signature, purpose or `exp` (ms epoch) does not hold. */
export function verify(secret, purpose, token, now = Date.now()) {
  const s = String(token ?? '');
  const dot = s.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = s.slice(0, dot);
  if (!safeEqual(s.slice(dot + 1), hmac(secret, `${purpose}.${body}`))) return null;
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
    if (value && typeof value.exp === 'number' && value.exp < now) return null;
    return value;
  } catch {
    return null;
  }
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';   // no 0/O, 1/I/L — read aloud from a chat window

/** `XXXX-XXXX` style code, `groups` × 4 characters, ~20 bits per group. */
export function shortCode(groups = 3) {
  const out = [];
  for (let g = 0; g < groups; g++) {
    let s = '';
    for (const b of crypto.randomBytes(4)) s += ALPHABET[b % ALPHABET.length];
    out.push(s);
  }
  return out.join('-');
}

export function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}
