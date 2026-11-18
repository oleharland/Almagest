/**
 * page-merge.mjs — combining two approved versions of one wiki page.
 *
 * Two proposals made from the same `main` can both write the page for one
 * subject. When the first is approved and merged, `git merge-tree` reports a
 * clash on that page for the second. Most such clashes are not disagreements:
 * the two versions carry different sources and different sections. This
 * module combines them without an agent, and only when that is provably safe.
 *
 *   mergePages({ base, ours, theirs })            →  { ok: true, text } | { ok: false, reason }
 *   pageProvenance(merged, ours, theirs, base?)   →  null | reason
 *
 * `ours` is the page on main, `theirs` the page at the reviewed head, `base`
 * the page at their merge base (null when both sides added it).
 *
 * The rules are in docs/v2/governance.md → How a merge happens. They are
 * strictly conservative: where there is any doubt it is a clash, and a clash
 * falls through to the conflict revise path, exactly as before this module
 * existed. Nothing here depends on what the agent reported (`extends` is
 * information for the reviewer and decides nothing).
 *
 *   - With a common version, a section is merged line by line against the
 *     base's section with `git merge-file`, and accepted only when that is
 *     clean. A list in the frontmatter is merged three ways, so a removal
 *     approved on main stays removed. A scalar must be equal or changed on one
 *     side only.
 *   - With no common version, a section is kept when it is the same on both
 *     sides, or when one side's text is the other's with whole lines appended;
 *     lists are unions; any differing scalar is a clash.
 *
 * Invariant that makes this safe to put in front of `main`: every body line and
 * every frontmatter value of the merged page occurs in main's version or in
 * the reviewed head's version, the lines that come from one side keep that
 * side's order, and a list item the common version had and either side removed
 * is not back. `mergePages` checks it before it returns, and governance/merge.mjs
 * checks it again from main, the reviewed head and their merge base, on the
 * commit it is about to move main to, whoever made that commit.
 *
 * Parsing is gray-matter through safeFrontmatter (a `---js` block is refused,
 * never run) plus tools/lib/wiki-core.mjs, the same pair the audit and the
 * review builder use.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import matter from 'gray-matter';
import YAML from 'yaml';

import { asString, safeFrontmatter, sectionNames } from '../../../tools/lib/wiki-core.mjs';
import { childEnv } from '../core/git.mjs';

const parseFrontmatter = safeFrontmatter(matter);

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
    // safeFrontmatter passes its own options, which bypasses gray-matter's cache (it hands back shared objects).
    const f = parseFrontmatter(text);
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

const LIST_KEYS = ['aliases', 'tags', 'related'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** A list value as an array: absent, null and '' are the empty list; anything else that is not a list is a clash. */
function asList(key, v) {
  if (v === undefined || v === null || v === '') return [];
  if (!Array.isArray(v)) clash(`${key} is not a list`);
  return v;
}

/**
 * A list, merged. With a base: (ours ∪ theirs) − (base − ours) − (base − theirs),
 * main's order first, so an item either side removed since the base stays
 * removed. Without one: the union. Items are compared by value.
 */
function mergeList(key, b, o, t, hasBase) {
  const [ol, tl] = [asList(key, o), asList(key, t)];
  const bl = hasBase ? asList(key, b) : [];
  const keys = (list) => new Set(list.map(stable));
  const [inO, inT, inB] = [keys(ol), keys(tl), keys(bl)];
  const out = [];
  const seen = new Set();
  for (const item of [...ol, ...tl]) {
    const k = stable(item);
    if (seen.has(k)) continue;
    seen.add(k);
    if (inB.has(k) && !(inO.has(k) && inT.has(k))) continue;   // removed on a side since the base
    out.push(item);
  }
  return out;
}

/** `sources` by `id`: the three-way list rule, and the same id with different content on the two sides is a clash. */
function mergeSources(b, o, t, hasBase) {
  for (const v of [o, t, hasBase ? b : undefined]) if (v !== undefined && v !== null && !Array.isArray(v)) clash('sources is not a list');
  const keyOf = (entry) => {
    const id = entry && typeof entry === 'object' ? asString(entry.id).trim() : '';
    return id ? `id:${id}` : `value:${stable(entry)}`;
  };
  const index = (list) => {
    const m = new Map();
    for (const entry of list || []) {
      const k = keyOf(entry);
      if (m.has(k) && !eq(m.get(k), entry)) clash(`source ${k.slice(3)} is listed twice with different content`);
      m.set(k, entry);
    }
    return m;
  };
  const [O, T] = [index(o), index(t)];
  const B = hasBase ? index(b) : new Map();
  const out = [];
  for (const k of [...O.keys(), ...[...T.keys()].filter((x) => !O.has(x))]) {
    const [oe, te, be] = [O.get(k), T.get(k), B.get(k)];
    if (oe !== undefined && te !== undefined) {
      if (!eq(oe, te)) clash(`source ${k.slice(3)} differs on the two sides`);
      out.push(oe);
    } else {
      const only = oe !== undefined ? oe : te;
      if (be !== undefined) {
        if (!eq(only, be)) clash(`source ${k.slice(3)} was removed on one side and changed on the other`);
        continue;   // removed on one side, unchanged on the other: stays removed
      }
      out.push(only);
    }
  }
  return out;
}

