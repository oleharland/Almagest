/**
 * page-merge.mjs — combining two approved versions of one wiki page.
 *
 * Two proposals made from the same `main` can both write the page for one
 * subject. When the first is approved and merged, `git merge-tree` reports a
 * clash on that page for the second. Most such clashes are not disagreements:
 * the two versions carry different sources and different sections. This
 * module combines them without an agent, and only when that is provably safe.
 *
 *   mergePages({ base, ours, theirs, extended })  →  { ok: true, text } | { ok: false, reason }
 *   pageProvenance(merged, ours, theirs)          →  null | reason
 *
 * `ours` is the page on main, `theirs` the page at the reviewed head, `base`
 * the page at their merge base (null when both sides added it).
 *
 * The rules are in docs/v2/governance.md → How a merge happens. Everything
 * they do not cover is a clash, and a clash falls through to the conflict
 * revise path, exactly as before this module existed.
 *
 * The invariant that makes this safe to put in front of `main`: every body
 * line and every frontmatter value of the merged page occurs in main's version
 * or in the reviewed head's version. Nothing is invented, reworded or
 * reordered within a line. `mergePages` checks it before it returns, and
 * governance/merge.mjs checks it again from main and the reviewed head, on the
 * commit it is about to move main to, whoever made that commit.
 *
 * Pure. Parsing is gray-matter plus tools/lib/wiki-core.mjs, the same pair the
 * audit and the review builder use.
 */
import matter from 'gray-matter';
import YAML from 'yaml';

import { asString, sectionNames } from '../../../tools/lib/wiki-core.mjs';

class Clash extends Error {}
const clash = (why) => { throw new Clash(why); };

// ── parsing ──────────────────────────────────────────────────────────────────

