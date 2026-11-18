/**
 * learnings.mjs — what a learning is, read from a page, and what the service
 * remembers when a person turns one down.
 *
 * A learning is a `claim` page with `origin: self`, a `## Basis` of wikilinks,
 * and no inline citations (agent/rules/wiki.md). Three places need to read
 * one the same way: the runner, which refuses a synthesize run that wrote a
 * bad one; the proposal, which shows each learning's Basis as links; and the
 * memory below, which keeps the Basis set of a learning that was turned down.
 *
 * Pages are parsed through safeFrontmatter and the shared wiki-core helpers,
 * never through gray-matter directly.
 */
import crypto from 'node:crypto';

import matter from 'gray-matter';

import { asString, BASE_KEYS, normalizeSources, RELATION_KEYS, resolveTarget, safeFrontmatter, sectionLines, stripBrackets } from '../../../tools/lib/wiki-core.mjs';

import { isPlaceholderRow } from './bookkeeping.mjs';

const parseFrontmatter = safeFrontmatter(matter);

const count = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : fallback);

/** `config.synthesis` with every value checked, so no caller reads a raw string or a negative number. */
export function synthesisSettings(config) {
  const c = config.synthesis || {};
  return {
    enabled: c.enabled === true,
    minChangedPages: count(c.min_changed_pages, 5),
    maxRunsPerDay: count(c.max_runs_per_day, 1),
    maxClaims: count(c.max_claims, 5),
    schedule: String(c.schedule || '').trim(),
  };
}

/**
 * The longest a learning's body may be. A learning is one conclusion a person
 * reads whole in the inbox; the runner refuses a longer one rather than the
 * inbox cutting it.
 */
export const MAX_LEARNING_CHARS = 8000;

/** Limits on a learning's front matter: some of its fields reach chats, so none may be unbounded. */
export const MAX_FRONT_STRING = 300;
export const MAX_FRONT_LIST = 20;
export const MAX_FRONT_CHARS = 4000;

// ── characters a person cannot see ──────────────────────────────────────────

const HIDDEN_NAMES = new Map([
  [0x202A, 'left-to-right embedding'], [0x202B, 'right-to-left embedding'], [0x202C, 'pop directional formatting'],
  [0x202D, 'left-to-right override'], [0x202E, 'right-to-left override'],
  [0x2066, 'left-to-right isolate'], [0x2067, 'right-to-left isolate'], [0x2068, 'first strong isolate'], [0x2069, 'pop directional isolate'],
  [0x061C, 'arabic letter mark'], [0x200E, 'left-to-right mark'], [0x200F, 'right-to-left mark'],
  [0x200B, 'zero-width space'], [0x200C, 'zero-width non-joiner'], [0x200D, 'zero-width joiner'], [0x2060, 'word joiner'],
  [0xFEFF, 'byte order mark or zero-width no-break space'], [0x2028, 'line separator'], [0x2029, 'paragraph separator'],
]);

/**
 * The first character in `text` that a person reading it in the inbox may not
 * see, or that a chat reads in another order: a bidirectional control, a
 * zero-width character, a tag character, or any C0 or C1 control character
 * except a tab and a line break. One byte order mark at the very start is
 * allowed, and so is a carriage return that is half of a CRLF line break.
 * Returns `{ code, name, index, line, column }` or null.
 */
export function hiddenCharacter(text) {
  const t = String(text);
  let line = 1;
  let column = 1;
  for (let i = 0; i < t.length;) {
    const cp = t.codePointAt(i);
    const width = cp > 0xFFFF ? 2 : 1;
    const hidden = HIDDEN_NAMES.has(cp)
      || (cp < 0x20 && cp !== 0x09 && cp !== 0x0A)
      || (cp >= 0x7F && cp <= 0x9F)
      || (cp >= 0xE0000 && cp <= 0xE007F);
    const allowed = (cp === 0xFEFF && i === 0) || (cp === 0x0D && t[i + 1] === '\n');
    if (hidden && !allowed) {
      const code = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      const name = HIDDEN_NAMES.get(cp) || (cp < 0x20 || (cp >= 0x7F && cp <= 0x9F) ? 'control character' : 'tag character');
      return { code, name, index: i, line, column };
    }
    if (cp === 0x0A) { line += 1; column = 1; } else column += width;
    i += width;
  }
  return null;
}

/** The hit of `hiddenCharacter` as a sentence fragment: `U+202E (right-to-left override) at line 3, column 9`. */
export const describeHidden = (hit) => `${hit.code} (${hit.name}) at line ${hit.line}, column ${hit.column}`;

// ── front matter ─────────────────────────────────────────────────────────────

/**
 * What is wrong with a learning's front matter, or null. A learning is a
 * `claim` page: it may carry the base keys of the page schema
 * (agent/rules/wiki.md) and the frontmatter fields `type_fields.claim` names
 * in brain.config.yaml, nothing else. Each string is at most MAX_FRONT_STRING
 * characters, each list at most MAX_FRONT_LIST entries, the whole block at
 * most MAX_FRONT_CHARS characters. `related` and `relations` name pages that
 * exist on main (`known`).
 */
