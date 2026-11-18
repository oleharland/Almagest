/**
 * web/layout.mjs — the inbox's page shell, stylesheet and response headers.
 *
 * The stylesheet is the shared library in ui/ (also used by the site) plus the
 * instance's site/src/styles/theme.css. It is inlined with a per-response CSP
 * nonce: no external stylesheet, no inline script without the nonce, nothing
 * a hostile page body could switch on. Fonts come from this service (fontRoutes).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { html, raw, safeUrl } from '../html.mjs';

// ── the stylesheet: the shared library, then the instance theme ─────────────
//
// The look comes from ui/ at the repo root (tokens.css, base.css, components.css),
// the same files the site imports. They are read once, when this module loads,
// and inlined under the response nonce. Fonts are served by the service itself
// (fontRoutes below), so no stylesheet or font request leaves the origin.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const UI_DIR = path.join(REPO, 'ui');
const THEME_FILE = path.join(REPO, 'site', 'src', 'styles', 'theme.css');

function readOr(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}

/** The two font files, by fixed name. Nothing from a request ever reaches the file system. */
const FONT_NAMES = ['GeistVariable.woff2', 'GeistMonoVariable.woff2'];
const fonts = FONT_NAMES.flatMap((name) => {
  try {
    const body = fs.readFileSync(path.join(UI_DIR, 'fonts', name));
    return [{ name, body, hash: crypto.createHash('sha256').update(body).digest('hex') }];
  } catch { return []; }
});
/** Part of every font path: new font files mean new URLs, so the long cache never serves a stale one. */
const FONT_VERSION = crypto.createHash('sha256').update(fonts.map((f) => f.hash).join('')).digest('hex').slice(0, 10);

/** Static font routes: [{ path, contentType, body, etag }]. Register each as an exact GET. */
export const fontRoutes = fonts.map((f) => ({
  path: `/inbox/fonts/${FONT_VERSION}/${f.name}`,
  contentType: 'font/woff2',
  body: f.body,
  etag: `"${f.hash.slice(0, 32)}"`,
}));

const fontUrl = (name) => `/inbox/fonts/${FONT_VERSION}/${name}`;

/** Library CSS with the @font-face urls pointed at the service's own font route. */
function libraryCss() {
  const css = ['tokens.css', 'base.css', 'components.css'].map((f) => readOr(path.join(UI_DIR, f))).join('\n');
  return css.replace(/url\((["']?)\.\/fonts\/([A-Za-z0-9-]+\.woff2)\1\)/g, (m, _q, name) => (FONT_NAMES.includes(name) ? `url("${fontUrl(name)}")` : m));
}

/**
 * The instance theme is applied as it is. Whatever it contains, it must not be
 * able to end the <style> element, so every "</style" is broken up.
 */
export function safeStyleText(css) {
  return String(css).replace(/<\/(style)/gi, '<\\/$1');
}

/**
 * Pages the service renders that are not written with library classes: the
 * sign-in pages in sessions.mjs. Kept to the few classes they use, built from
 * the same tokens, so they look like the rest.
 */
const SIGN_IN_CSS = `
.login{max-width:26rem;margin:var(--space-7) auto 0}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:var(--space-4)}
.lede{color:var(--content-secondary);font-size:var(--text-md);margin:var(--space-2) 0 var(--space-4)}
.faint{color:var(--content-tertiary);font-size:var(--text-sm)}
.flash{border:1px solid var(--border);border-left:3px solid var(--content-secondary);border-radius:var(--radius);background:var(--surface-secondary);padding:var(--space-3) var(--space-4);margin:0 0 var(--space-4)}
.flash--ok{border-left-color:var(--success);background:var(--success-soft)}
.flash--err{border-left-color:var(--danger);background:var(--danger-soft)}
input[type=password]{display:block;width:100%;min-height:var(--control-height);margin-top:var(--space-1);padding:0 var(--space-3);background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--radius)}
input[type=password]:focus-visible{outline:2px solid var(--focus-ring);border-color:var(--focus-ring)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:var(--control-height);padding:0 var(--space-4);font-weight:var(--weight-medium);color:var(--content);background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--radius);text-decoration:none;cursor:pointer}
.btn--primary{background:var(--accent);border-color:var(--accent);color:var(--accent-content)}
`;

/** The whole stylesheet: library, sign-in pages, then the instance's theme.css last, so a token redefined there wins. */
export function buildCss(theme = readOr(THEME_FILE)) {
  return safeStyleText(`${libraryCss()}\n${SIGN_IN_CSS}\n${theme}`);
}

export const CSS = buildCss();

/** Headers every inbox response carries. `nonce` lets exactly our own <style>/<script> run. */
export function securityHeaders(nonce) {
  return {
    'content-security-policy': [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      "img-src 'self' data:",
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  };
}

export const newNonce = () => crypto.randomBytes(16).toString('base64');

const NAV = [
  ['/inbox', 'To review', 'inbox'],
  ['/inbox/reverify', 'Re-check', 'reverify'],
  ['/inbox/gaps', 'Unanswered', 'gaps'],
  ['/inbox/canonical', 'Canonical', 'canonical'],
  ['/inbox/activity', 'Activity', 'activity'],
];

const SCRIPT = `
document.addEventListener('submit', function (e) {
  var f = e.target; var q = f.getAttribute('data-confirm');
  if (q && !window.confirm(q)) { e.preventDefault(); return; }
  var b = f.querySelector('button[type=submit],button:not([type])'); if (b) { setTimeout(function () { b.disabled = true; }, 0); }
});
`;

/**
 * @param {object} p
 * @param {string} p.title
 * @param {object} [p.actor]
 * @param {string} p.nonce
 * @param {string} [p.csrf]
 * @param {string} [p.current]  nav key
 * @param {object} [p.navCounts]  nav key → number shown beside the label when above zero
 * @param {'page'|'wide'|'measure'} [p.width]  the page's named width (ui/base.css): standard, review work, or prose
 * @param {*}      p.body       html``
 */
export function layout({ title, actor = null, nonce, csrf = '', current = '', body, footer = null, navCounts = {}, width = 'page' }) {
  const w = ['wide', 'measure'].includes(width) ? ` al-page--${width}` : '';
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title} · Almagest</title>
<style nonce="${nonce}">${raw(CSS)}</style>
</head>
<body>
<a class="al-skip-link" href="#main">Skip to content</a>
<header class="al-appbar"><div class="al-page${raw(w)} al-appbar__inner">
  <a class="al-appbar__brand" href="/inbox">Almagest<span class="al-appbar__brand-sub">Review</span></a>
  ${actor ? html`<nav class="al-appbar__nav" aria-label="Inbox">${NAV.map(([href, label, key]) => html`<a class="al-appbar__link" href="${safeUrl(href)}"${key === current ? raw(' aria-current="page"') : ''}>${label}${navCounts[key] > 0 ? ` (${navCounts[key]})` : ''}</a>`)}</nav>
  <div class="al-appbar__end"><span class="al-appbar__name">${actor.display}</span>
    <form method="post" action="/inbox/logout"><input type="hidden" name="csrf" value="${csrf}"><button class="al-btn al-btn--sm" type="submit">Sign out</button></form>
  </div>` : ''}
</div></header>
<main id="main" class="al-main al-page${raw(w)}"><div class="al-flow">${body}</div></main>
${footer || ''}
<script nonce="${nonce}">${raw(SCRIPT)}</script>
</body>
</html>`;
}

export function timeAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
