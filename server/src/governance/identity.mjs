/**
 * identity.mjs — one person, one approver.
 *
 * The policy engine counts distinct people and separation of duties compares
 * the approver with the submitter. Both break if one person can appear under
 * two ids — say `usr_<sub>` from single sign-on and a hand-written `usr_ada`
 * in a Slack mapping. So:
 *
 *   - every human the service sees signing in is remembered here, id ↔ email
 *     (lowercased), with the roles and teams they signed in with and when
 *     those were last confirmed (`confirmedAt`);
 *   - channel mappings (`users:` for Slack and GitHub, email `recipients`) are
 *     resolved to that canonical person by email — never trusted as an id;
 *   - the policy counts people by `personKey` (the email when known, else the
 *     id) and checks SoD against every key the submitter is known by.
 *
 * Roles cached here go stale: under single sign-on the IdP is only asked at
 * sign-in. A Slack or GitHub action resolved from a record whose roles were
 * confirmed longer ago than `governance.channel_roles_max_age_hours`
 * (default 24) is refused until the person signs in to the inbox again.
 *
 * Storage: store.kv namespace `governance.identity`, keys `id:<id>` and
 * `email:<email>`.
 */
import { humanActor } from '../core/auth.mjs';

const NS = 'governance.identity';

export const normEmail = (e) => String(e || '').trim().toLowerCase();

/** The keys a person is known by, from what is on hand (pure). */
export function keysFor(id, email) {
  const keys = new Set([`id:${id}`]);
  const e = normEmail(email);
  if (e) keys.add(`email:${e}`);
  return keys;
}

/**
 * Startup check for a channel's person mapping. Under single sign-on every
 * mapping must name an email (that is how it is resolved). Under tokens, a
 * mapping must name someone in ALMAGEST_TOKENS — and needs an email whenever
 * counting people matters (separation of duties, or rules asking for more than
 * one approval).
 */
export function validateMappings(where, entries, { mode, multi, tokenIds = [] }) {
  for (const [key, m] of entries) {
    if (!m || typeof m !== 'object') throw new Error(`${where}.${key} must be an object with at least an email`);
    if (mode === 'oidc' && !normEmail(m.email)) {
      throw new Error(`${where}.${key} needs an email — under single sign-on, channel accounts are linked to people by email`);
    }
    if (mode !== 'oidc') {
      if (multi && !normEmail(m.email)) {
        throw new Error(`${where}.${key} needs an email — separation of duties or multi-approval rules are on, so every channel account must be tied to one person`);
      }
      if (multi && m.id && !tokenIds.includes(m.id)) {
        throw new Error(`${where}.${key} names "${m.id}", who is not in ALMAGEST_TOKENS — map channel accounts to people who exist`);
      }
    }
  }
}

export const DEFAULT_CHANNEL_ROLES_MAX_AGE_HOURS = 24;

/** When this record's roles were last confirmed (records from before `confirmedAt` existed: when last seen). */
export const confirmedAtOf = (rec) => rec?.confirmedAt ?? rec?.seenAt ?? '';