export function frontMatterProblem(page, { claimFields = [], known = new Set() } = {}) {
  const allowed = new Set([...BASE_KEYS, ...claimFields]);
  const data = page.data || {};
  if (page.front.length > MAX_FRONT_CHARS) {
    return `its front matter is ${page.front.length} characters, over the limit of ${MAX_FRONT_CHARS} characters`;
  }
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) return `its front matter has a key \`${key}\`, which a claim page does not need (allowed: ${[...allowed].join(', ')})`;
  }
  const walk = (value, where, depth) => {
    if (typeof value === 'string') {
      return value.length > MAX_FRONT_STRING ? `\`${where}\` is ${value.length} characters, over the limit of ${MAX_FRONT_STRING} characters` : null;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_FRONT_LIST) return `\`${where}\` has ${value.length} entries, over the limit of ${MAX_FRONT_LIST} entries`;
      for (const v of value) { const bad = walk(v, where, depth + 1); if (bad) return bad; }
      return null;
    }
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if (depth > 2) return `\`${where}\` is nested deeper than a claim page needs`;
      for (const [k, v] of Object.entries(value)) { const bad = walk(v, `${where}.${k}`, depth + 1); if (bad) return bad; }
    }
    return null;
  };
  for (const [key, value] of Object.entries(data)) {
    const bad = walk(value, key, 0);
    if (bad) return `its front matter field ${bad}`;
  }
  const rel = data.relations;
  if (rel !== undefined && rel !== null) {
    if (typeof rel !== 'object' || Array.isArray(rel)) return 'its `relations` is not a mapping of the four typed edges';
    for (const key of Object.keys(rel)) if (!RELATION_KEYS.includes(key)) return `its front matter has a relations key \`${key}\`, which is not one of ${RELATION_KEYS.join(', ')}`;
  }
  const targets = [['related', data.related], ...(rel ? Object.entries(rel).map(([k, v]) => [`relations.${k}`, v]) : [])];
  for (const [where, value] of targets) {
    if (value === undefined || value === null || value === '') continue;
    const list = Array.isArray(value) ? value : [value];
    const missing = [];
    for (const entry of list) {
      const target = typeof entry === 'string' ? stripBrackets(entry) : '';
      if (!target || !resolveTarget(target, '', known)) missing.push(typeof entry === 'string' ? target || entry : String(entry));
    }
    if (missing.length) return `its front matter \`${where}\` names ${missing.slice(0, 5).join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not a page on main — related and relations name pages that already exist on main`;
  }
  return null;
}

/**
 * The front matter fields of a learning that carry meaning, as short text the
 * inbox shows open beside the body: the title, aliases and tags a chat will
 * see, the confidence, and the pages it relates to.
 */
export function learningMeta(page) {
  const d = page.data || {};
  const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]).slice(0, MAX_FRONT_LIST).map((x) => stripBrackets(String(x)).slice(0, MAX_FRONT_STRING));
  const rel = d.relations && typeof d.relations === 'object' && !Array.isArray(d.relations) ? d.relations : {};
  return {
    title: String(d.title ?? '').slice(0, MAX_FRONT_STRING),
    aliases: list(d.aliases),
    tags: list(d.tags),
    confidence: String(d.confidence ?? '').slice(0, 40),
    related: list(d.related),
    relations: Object.fromEntries(RELATION_KEYS.map((k) => [k, list(rel[k])]).filter(([, v]) => v.length)),
  };
}

// ── bookkeeping files ────────────────────────────────────────────────────────

/**
 * The first line a run added to `after` anywhere but at the end, or null. A
 * learnings run may only append to the index and the log: a table row comes
 * after the last existing row of its table (or replaces a placeholder row),
 * any other added line comes after everything already in the file, and blank
 * lines may be added anywhere. Lost or changed lines are not judged here
 * (the runner checks them first).
 */
export function appendViolation(before, after) {
  const split = (t) => { const xs = String(t ?? '').split('\n'); if (xs.length && xs[xs.length - 1] === '') xs.pop(); return xs; };
  const old = split(before);
  const now = split(after);
  const kept = new Set();
  let at = 0;
  for (let j = 0; j < now.length; j++) {
    let k = at;
    while (k < old.length && isPlaceholderRow(old[k]) && old[k] !== now[j]) k += 1;
    if (k < old.length && old[k] === now[j]) { kept.add(j); at = k + 1; }
  }
  const isRow = (l) => l.trim().startsWith('|');
  const keptAfter = (from, to) => { for (let x = from; x <= to; x++) if (kept.has(x)) return true; return false; };
  for (let j = 0; j < now.length; j++) {
    if (kept.has(j) || now[j].trim() === '') continue;
    if (isPlaceholderRow(now[j]) && old.includes(now[j])) continue;
    if (!isRow(now[j])) {
      if (keptAfter(j + 1, now.length - 1)) return now[j].trim();
      continue;
    }
    let s = j;
    let e = j;
    while (s > 0 && isRow(now[s - 1])) s -= 1;
    while (e + 1 < now.length && isRow(now[e + 1])) e += 1;
    if (keptAfter(j + 1, e)) return now[j].trim();
    if (!keptAfter(s, j - 1) && keptAfter(j + 1, now.length - 1)) return now[j].trim();
  }
  return null;
}