/** Dates become plain `YYYY-MM-DD` strings (a bare date in YAML parses to a Date); everything is cloned. */
function plain(v) {
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

const eq = (a, b) => stable(a) === stable(b);

export function parsePage(text) {
  if (typeof text !== 'string') return null;
  try {
    // `{}` bypasses gray-matter's cache, which hands back shared objects.
    const f = matter(text, {});
    if (!/^---\r?\n/.test(text)) return null;
    return { data: plain(f.data || {}), matter: f.matter, body: f.content };
  } catch { return null; }
}

const isBlank = (l) => l.trim() === '';

/** Trailing blank lines removed — what two versions of a section are compared on. */
function core(lines) {
  let n = lines.length;
  while (n > 0 && isBlank(lines[n - 1])) n--;
  return lines.slice(0, n);
}

/**
 * The body as `##` sections. The heading rule and the fence rule are
 * wiki-core's (sectionNames); the result is checked against it, so a page this
 * file would read differently from the audit is a clash, not a guess.
 */
function splitSections(body) {
  const sections = [{ key: '', heading: null, lines: [] }];
  let fence = '';
  for (const line of String(body).split('\n')) {
    const t = line.trim();
    const f = t.match(/^(```|~~~)/);
    if (f) {
      if (!fence) fence = f[1]; else if (fence === f[1]) fence = '';
    } else if (!fence) {
      const h = t.match(/^##\s+(.*)$/);
      if (h) {
        const name = h[1].replace(/\s*#+\s*$/, '').trim();
        sections.push({ key: name.toLowerCase(), name, heading: line, lines: [] });
        continue;
      }
    }
    sections.at(-1).lines.push(line);
  }
  const names = sections.slice(1).map((s) => s.name);
  if (JSON.stringify(names) !== JSON.stringify(sectionNames(body))) clash('the headings are not read the same way as the audit reads them');
  const keys = sections.map((s) => s.key);
  if (new Set(keys).size !== keys.length) clash('two sections share a heading');
  return sections;
}

// ── frontmatter ──────────────────────────────────────────────────────────────

const SAME_KEYS = ['title', 'type', 'tier', 'origin'];
const ONE_SIDE_KEYS = ['status', 'confidence', 'owner'];
const LIST_KEYS = ['aliases', 'tags', 'related'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

const asList = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);

/** Union of two lists, first list's order first, duplicates (by value) once. */
function unionList(a, b) {
  const out = [];
  const seen = new Set();
  for (const item of [...asList(a), ...asList(b)]) {
    const k = stable(item);
    if (!seen.has(k)) { seen.add(k); out.push(item); }
  }
  return out;
}

function unionSources(a, b) {
  if ((a !== undefined && !Array.isArray(a)) || (b !== undefined && !Array.isArray(b))) clash('sources is not a list');
  const out = [];
  const byId = new Map();
  for (const entry of [...asList(a), ...asList(b)]) {
    const id = entry && typeof entry === 'object' ? asString(entry.id).trim() : '';
    if (!id) {
      if (!out.some((e) => eq(e, entry))) out.push(entry);
      continue;
    }
    const prev = byId.get(id);
    if (!prev) { byId.set(id, entry); out.push(entry); continue; }
    const key = (e) => `${asString(e.path).trim()}|${asString(e.sha256).trim().toLowerCase()}`;
    if (key(prev) !== key(entry)) clash(`source ${id} points at different files on the two sides`);
  }
  return out;
}

/** Equal, or present on one side only (a one-sided deletion against an unchanged value stays deleted). */
function oneSided(key, b, o, t, hasBase) {
  if (eq(o, t)) return o;
  if (o === undefined || t === undefined) {
    const kept = o === undefined ? t : o;
    if (hasBase && b !== undefined) {
      if (eq(kept, b)) return undefined;
      clash(`${key} was removed on one side and changed on the other`);
    }
    return kept;
  }
  clash(`${key} differs`);
}

function changedOnOneSide(key, b, o, t, hasBase, extended) {
  if (eq(o, t)) return o;
  if (hasBase) {
    if (eq(o, b)) return t;
    if (eq(t, b)) return o;
    clash(`${key} was changed differently on the two sides`);
  }
  if (extended) return o;
  clash(`${key} differs and there is no common version to say which one changed`);
}

function earlierLater(key, o, t, pickEarlier) {
  if (eq(o, t)) return o;
  if (typeof o === 'string' && typeof t === 'string' && DATE_RE.test(o) && DATE_RE.test(t)) {
    return (o <= t) === pickEarlier ? o : t;
  }
  clash(`${key} is not a date on both sides`);
}

function mergeRelations(b, o, t, hasBase) {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (o === undefined || t === undefined || !isObj(o) || !isObj(t)) return oneSided('relations', b, o, t, hasBase);
  const out = {};
  for (const k of [...Object.keys(o), ...Object.keys(t).filter((x) => !(x in o))]) {
    if (Array.isArray(o[k]) || Array.isArray(t[k])) {
      if ((o[k] !== undefined && !Array.isArray(o[k])) || (t[k] !== undefined && !Array.isArray(t[k]))) clash(`relations.${k} is not a list`);
      out[k] = unionList(o[k], t[k]);
    } else {
      const v = oneSided(`relations.${k}`, b?.[k], o[k], t[k], hasBase);
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

function mergeFrontmatter(B, O, T, extended) {
  const hasBase = B !== null;
  const out = {};
  const keys = [...Object.keys(O), ...Object.keys(T).filter((k) => !(k in O))];
  for (const k of keys) {
    const b = B?.[k];
    const o = O[k];
    const t = T[k];
    let v;
    if (SAME_KEYS.includes(k)) {
      if (!eq(o, t)) clash(`${k} differs`);
      v = o;
    } else if (ONE_SIDE_KEYS.includes(k)) v = changedOnOneSide(k, b, o, t, hasBase, extended);
    else if (k === 'date_created') v = o === undefined ? t : t === undefined ? o : earlierLater(k, o, t, true);
    else if (k === 'date_modified') v = o === undefined ? t : t === undefined ? o : earlierLater(k, o, t, false);
    // Earlier of the two; a page one side never verified is not verified as a whole.
    else if (k === 'last_verified') v = o === undefined || t === undefined ? undefined : earlierLater(k, o, t, true);
    else if (k === 'sources') v = unionSources(o, t);
    else if (LIST_KEYS.includes(k)) v = unionList(o, t);
    else if (k === 'relations') v = mergeRelations(b, o, t, hasBase);
    else v = oneSided(k, b, o, t, hasBase);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ── body ─────────────────────────────────────────────────────────────────────

const lineSet = (lines) => new Set(lines.filter((l) => !isBlank(l)));
const superset = (big, small) => { const s = lineSet(big); return [...lineSet(small)].every((l) => s.has(l)); };

/** Main's lines, then the reviewed head's lines main does not already have, paragraph breaks kept. */
function appendMissing(mine, theirs) {
  const have = lineSet(mine);
  const add = [];
  let gap = false;
  for (const l of theirs) {
    if (isBlank(l)) { gap = add.length > 0; continue; }
    if (have.has(l)) continue;
    if (gap) add.push('');
    gap = false;
    add.push(l);
  }
  return add.length ? [...mine, '', ...add] : mine;
}

function mergeSection(b, o, t, extended) {
  const [oc, tc] = [core(o.lines), core(t.lines)];
  if (eq(oc, tc)) return o.lines;
  if (b) {
    const bc = core(b.lines);
    if (eq(oc, bc)) return t.lines;
    if (eq(tc, bc)) return o.lines;
  }
  if (superset(oc, tc)) return o.lines;
  if (superset(tc, oc)) return t.lines;
  if (extended) return [...appendMissing(oc, tc), ''];
  return clash(`section “${o.name || 'the start of the page'}” was written differently on the two sides`);
}

function mergeBody(bBody, oBody, tBody, extended) {
  const O = splitSections(oBody);
  const T = splitSections(tBody);
  const B = bBody === null ? null : splitSections(bBody);
  const at = (list, key) => list?.find((s) => s.key === key);
  const keys = [...O.map((s) => s.key), ...T.map((s) => s.key).filter((k) => !at(O, k))];
  const out = [];
  for (const key of keys) {
    const [o, t, b] = [at(O, key), at(T, key), at(B, key)];
    let lines;
    let heading;
    if (o && t) {
      lines = mergeSection(b, o, t, extended);
      heading = o.heading;
    } else {
      const only = o || t;
      // Gone on one side: if the other side left it as it was, it stays gone.
      if (b && core(only.lines).join('\n') === core(b.lines).join('\n')) continue;
      if (b) clash(`section “${only.name}” was removed on one side and changed on the other`);
      lines = only.lines;
      heading = only.heading;
    }
    if (heading !== null) out.push(heading);
    out.push(...lines);
    if (lines.length && !isBlank(lines.at(-1))) out.push('');
    if (!lines.length) out.push('');
  }
  return out.join('\n').replace(/\n*$/, '\n');
}

// ── output ───────────────────────────────────────────────────────────────────

function frontmatterText(data) {
  const doc = new YAML.Document(data);
  YAML.visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(node.value)) node.type = 'QUOTE_DOUBLE';
    },
  });
  return doc.toString({ lineWidth: 0 }).replace(/\n+$/, '');
}

const bodyCore = (body) => core(String(body).split('\n')).join('\n');

// ── the invariant ────────────────────────────────────────────────────────────

/** Every scalar, list item and nested value of a frontmatter object as `path=value`, so two pages' values can be compared. */
function leaves(data) {
  const out = new Set();
  const walk = (path, v) => {
    if (Array.isArray(v)) v.forEach((item) => out.add(`${path}[]=${stable(item)}`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(`${path}.${k}`, x);
    else out.add(`${path}=${stable(v)}`);
  };
  for (const [k, v] of Object.entries(data)) walk(k, v);
  return out;
}

/**
 * Does every body line and every frontmatter value of `merged` occur in `ours`
 * (main) or `theirs` (the reviewed head)? Returns null when it does, else why not.
 * Blank lines carry no content and are not checked.
 */
export function pageProvenance(merged, ours, theirs) {
  const [m, o, t] = [parsePage(merged), parsePage(ours), parsePage(theirs)];
  if (!m) return 'the combined page has no readable frontmatter';
  if (!o || !t) return 'one of the two versions has no readable frontmatter';
  const seen = new Set([...o.body.split('\n'), ...t.body.split('\n')]);
  const extra = m.body.split('\n').find((l) => !isBlank(l) && !seen.has(l));
  if (extra !== undefined) return `a line is in neither version: ${JSON.stringify(extra.slice(0, 80))}`;
  const allowed = new Set([...leaves(o.data), ...leaves(t.data)]);
  const bad = [...leaves(m.data)].find((x) => !allowed.has(x));
  if (bad !== undefined) return `a frontmatter value is in neither version: ${bad.slice(0, 80)}`;
  return null;
}

// ── the merge ────────────────────────────────────────────────────────────────

/**
 * @param {object} p
 * @param {string|null} p.base      the page at the merge base, null when there is none
 * @param {string} p.ours           the page on main
 * @param {string} p.theirs         the page at the reviewed head
 * @param {boolean} [p.extended]    the proposal marked this slug in `extends`
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function mergePages({ base = null, ours, theirs, extended = false }) {
  try {
    const [o, t] = [parsePage(ours), parsePage(theirs)];
    if (!o || !t) return { ok: false, reason: 'a version has no readable frontmatter' };
    const b = base === null || base === undefined ? null : parsePage(base);
    if (base !== null && base !== undefined && !b) return { ok: false, reason: 'the common version has no readable frontmatter' };

    const data = mergeFrontmatter(b?.data ?? null, o.data, t.data, extended);
    const body = mergeBody(b ? b.body : null, o.body, t.body, extended);

    let text;
    if (eq(data, o.data) && bodyCore(body) === bodyCore(o.body)) text = ours;
    else if (eq(data, t.data) && bodyCore(body) === bodyCore(t.body)) text = theirs;
    else {
      const reuse = eq(data, o.data) ? o : eq(data, t.data) ? t : null;
      const fm = reuse ? reuse.matter.replace(/^\n/, '').replace(/\n+$/, '') : frontmatterText(data);
      text = `---\n${fm}\n---\n${body}`;
    }
    const why = pageProvenance(text, ours, theirs);
    if (why) return { ok: false, reason: why };
    return { ok: true, text };
  } catch (err) {
    if (err instanceof Clash) return { ok: false, reason: err.message };
    throw err;
  }
}
