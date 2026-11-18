/**
 * bookkeeping.mjs — merging the knowledge base's own records when two
 * proposals both touched them.
 *
 * Every ingest appends to brain/log.md, adds rows to brain/index.md and an
 * entry to brain/manifest.yaml. Two proposals made from the same main
 * therefore always "conflict" on those files, though nothing actually
 * disagrees. These functions resolve exactly that case and nothing more:
 *
 *   mergeManifest(base, ours, theirs)
 *       a structured 3-way merge of `sources[]` by `id`: entries added on
 *       either side are kept, an entry changed on one side takes that change,
 *       the same id changed differently on both sides is a real conflict
 *       (null). Output is block-style YAML, whatever style the input used.
 *
 *   stripRemovedPlaceholders(base, ours, theirs)
 *       template rows like `| _(no actions yet)_ | | |` that either side
 *       replaced with real rows are dropped from all three versions, so the
 *       remaining change on each side is a pure insertion that a line union
 *       can merge. Placeholders nobody touched stay.
 *
 * Pure; merge.mjs does the git side.
 */
import YAML from 'yaml';

/** A table row that only holds a placeholder: `_(no …)_`, `(none)`, or all-empty cells. */
export function isPlaceholderRow(line) {
  const t = String(line).trim();
  if (!t.startsWith('|')) return false;
  const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  if (cells.every((c) => c === '')) return true;
  if (/^-{2,}$/.test((cells[0] || '').replace(/[:\s]/g, '-'))) return false;   // separator
  return /^_?\(?\s*(no|none)\b/i.test((cells[0] || '').replace(/[*`]/g, '').replace(/^_/, '')) && cells.slice(1).every((c) => c === '');
}

export function stripRemovedPlaceholders(base, ours, theirs) {
  const lines = (s) => String(s ?? '').split('\n');
  const o = new Set(lines(ours));
  const t = new Set(lines(theirs));
  const removed = new Set(lines(base).filter((l) => isPlaceholderRow(l) && (!o.has(l) || !t.has(l))));
  if (removed.size === 0) return [base, ours, theirs];
  const strip = (s) => (s === null || s === undefined ? s : lines(s).filter((l) => !removed.has(l)).join('\n'));
  return [strip(base), strip(ours), strip(theirs)];
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function leadingComments(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (line.startsWith('#') || line.trim() === '') out.push(line);
    else break;
  }
  return out.join('\n').replace(/\n+$/, '');
}

/** One field or entry: merged value, or the CONFLICT marker. */
const CONFLICT = Symbol('conflict');
function pick(b, o, t) {
  if (same(o, t)) return o;
  if (same(o, b)) return t;
  if (same(t, b)) return o;
  return CONFLICT;
}

/**
 * @returns {string | null} merged manifest text, or null when a person has to decide
 */
export function mergeManifest(baseText, oursText, theirsText) {
  let B;
  let O;
  let T;
  try {
    B = baseText ? YAML.parse(baseText) || {} : {};
    O = YAML.parse(oursText) || {};
    T = YAML.parse(theirsText) || {};
  } catch {
    return null;
  }
  for (const doc of [B, O, T]) {
    if (typeof doc !== 'object' || Array.isArray(doc)) return null;
    if (doc.sources !== undefined && !Array.isArray(doc.sources)) return null;
  }

  const out = {};
  const keys = [...new Set([...Object.keys(O), ...Object.keys(T), ...Object.keys(B)])];
  for (const key of keys) {
    if (key === 'sources') continue;
    const v = pick(B[key], O[key], T[key]);
    if (v === CONFLICT) return null;
    if (v !== undefined) out[key] = v;
  }

  const byId = (list = []) => {
    const m = new Map();
    for (const e of list) {
      if (!e || typeof e !== 'object' || !e.id) return null;   // an entry without an id cannot be matched up
      if (m.has(String(e.id))) return null;
      m.set(String(e.id), e);
    }
    return m;
  };
  const b = byId(B.sources);
  const o = byId(O.sources);
  const t = byId(T.sources);
  if (!b || !o || !t) return null;

  const sources = [];
  const order = [...o.keys(), ...[...t.keys()].filter((id) => !o.has(id))];
  for (const id of order) {
    const v = pick(b.get(id), o.get(id), t.get(id));
    if (v === CONFLICT) return null;
    if (v !== undefined) sources.push(v);
  }
  // An id both sides deleted is in neither list and stays deleted; a deletion on
  // one side against an edit on the other was caught by pick() as a conflict.
  out.sources = sources;

  const ordered = {};
  for (const key of ['version', ...Object.keys(out)]) if (key in out && !(key in ordered)) ordered[key] = out[key];
  const head = leadingComments(oursText);
  const body = YAML.stringify(ordered, { lineWidth: 0, collectionStyle: 'block' });
  return `${head ? `${head}\n\n` : ''}${body}`;
}