/**
 * The synthetic source of a learnings proposal is `learnings_<sha7 of main>`.
 * `slugify` (what a chat title or a file name becomes) emits only a-z, 0-9 and
 * "-", so no title can produce the underscore: a source submitted by hand can
 * never share this id.
 */
export const LEARNINGS_SOURCE_PREFIX = 'learnings_';

/** Store namespace for learnings a person turned down. Key: hash of the sorted Basis slugs. */
export const REJECTED_NS = 'synthesis.rejected';

export const sha256Text = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

/**
 * What the checks need from one page's text. Throws when the front matter
 * cannot be read as YAML (the caller reports it).
 */
export function readPage(text) {
  const parsed = parseFrontmatter(text);
  const data = parsed.data || {};
  return {
    data,
    body: parsed.content,
    front: String(parsed.matter || ''),
    title: asString(data.title),
    type: asString(data.type),
    tier: asString(data.tier),
    origin: asString(data.origin) || 'source',
    aliases: Array.isArray(data.aliases) ? data.aliases.map(String) : [],
    sources: normalizeSources(data.sources),
  };
}

/**
 * The targets of the `## Basis` bullets, as the page wrote them (a bullet
 * that is not a wikilink adds nothing; the audit reports it as CITE-006).
 */
export function basisTargets(body) {
  const out = [];
  for (const line of sectionLines(body, 'Basis')) {
    const bullet = line.trim().match(/^(?:[-*+]|\d+[.)])\s+\[\[([^\]|#]+)/);
    if (bullet) out.push(bullet[1].trim());
  }
  return out;
}

/**
 * The Basis of a page as slugs of pages that exist (`known`: the page ids on
 * main), sorted and without repeats. `missing` lists targets that name no page.
 */
export function basisOf(body, known) {
  const slugs = new Set();
  const missing = [];
  for (const target of basisTargets(body)) {
    const id = resolveTarget(target, '', known);
    if (id) slugs.add(id);
    else if (!missing.includes(target)) missing.push(target);
  }
  return { slugs: [...slugs].sort(), missing };
}

/**
 * How many different sources a set of pages cites. Two source entries are the
 * same source when they share an id or a sha256, so a page that renames the
 * id of a document does not make it two.
 */
export function distinctSources(pages) {
  const groups = [];
  for (const page of pages) {
    for (const s of page.sources || []) {
      const keys = [s.id ? `id:${s.id}` : '', s.sha256 ? `sha:${s.sha256}` : ''].filter(Boolean);
      if (!keys.length) continue;
      const hit = groups.filter((g) => keys.some((k) => g.has(k)));
      const merged = new Set(keys);
      for (const g of hit) { for (const k of g) merged.add(k); groups.splice(groups.indexOf(g), 1); }
      groups.push(merged);
    }
  }
  return groups.length;
}

const keyOf = (slugs) => sha256Text([...new Set(slugs)].sort().join('\n'));

/**
 * The memory of learnings people turned down. A record names the sorted Basis
 * slugs, the title, and the content hash of every Basis page when it was
 * turned down. A new learning with the same Basis set is refused while every
 * one of those pages is unchanged.
 */
export function createRejectedMemory({ store, git, config }) {
  const main = () => config.service.git.main;
  const wikiDir = () => `${config.v1.brainDir.replace(/\/+$/, '')}/wiki`;

  async function hashOf(slug, ref = main()) {
    const text = await git.show(ref, `${wikiDir()}/${slug}.md`);
    return typeof text === 'string' ? sha256Text(text) : '';
  }

  return {
    hashOf,

    async remember({ basis, title }) {
      const slugs = [...new Set(basis)].sort();
      if (slugs.length === 0) return null;
      const hashes = {};
      for (const slug of slugs) hashes[slug] = await hashOf(slug);
      const record = { basis: slugs, title: String(title || '').slice(0, 300), hashes, at: new Date().toISOString() };
      await store.kv.set(REJECTED_NS, keyOf(slugs), record);
      return record;
    },

    async list() {
      const rows = await store.kv.list(REJECTED_NS);
      return (rows || []).map((r) => r.value ?? r).filter((r) => Array.isArray(r?.basis));
    },

    /** The record that forbids a learning resting on exactly `basis`, or null (none, or a Basis page changed since). */
    async blocking(basis) {
      const record = await store.kv.get(REJECTED_NS, keyOf(basis));
      if (!record?.hashes) return null;
      for (const slug of record.basis) {
        if ((await hashOf(slug)) !== record.hashes[slug]) return null;
      }
      return record;
    },

    /** Records whose Basis pages are all unchanged: what the next prompt lists. */
    async standing() {
      const out = [];
      for (const record of await this.list()) {
        let same = true;
        for (const slug of record.basis) if ((await hashOf(slug)) !== record.hashes?.[slug]) { same = false; break; }
        if (same) out.push(record);
      }
      return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    },
  };
}
