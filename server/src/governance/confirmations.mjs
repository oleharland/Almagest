/**
 * confirmations.mjs — single-use, expiring codes that hand an action from a
 * channel that cannot approve (a chat, an email) to one that can (a signed-in
 * web session).
 *
 *   create({ proposalId, action, onBehalfOf }) → { code, url, expiresAt }
 *   peek(code)    → the record, with `state: 'ok' | 'expired' | 'used' | 'unknown'`
 *   consume(code) → the record, marked used — exactly once
 *
 * The code itself is never stored: the kv key is its sha256, so a copy of the
 * database does not hand out live links.
 */
import { NotFoundError } from '../core/store/index.mjs';
import { newId, nowIso } from '../core/schemas.mjs';
import { sha256hex, shortCode } from './signing.mjs';

const NS = 'governance.confirm';
export const CONFIRM_ACTIONS = ['approve', 'review', 'reject', 'request_changes'];

export function createConfirmations({ store, baseUrl, ttlMs = 15 * 60 * 1000, now = () => Date.now(), lock = (fn) => fn() }) {
  const key = (code) => sha256hex(String(code).trim().toUpperCase());

  async function create({ proposalId, action = 'approve', onBehalfOf = null, headSha = '', ttl = ttlMs, recipient = null, path: target = '' }) {
    if (!CONFIRM_ACTIONS.includes(action)) throw new Error(`unknown confirmation action "${action}" — ${CONFIRM_ACTIONS.join(' | ')}`);
    const code = shortCode(3);
    const expiresAt = new Date(now() + ttl).toISOString();
    await store.kv.set(NS, key(code), {
      id: newId('cnf', now()),
      proposalId, action, headSha,
      onBehalfOf: onBehalfOf ? { id: onBehalfOf.id, display: onBehalfOf.display || onBehalfOf.id } : null,
      recipient,
      target,
      createdAt: nowIso(new Date(now())), expiresAt, usedAt: null, usedBy: null,
    });
    const url = `${String(baseUrl).replace(/\/+$/, '')}/inbox/confirm/${encodeURIComponent(code)}`;
    return { code, url, expiresAt };
  }

  async function peek(code) {
    const rec = await store.kv.get(NS, key(code));
    if (!rec) return { state: 'unknown' };
    if (rec.usedAt) return { ...rec, state: 'used' };
    if (Date.parse(rec.expiresAt) < now()) return { ...rec, state: 'expired' };
    return { ...rec, state: 'ok' };
  }

  /** Marks the code used. Serialised by `lock` so two clicks cannot both win. */
  function consume(code, actor) {
    return lock(async () => {
      const rec = await peek(code);
      if (rec.state !== 'ok') {
        const err = new NotFoundError('confirmation', 'code');
        err.state = rec.state;
        err.status = rec.state === 'unknown' ? 404 : 410;
        err.message = rec.state === 'used' ? 'This link has already been used.' : rec.state === 'expired' ? 'This link has expired.' : 'This link is not valid.';
        throw err;
      }
      const { state, ...stored } = rec;
      const used = { ...stored, usedAt: nowIso(new Date(now())), usedBy: actor?.id || null };
      await store.kv.set(NS, key(code), used);
      return used;
    });
  }

  return { create, peek, consume };
}