export function createIdentities({ store, log, rolesMaxAgeMs = DEFAULT_CHANNEL_ROLES_MAX_AGE_HOURS * 3600 * 1000, now = () => Date.now() }) {
  async function byId(id) { return id ? store.kv.get(NS, `id:${id}`) : null; }
  async function byEmail(email) { const e = normEmail(email); return e ? store.kv.get(NS, `email:${e}`) : null; }

  /**
   * Record a human the service just authenticated. `confirmed: false` when
   * the roles on `actor` were themselves read from this registry (an email
   * link under single sign-on): the id ↔ email link is recorded, but the
   * roles and their age are left as they were — re-reading a cached role must
   * never make it look fresh.
   */
  async function remember(actor, { confirmed = true } = {}) {
    if (!actor?.id || actor.kind !== 'human') return null;
    const prev = await byId(actor.id);
    const email = normEmail(actor.email) || prev?.email || '';
    const keep = !confirmed && prev;
    const at = new Date(now()).toISOString();
    const rec = {
      id: actor.id, email,
      display: actor.display || prev?.display || actor.id,
      idp: (keep ? prev.idp : actor.idp) || prev?.idp || '',
      roles: [...(keep ? prev.roles || [] : actor.roles || prev?.roles || [])],
      teams: [...(keep ? prev.teams || [] : actor.teams || prev?.teams || [])],
      seenAt: at,
      confirmedAt: confirmed ? at : confirmedAtOf(prev),
    };
    await store.kv.set(NS, `id:${actor.id}`, rec);
    if (email) {
      const e = (await byEmail(email)) || { email, ids: [] };
      if (!e.ids.includes(actor.id)) e.ids.push(actor.id);
      e.latest = actor.id;
      e.seenAt = rec.seenAt;
      await store.kv.set(NS, `email:${email}`, e);
    }
    return rec;
  }

  /**
   * Map id → { personKey, keys } for every id given. `hints` are emails seen
   * on approval records, used when the registry has none for that id.
   * Two ids that share an email are one person.
   */
  async function keyring(ids, hints = new Map()) {
    const ring = new Map();
    for (const id of new Set(ids.filter(Boolean))) {
      const rec = await byId(id);
      const email = rec?.email || normEmail(hints.get(id));
      const keys = keysFor(id, email);
      if (email) {
        const e = await byEmail(email);
        for (const other of e?.ids || []) keys.add(`id:${other}`);
      }
      ring.set(id, { personKey: email ? `email:${email}` : `id:${id}`, keys });
    }
    return ring;
  }

  /**
   * Resolve a channel mapping (`{ id?, email, display?, roles?, teams? }`) to
   * the canonical person, or explain why not. Roles and teams come from how the
   * person actually signs in, not from the mapping, whenever that is known.
   */
  async function resolveMapped(mapping, { mode, tokens = [] }) {
    const email = normEmail(mapping?.email);
    if (mode === 'oidc') {
      if (!email) return { refused: 'This account has no email in the Almagest mapping. Ask an administrator.' };
      const e = await byEmail(email);
      const rec = e ? await byId(e.latest) : null;
      if (!rec) return { refused: 'Sign in to the review inbox once with single sign-on to link this account.' };
      const at = Date.parse(confirmedAtOf(rec));
      if (!(now() - at <= rolesMaxAgeMs)) {
        log?.info('channel action refused: cached roles are too old', { id: rec.id, confirmedAt: confirmedAtOf(rec) });
        return { stale: true, refused: `Your reviewer roles were last checked when you signed in to the review inbox, more than ${hoursWords(rolesMaxAgeMs)} ago. Sign in there again with single sign-on to refresh them, then try again.` };
      }
      return { actor: humanActor({ id: rec.id, display: rec.display, email, roles: rec.roles, teams: rec.teams }), rolesAt: confirmedAtOf(rec) };
    }
    const token = tokens.find((t) => t.actor.id === mapping?.id)?.actor;
    if (!token) {
      log?.warn('channel mapping names nobody in ALMAGEST_TOKENS', { id: mapping?.id || '' });
      return { refused: 'This account is mapped to someone who is not set up in Almagest. Ask an administrator.' };
    }
    const actor = humanActor({ id: token.id, display: token.display, email, roles: token.roles, teams: mapping.teams || token.teams || [] });
    if (email) await remember({ ...actor, idp: 'token' });
    return { actor, rolesAt: new Date(now()).toISOString() };
  }

  /**
   * Each id's roles as they stand now, for counting approvals at merge time:
   * under tokens, from ALMAGEST_TOKENS (someone no longer listed has none);
   * under single sign-on, from the person's latest confirmed sign-in. An id
   * with nothing on record is left out — the caller keeps what it has.
   */
  async function currentRoles(ids, { mode, tokens = [] }) {
    const out = new Map();
    for (const id of new Set(ids.filter(Boolean))) {
      if (mode !== 'oidc') {
        out.set(id, [...(tokens.find((t) => t.actor.id === id)?.actor.roles || [])]);
        continue;
      }
      const rec = await byId(id);
      if (rec) out.set(id, [...(rec.roles || [])]);
    }
    return out;
  }

  return { remember, byId, byEmail, keyring, resolveMapped, currentRoles };
}

function hoursWords(ms) {
  const h = ms / 3600000;
  return h >= 1 ? `${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}` : `${Math.max(1, Math.round(ms / 60000))} minutes`;
}
