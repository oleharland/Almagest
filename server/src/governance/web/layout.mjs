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
 * The whole stylesheet: the library, then the instance's theme.css last, so a
 * token redefined there wins.
 */
export function buildCss(theme = readOr(THEME_FILE)) {
  return safeStyleText(`${libraryCss()}\n${theme}`);
}

/**
 * The instance theme lives in the brain's repository. In a Docker deployment
 * that is a separate clone from this code, so the service tells the layout its
 * repository root once, at start; the theme is read there, once. A root with no
 * theme file falls back to the one next to this code.
 */
const themed = new Map();
let currentCss = buildCss();
export function useThemeFrom(repoRoot) {
  if (!repoRoot) return currentCss;
  const root = path.resolve(String(repoRoot));
  if (!themed.has(root)) {
    const file = path.join(root, 'site', 'src', 'styles', 'theme.css');
    themed.set(root, fs.existsSync(file) ? buildCss(readOr(file)) : buildCss());
  }
  currentCss = themed.get(root);
  return currentCss;
}

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

/**
 * The one script. The pages work without it; this adds comfort only:
 * confirm and double-submit guards on forms (every page), and on the review
 * page keys for moving between facts and pages, and the current rail entry.
 * No key here ever accepts, takes out, approves or turns down anything.
 */
const SCRIPT = `
(function () {
  var doc = document;
  doc.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.getAttribute('method') === 'dialog') { return; }
    var q = f.getAttribute('data-confirm');
    if (q && !window.confirm(q)) { e.preventDefault(); return; }
    var b = f.querySelector('button[type=submit],button:not([type])'); if (b) { setTimeout(function () { b.disabled = true; }, 0); }
  });

  var review = doc.querySelector('.al-review');
  if (!review) { return; }
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var list = function (sel) { return Array.prototype.slice.call(doc.querySelectorAll(sel)); };

  // A link to a folded file opens it.
  function openTarget(id) {
    var t = id && doc.getElementById(id);
    if (t && t.tagName === 'DETAILS') { t.open = true; }
  }
  doc.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (a) { openTarget(a.getAttribute('href').slice(1)); }
  });
  openTarget(decodeURIComponent(location.hash.slice(1)));

  // Menus close on Escape and on a click anywhere else.
  function closeMenus(except) {
    list('details.al-menu[open]').forEach(function (m) { if (m !== except) { m.open = false; } });
  }
  doc.addEventListener('click', function (e) { closeMenus(e.target.closest && e.target.closest('details.al-menu')); });

  // Where is the top of the readable area? Each target says, with scroll-margin-top.
  function margin(el) { return parseFloat(getComputedStyle(el).scrollMarginTop) || 0; }
  function index(els) {
    var at = -1;
    for (var i = 0; i < els.length; i++) {
      if (els[i].getBoundingClientRect().top - margin(els[i]) <= 4) { at = i; } else { break; }
    }
    return at;
  }
  function go(els, dir) {
    if (!els.length) { return; }
    var next = Math.max(0, Math.min(els.length - 1, index(els) + dir));
    var el = els[next];
    if (!el.hasAttribute('tabindex')) { el.setAttribute('tabindex', '-1'); }
    el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
  }

  var keys = doc.getElementById('keys');
  doc.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) { return; }
    var t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName) || t.isContentEditable)) { return; }
    if (keys && keys.open) { return; }
    var k = e.key;
    if (k === 'j' || k === 'k') { go(list('[data-fact], .al-diff__hunk'), k === 'j' ? 1 : -1); e.preventDefault(); }
    else if (k === 'n' || k === 'p') { go(list('[data-page]'), k === 'n' ? 1 : -1); e.preventDefault(); }
    else if (k === 'v') {
      var pages = list('[data-page]'); var cur = pages[Math.max(0, index(pages))];
      var other = cur && cur.querySelector('a[data-view][aria-current="false"]');
      if (other) { location.href = other.href; e.preventDefault(); }
    }
    else if (k === '?' && keys && keys.showModal) { keys.showModal(); e.preventDefault(); }
  });
  doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeMenus(null); } });

  // The current entry in the contents.
  var links = list('a[data-rail]');
  var targets = links.map(function (a) { return doc.getElementById(a.getAttribute('href').slice(1)); });
  var queued = false;
  function mark() {
    queued = false;
    var live = [];
    targets.forEach(function (t, i) { if (t && t.getClientRects().length) { live.push(i); } });
    var at = -1;
    live.forEach(function (i) { if (targets[i].getBoundingClientRect().top - margin(targets[i]) <= 48) { at = i; } });
    if (at < 0 && live.length) { at = live[0]; }
    links.forEach(function (a, i) { if (i === at) { a.setAttribute('aria-current', 'location'); } else { a.removeAttribute('aria-current'); } });
    if (at >= 0 && links[at].scrollIntoView && !reduce) { links[at].scrollIntoView({ block: 'nearest' }); }
  }
  window.addEventListener('scroll', function () { if (!queued) { queued = true; window.requestAnimationFrame(mark); } }, { passive: true });
  mark();
}());
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
<style nonce="${nonce}">${raw(currentCss)}</style>
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
