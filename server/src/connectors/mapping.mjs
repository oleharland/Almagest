/**
 * mapping.mjs — the two tiny languages a recipe is written in.
 *
 *   paths      `issues[*].id`, `data.items[0].title`, `$`, `title | name`
 *   templates  `{{since}}`, `{{select.repo | after:/}}`, `{{item.ref}}`
 *
 * Both are interpreted, never compiled: no `eval`, no `Function`, no regex
 * built from a path. A recipe can read fields out of a tool result and nothing
 * else — it cannot call code, reach the environment, or walk a prototype
 * chain. That matters because recipes are where MCP servers we have never
 * seen get described, and some of those descriptions will be drafted by
 * `connectors init` from a server's own tool list.
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_PATH = 500;

// ── paths ────────────────────────────────────────────────────────────────────

/**
 * `a.b[0]["c d"][*].e` → [{key:'a'}, {key:'b'}, {index:0}, {key:'c d'}, {wild:true}, {key:'e'}].
 * A leading `$` (or `$.`) is the root and is optional.
 */
export function parsePath(path) {
  const src = String(path ?? '').trim();
  if (src.length > MAX_PATH) throw new Error(`path too long (${src.length} > ${MAX_PATH})`);
  const steps = [];
  let i = 0;
  if (src[0] === '$') i = 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '.') { i++; continue; }
    if (ch === '[') {
      const close = findClose(src, i);
      const inner = src.slice(i + 1, close).trim();
      if (inner === '*') steps.push({ wild: true });
      else if (/^-?\d+$/.test(inner)) steps.push({ index: Number(inner) });
      else if (/^(['"]).*\1$/.test(inner)) steps.push({ key: inner.slice(1, -1) });
      else throw new Error(`bad path segment [${inner}] in "${src}"`);
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < src.length && src[j] !== '.' && src[j] !== '[') j++;
    const key = src.slice(i, j).trim();
    if (key === '*') steps.push({ wild: true });
    else if (key) steps.push({ key });
    i = j;
  }
  return steps;
}

function findClose(src, open) {
  let quote = '';
  for (let k = open + 1; k < src.length; k++) {
    const c = src[k];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ']') return k;
  }
  throw new Error(`unclosed [ in path "${src}"`);
}

function stepInto(values, step) {
  const out = [];
  for (const v of values) {
    if (v == null) continue;
    if (step.wild) {
      if (Array.isArray(v)) out.push(...v);
      else if (typeof v === 'object') out.push(...Object.values(v));
      continue;
    }
    if (step.index !== undefined) {
      if (!Array.isArray(v)) continue;
      const idx = step.index < 0 ? v.length + step.index : step.index;
      if (idx >= 0 && idx < v.length) out.push(v[idx]);
      continue;
    }
    if (typeof v !== 'object' || FORBIDDEN_KEYS.has(step.key)) continue;
    if (Object.hasOwn(v, step.key)) out.push(v[step.key]);
  }
  return out;
}

const isEmpty = (v) => v === undefined || v === null || v === '';

/** Alternatives are separated by ` | ` — the first one that yields anything wins. */
function alternatives(path) {
  return String(path ?? '').split(/\s+\|\s+/).map((s) => s.trim()).filter((s) => s !== '');
}

/** Every value the path reaches. `[*]` fans out; a missing key yields nothing. */
export function selectAll(value, path) {
  const alts = alternatives(path);
  if (alts.length === 0) return [value];
  for (const alt of alts) {
    let values = [value];
    for (const step of parsePath(alt)) values = stepInto(values, step);
    values = values.filter((v) => !isEmpty(v));
    if (values.length) return values;
  }
  return [];
}

/** The first value the path reaches, or `undefined`. */
export function select(value, path) {
  return selectAll(value, path)[0];
}

// ── templates ────────────────────────────────────────────────────────────────

const TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const WHOLE_TEMPLATE_RE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

/**
 * Filters a template may apply, in order: `{{ select.repo | after:/ }}`.
 * Deliberately few and all pure string/array shaping.
 */