/**
 * A value that is equal on both sides, or changed on one side only since the
 * base. With no base, any difference is a clash.
 */
function scalar(key, b, o, t, hasBase) {
  if (eq(o, t)) return o;
  if (hasBase) {
    if (eq(o, b)) return t;
    if (eq(t, b)) return o;
    clash(`${key} was changed differently on the two sides`);
  }
  return clash(`${key} differs and there is no common version to say which one changed`);
}

function earlierLater(key, o, t, pickEarlier) {
  if (eq(o, t)) return o;
  if (typeof o === 'string' && typeof t === 'string' && DATE_RE.test(o) && DATE_RE.test(t)) {
    return (o <= t) === pickEarlier ? o : t;
  }
  clash(`${key} is not a date on both sides`);
}

function mergeRelations(b, o, t, hasBase) {
  if (!isObj(o) || !isObj(t)) return scalar('relations', b, o, t, hasBase);
  const bb = isObj(b) ? b : {};
  const out = {};
  for (const k of [...Object.keys(o), ...Object.keys(t).filter((x) => !(x in o))]) {
    if (Array.isArray(o[k]) || Array.isArray(t[k])) {
      const list = mergeList(`relations.${k}`, bb[k], o[k], t[k], hasBase);
      if (list.length || o[k] !== undefined) out[k] = list;
    } else {
      const v = scalar(`relations.${k}`, bb[k], o[k], t[k], hasBase);
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

function mergeFrontmatter(B, O, T) {
  const hasBase = B !== null;
  const out = {};
  const keys = [...Object.keys(O), ...Object.keys(T).filter((k) => !(k in O))];
  for (const k of keys) {
    const b = B?.[k];
    const o = O[k];
    const t = T[k];
    let v;
    if (k === 'date_created') v = o === undefined ? t : t === undefined ? o : earlierLater(k, o, t, true);
    else if (k === 'date_modified') v = o === undefined ? t : t === undefined ? o : earlierLater(k, o, t, false);
    // Earlier of the two; a page one side never verified is not verified as a whole.
    else if (k === 'last_verified') v = o === undefined || t === undefined ? undefined : earlierLater(k, o, t, true);
    else if (k === 'sources') v = mergeSources(b, o, t, hasBase);
    else if (LIST_KEYS.includes(k)) {
      const list = mergeList(k, b, o, t, hasBase);
      v = list.length || o !== undefined ? list : undefined;
    } else if (k === 'relations') v = mergeRelations(b, o, t, hasBase);
    else v = scalar(k, b, o, t, hasBase);   // title, type, tier, origin, status, confidence, owner and any other key
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ── body ─────────────────────────────────────────────────────────────────────

const sameLines = (a, b) => a.length === b.length && a.every((l, i) => l === b[i]);
/** `short` is `long` with more whole lines after it, line for line. */
const isPrefix = (short, long) => short.length < long.length && short.every((l, i) => l === long[i]);

/** Run `git merge-file -p` on three texts. The merged text when it is clean, null when there is any conflict or it failed. */
function mergeFile(base, ours, theirs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-section-'));
  const [fo, fb, ft] = ['ours', 'base', 'theirs'].map((n) => path.join(dir, n));
  fs.writeFileSync(fo, ours);
  fs.writeFileSync(fb, base);
  fs.writeFileSync(ft, theirs);
  return new Promise((resolve) => {
    execFile('git', ['merge-file', '-p', fo, fb, ft], { env: childEnv(), maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve(err ? null : String(stdout));
    });
  });
}

const toText = (lines) => (lines.length ? `${lines.join('\n')}\n` : '');

async function mergeSection(b, o, t) {
  const [oc, tc] = [core(o.lines), core(t.lines)];
  const label = o.name || 'the start of the page';
  if (sameLines(oc, tc)) return o.lines;
  if (b) {
    const bc = core(b.lines);
    if (sameLines(oc, bc)) return t.lines;
    if (sameLines(tc, bc)) return o.lines;
    const text = await mergeFile(toText(bc), toText(oc), toText(tc));
    if (text === null) clash(`section “${label}” was changed on both sides in a way that does not merge line by line`);
    return text.split('\n').slice(0, -1);
  }
  // No common version: only a plain addition at the end is safe to take.
  if (isPrefix(oc, tc)) return t.lines;
  if (isPrefix(tc, oc)) return o.lines;
  return clash(`section “${label}” was written differently on the two sides`);
}

async function mergeBody(bBody, oBody, tBody) {
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
      if ((o.heading ?? '').trim() !== (t.heading ?? '').trim()) clash(`section “${o.name}” is spelled differently on the two sides`);
      lines = await mergeSection(b, o, t);
      heading = o.heading;
    } else {
      const only = o || t;
      if (b) {
        // Gone on one side: if the other side left it as it was, it stays gone.
        if (sameLines(core(only.lines), core(b.lines))) continue;
        clash(`section “${only.name}” was removed on one side and changed on the other`);
      }
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
 * Can `result` be read as an interleaving of a subsequence of `a` and a
 * subsequence of `b`? That is, can every line be attributed to one side so that
 * the lines attributed to a side keep that side's order? The states are the
 * (position in a, position in b) pairs that are still possible; only the
 * earliest ones matter, so the frontier stays as small as the shorter side.
 */
function interleaves(result, a, b) {
  let states = [[0, 0]];
  for (const line of result) {
    const next = [];
    for (const [i, j] of states) {
      const ai = a.indexOf(line, i);
      if (ai !== -1) next.push([ai + 1, j]);
      const bj = b.indexOf(line, j);
      if (bj !== -1) next.push([i, bj + 1]);
    }
    if (!next.length) return false;
    next.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    states = [];
    let bestJ = Infinity;
    for (const [i, j] of next) {
      if (j < bestJ) { states.push([i, j]); bestJ = j; }
    }
  }
  return true;
}

/**
 * Is `merged` made only of what was reviewed? Returns null when it is, else why not.
 *
 *   - every body line occurs in `ours` (main) or `theirs` (the reviewed head),
 *     and the lines that come from one side keep that side's order;
 *   - every frontmatter value occurs in one of the two;
 *   - with `base` (the common version), no list item that either side removed
 *     since the base is back.
 *
 * Blank lines carry no content and are not checked. The review gate calls this
 * from the three versions in git, so it does not depend on how a commit was made.
 */
export function pageProvenance(merged, ours, theirs, base = null) {
  const [m, o, t] = [parsePage(merged), parsePage(ours), parsePage(theirs)];
  if (!m) return 'the combined page has no readable frontmatter';
  if (!o || !t) return 'one of the two versions has no readable frontmatter';
  const lines = (body) => String(body).split('\n').filter((l) => !isBlank(l));
  const [ml, ol, tl] = [lines(m.body), lines(o.body), lines(t.body)];
  const seen = new Set([...ol, ...tl]);
  const extra = ml.find((l) => !seen.has(l));
  if (extra !== undefined) return `a line is in neither version: ${JSON.stringify(extra.slice(0, 80))}`;
  if (!interleaves(ml, ol, tl)) return 'the lines of one version are not in that version\'s order';
  const [lm, lo, lt] = [leaves(m.data), leaves(o.data), leaves(t.data)];
  const bad = [...lm].find((x) => !lo.has(x) && !lt.has(x));
  if (bad !== undefined) return `a frontmatter value is in neither version: ${bad.slice(0, 80)}`;
  if (base !== null && base !== undefined) {
    const b = parsePage(base);
    if (!b) return 'the common version has no readable frontmatter';
    const lb = leaves(b.data);
    const back = [...lm].find((x) => x.includes('[]=') && lb.has(x) && !(lo.has(x) && lt.has(x)));
    if (back !== undefined) return `a list item that was removed on one side since the common version is back: ${back.slice(0, 80)}`;
  }
  return null;
}

// ── the merge ────────────────────────────────────────────────────────────────

/**
 * @param {object} p
 * @param {string|null} p.base      the page at the merge base, null when there is none
 * @param {string} p.ours           the page on main
 * @param {string} p.theirs         the page at the reviewed head
 * @returns {Promise<{ ok: true, text: string } | { ok: false, reason: string }>}
 */
export async function mergePages({ base = null, ours, theirs }) {
  try {
    const [o, t] = [parsePage(ours), parsePage(theirs)];
    if (!o || !t) return { ok: false, reason: 'a version has no readable frontmatter' };
    const b = base === null || base === undefined ? null : parsePage(base);
    if (base !== null && base !== undefined && !b) return { ok: false, reason: 'the common version has no readable frontmatter' };

    const data = mergeFrontmatter(b?.data ?? null, o.data, t.data);
    const body = await mergeBody(b ? b.body : null, o.body, t.body);

    let text;
    if (eq(data, o.data) && bodyCore(body) === bodyCore(o.body)) text = ours;
    else if (eq(data, t.data) && bodyCore(body) === bodyCore(t.body)) text = theirs;
    else {
      const reuse = eq(data, o.data) ? o : eq(data, t.data) ? t : null;
      const fm = reuse ? reuse.matter.replace(/^\n/, '').replace(/\n+$/, '') : frontmatterText(data);
      text = `---\n${fm}\n---\n${body}`;
    }
    const why = pageProvenance(text, ours, theirs, base ?? null);
    if (why) return { ok: false, reason: why };
    return { ok: true, text };
  } catch (err) {
    if (err instanceof Clash) return { ok: false, reason: err.message };
    throw err;
  }
}
