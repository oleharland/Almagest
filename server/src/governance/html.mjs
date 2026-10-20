/**
 * html.mjs — server-rendered HTML that escapes by default.
 *
 *   html`<p>${userText}</p>`          → userText is escaped
 *   html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`   → nested html is kept
 *   raw('<b>trusted</b>')             → the only way to skip escaping
 *
 * Everything the inbox shows comes from pages an agent wrote out of untrusted
 * source material, so the safe path has to be the short one. There is no
 * template engine and no "safe" flag on strings: a value is either the result
 * of `html` / `raw`, or it is escaped.
 */
const SAFE = Symbol('almagest.safeHtml');

class SafeHtml {
  constructor(value) {
    this.value = value;
    this[SAFE] = true;
  }
  toString() { return this.value; }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"'`]/g, (c) => ESCAPES[c]);
}

/** Marks a string as already-safe HTML. Use only for markup this file's callers wrote themselves. */
export function raw(value) {
  return new SafeHtml(String(value ?? ''));
}

export function isSafe(value) {
  return Boolean(value && value[SAFE]);
}

function render(value) {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (isSafe(value)) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/**
 * An href that cannot carry `javascript:` or a protocol-relative jump. Internal
 * paths pass; absolute URLs pass only when http(s).
 */
export function safeUrl(url) {
  const s = String(url ?? '').trim();
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  try {
    const u = new URL(s);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.toString();
  } catch { /* fall through */ }
  return '#';
}

/** A local redirect target from a `next` parameter — never an open redirect. */
export function safeNext(next, fallback = '/inbox') {
  const s = String(next ?? '');
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\') || /[\r\n]/.test(s)) return fallback;
  return s;
}