const FILTERS = {
  default: (v, arg) => (isEmpty(v) || (Array.isArray(v) && v.length === 0) ? coerceLiteral(arg) : v),
  before: (v, arg) => (v == null ? v : String(v).includes(arg) ? String(v).slice(0, String(v).indexOf(arg)) : String(v)),
  after: (v, arg) => (v == null ? v : String(v).includes(arg) ? String(v).slice(String(v).indexOf(arg) + arg.length) : ''),
  join: (v, arg = ',') => (Array.isArray(v) ? v.join(arg) : v),
  first: (v) => (Array.isArray(v) ? v[0] : v),
  lower: (v) => (v == null ? v : String(v).toLowerCase()),
  upper: (v) => (v == null ? v : String(v).toUpperCase()),
  urlencode: (v) => (v == null ? v : encodeURIComponent(String(v))),
  json: (v) => JSON.stringify(v ?? null),
  string: (v) => (v == null ? v : String(v)),
  number: (v) => (isEmpty(v) ? undefined : Number(v)),
  date: (v) => (isEmpty(v) ? v : String(v).slice(0, 10)),
  quote: (v) => (isEmpty(v) ? v : `'${String(v).replace(/'/g, "\\'")}'`),
  /** `{{raw.path | mime}}` — a mime type from a file extension, for `render: auto`. */
  mime: (v) => (isEmpty(v) ? v : MIME_BY_EXT[String(v).toLowerCase().split('.').pop()] || 'text/plain'),
  /** `{{raw.attrs | attr:id}}` — one `name="value"` attribute out of an XML-ish tag. */
  attr: (v, name) => {
    if (isEmpty(v) || !name) return undefined;
    const s = String(v);
    const needle = `${name}="`;
    let at = s.indexOf(needle);
    while (at > 0 && /[\w-]/.test(s[at - 1])) at = s.indexOf(needle, at + 1);
    if (at < 0) return undefined;
    const end = s.indexOf('"', at + needle.length);
    return end < 0 ? undefined : s.slice(at + needle.length, end);
  },
};

const MIME_BY_EXT = {
  md: 'text/markdown', markdown: 'text/markdown', mdx: 'text/markdown', txt: 'text/plain',
  json: 'application/json', csv: 'text/csv', tsv: 'text/csv', yaml: 'text/yaml', yml: 'text/yaml',
  html: 'text/html', htm: 'text/html', rst: 'text/plain', adoc: 'text/plain',
};

function coerceLiteral(arg) {
  if (arg === undefined) return '';
  if (arg === 'true') return true;
  if (arg === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(arg)) return Number(arg);
  return arg;
}

function evalExpr(expr, vars) {
  const [head, ...filters] = expr.split('|').map((s) => s.trim());
  let value = head.startsWith("'") && head.endsWith("'") ? head.slice(1, -1) : select(vars, head);
  for (const f of filters) {
    const colon = f.indexOf(':');
    const name = colon < 0 ? f : f.slice(0, colon);
    const arg = colon < 0 ? undefined : f.slice(colon + 1);
    const fn = FILTERS[name];
    if (!fn) throw new Error(`unknown template filter "${name}"`);
    value = fn(value, arg);
  }
  return value;
}

/**
 * A string that is exactly one `{{…}}` keeps the value's type (a list stays a
 * list, a number a number). Anything else is string interpolation, where an
 * empty value interpolates as ''.
 */
export function renderTemplate(template, vars) {
  if (typeof template !== 'string') return template;
  const whole = template.match(WHOLE_TEMPLATE_RE);
  if (whole) return evalExpr(whole[1], vars);
  return template.replace(TEMPLATE_RE, (_m, expr) => {
    const v = evalExpr(expr, vars);
    return isEmpty(v) ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

export function isTemplate(value) {
  return typeof value === 'string' && value.includes('{{');
}

/**
 * Tool arguments from a recipe's `args` block. A key whose value renders
 * empty is dropped, so `cursor: "{{cursor}}"` is simply absent on the first
 * page and `updatedAt: "{{since}}"` is absent on the first sync.
 */
export function renderArgs(args, vars) {
  if (Array.isArray(args)) {
    return args.map((a) => renderArgs(a, vars)).filter((a) => !isEmpty(a));
  }
  if (args && typeof args === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(args)) {
      const r = renderArgs(v, vars);
      if (isEmpty(r)) continue;
      if (Array.isArray(r) && r.length === 0 && Array.isArray(v) === false) continue;
      out[k] = r;
    }
    return out;
  }
  return renderTemplate(args, vars);
}

/** Every variable name a template tree mentions — used to tell a full listing from an incremental one. */
export function templateVars(tree) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(TEMPLATE_RE)) found.add(m[1].split('|')[0].trim());
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(tree);
  return found;
}

/** A mapping field is a template when it contains `{{`, otherwise a path into the item. */
export function mapField(spec, raw, vars) {
  if (spec === undefined || spec === null || spec === '') return undefined;
  if (isTemplate(spec)) return renderTemplate(spec, { ...vars, raw });
  return select(raw, spec);
}

// ── globs ────────────────────────────────────────────────────────────────────

/**
 * `**` crosses `/`, `*` and `?` do not. Built character by character with every
 * other character escaped, so a glob cannot smuggle regex syntax in.
 */
export function globToRegExp(glob) {
  let re = '^';
  const g = String(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$');
}

export function matchesGlob(value, globs) {
  const list = (Array.isArray(globs) ? globs : [globs]).filter((g) => !isEmpty(g));
  if (list.length === 0) return true;
  return list.some((g) => globToRegExp(g).test(String(value ?? '')));
}
