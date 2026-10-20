/**
 * web/layout.mjs — the inbox's page shell, stylesheet and response headers.
 *
 * The stylesheet reuses the site's design tokens (site/src/styles/base.css)
 * so the inbox looks like part of the same product, and is inlined with a
 * per-response CSP nonce: no external requests, no inline script without the
 * nonce, nothing a hostile page body could switch on.
 */
import crypto from 'node:crypto';

import { html, raw, safeUrl } from '../html.mjs';

export const CSS = `
:root{--font-sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
--bg:#fbfbfa;--bg-raised:#fff;--bg-sunken:#f2f2f0;--border:#e2e1dd;--border-strong:#c9c7c1;--text:#1c1b19;--text-muted:#6b6862;--text-faint:#94918a;
--accent:#6b4ee6;--accent-soft:#efeafe;--danger:#b4472e;--danger-soft:#fbeae6;--ok:#2f7d4f;--ok-soft:#e6f4ea;--warn:#9a6700;--warn-soft:#fbf1d9;
--tier-canonical:#b4472e;--tier-curated:#6b4ee6;--tier-evidence:#6b6862;--radius:7px}
@media (prefers-color-scheme:dark){:root{--bg:#17171a;--bg-raised:#1e1e22;--bg-sunken:#121214;--border:#2e2e34;--border-strong:#45454e;--text:#e9e8e4;--text-muted:#9d9a94;--text-faint:#6f6d68;
--accent:#a794ff;--accent-soft:#272040;--danger:#e8836a;--danger-soft:#3a211a;--ok:#6fcf97;--ok-soft:#17301f;--warn:#e3b341;--warn-soft:#352a10;
--tier-canonical:#e8836a;--tier-curated:#a794ff;--tier-evidence:#9d9a94}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-sans);font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-underline-offset:2px}
.wrap{max-width:920px;margin:0 auto;padding:0 1rem}
header.top{background:var(--bg-raised);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:5}
header.top .wrap{display:flex;align-items:center;gap:.75rem 1.25rem;min-height:56px;flex-wrap:wrap}
.brand{font-weight:650;color:var(--text);text-decoration:none;letter-spacing:-.01em}
.brand span{color:var(--text-faint);font-weight:500;margin-left:.35rem}
nav.main{display:flex;gap:1rem;flex-wrap:wrap;font-size:.9rem}
nav.main a{color:var(--text-muted);text-decoration:none;padding:.25rem 0}
nav.main a[aria-current=page]{color:var(--text);font-weight:600;box-shadow:inset 0 -2px 0 var(--accent)}
.who{margin-left:auto;display:flex;align-items:center;gap:.5rem;font-size:.85rem;color:var(--text-muted)}
main{padding:1.5rem 0 5rem}
h1{font-size:1.55rem;line-height:1.25;letter-spacing:-.02em;margin:.25rem 0 .5rem}
h2{font-size:1.1rem;margin:2rem 0 .75rem}
h3{font-size:1rem;margin:0}
.lede{color:var(--text-muted);margin:0 0 1.25rem}
.muted{color:var(--text-muted)}.faint{color:var(--text-faint);font-size:.85rem}
.card{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.1rem;margin:0 0 .85rem}
.queue{list-style:none;margin:0;padding:0}
.queue li{margin:0 0 .75rem}
.queue a.item{display:block;text-decoration:none;color:inherit;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius);padding:.9rem 1.1rem}
.queue a.item:hover,.queue a.item:focus{border-color:var(--border-strong);background:var(--bg-sunken)}
.item .title{font-weight:600;font-size:1.02rem}
.item .line{color:var(--text-muted);font-size:.92rem;margin:.15rem 0 .45rem}
.chips{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center}
.chip{display:inline-block;font-size:.75rem;font-weight:600;padding:.12em .55em;border-radius:999px;border:1px solid var(--border-strong);color:var(--text-muted);background:var(--bg-raised);white-space:nowrap}
.chip--warn{color:var(--warn);background:var(--warn-soft);border-color:transparent}
.chip--hot{color:var(--accent);background:var(--accent-soft);border-color:transparent}
.chip--ok{color:var(--ok);background:var(--ok-soft);border-color:transparent}
.chip--bad{color:var(--danger);background:var(--danger-soft);border-color:transparent}
.tabs{display:flex;gap:.5rem;flex-wrap:wrap;margin:0 0 1rem;align-items:center}
.tabs a{font-size:.88rem;text-decoration:none;color:var(--text-muted);border:1px solid var(--border);border-radius:999px;padding:.25rem .75rem;background:var(--bg-raised)}
.tabs a[aria-current=true]{color:var(--text);border-color:var(--text);font-weight:600}
.search{flex:1 1 200px;display:flex;gap:.4rem}
input[type=search],input[type=password],input[type=text],textarea{width:100%;font:inherit;font-size:.95rem;color:var(--text);background:var(--bg-raised);border:1px solid var(--border-strong);border-radius:var(--radius);padding:.55rem .7rem}
textarea{min-height:5.5rem;resize:vertical}
input:focus,textarea:focus,button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;min-height:44px;padding:.55rem 1rem;font:inherit;font-weight:600;font-size:.95rem;border-radius:var(--radius);border:1px solid var(--border-strong);background:var(--bg-raised);color:var(--text);cursor:pointer;text-decoration:none}
.btn:hover{border-color:var(--text-muted)}
.btn--primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn--primary:hover{filter:brightness(1.07);border-color:var(--accent)}
.btn--danger{color:var(--danger);border-color:var(--danger)}
.btn--small{min-height:36px;padding:.3rem .75rem;font-size:.85rem}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.flash{border-radius:var(--radius);padding:.7rem .9rem;margin:0 0 1rem;font-size:.95rem}
.flash--ok{background:var(--ok-soft);color:var(--text);border:1px solid var(--ok)}
.flash--err{background:var(--danger-soft);color:var(--text);border:1px solid var(--danger)}
.status{font-size:.95rem;margin:0 0 1rem}
.needs{background:var(--bg-sunken);border:1px solid var(--border);border-radius:var(--radius);padding:.85rem 1rem;margin:0 0 1rem}
.needs h2{margin:0 0 .35rem;font-size:.95rem}
.needs ul{margin:.25rem 0 0;padding-left:1.2rem}
.needs.ready{background:var(--ok-soft);border-color:var(--ok)}
.page{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-raised);margin:0 0 1rem;overflow:hidden}
.page > .head{display:flex;gap:.5rem 1rem;flex-wrap:wrap;align-items:center;padding:.85rem 1.1rem;border-bottom:1px solid var(--border)}
.page > .head .grow{flex:1 1 220px;min-width:0}
.page > .body{padding:.85rem 1.1rem}
.page.rejected{opacity:.6}
.claim{border-left:3px solid var(--border-strong);padding:.15rem 0 .15rem .85rem;margin:0 0 1.1rem}
.claim:last-child{margin-bottom:0}
.claim .op{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.claim--add{border-color:var(--ok)}.claim--add .op{color:var(--ok)}
.claim--change{border-color:var(--warn)}.claim--change .op{color:var(--warn)}
.claim--remove{border-color:var(--danger)}.claim--remove .op{color:var(--danger)}
.claim .text{margin:.15rem 0 .35rem;overflow-wrap:anywhere}
.claim--remove .text{text-decoration:line-through;text-decoration-color:var(--danger)}
.claim .was{color:var(--text-muted);font-size:.9rem;margin:0 0 .35rem;overflow-wrap:anywhere}
.claim .was del{text-decoration-color:var(--warn)}
.excerpt{margin:.35rem 0 0;padding:.55rem .8rem;background:var(--bg-sunken);border-radius:0 var(--radius) var(--radius) 0;border-left:2px solid var(--border-strong);font-size:.9rem;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text)}
.cite{font-size:.8rem;color:var(--text-muted);margin-top:.3rem}
.cite strong{color:var(--text);font-weight:600}
.missing{font-size:.88rem;color:var(--warn)}
.decision{border:1px solid var(--warn);background:var(--warn-soft);border-radius:var(--radius);padding:.9rem 1.1rem;margin:0 0 1rem}
.decision h3{margin:0 0 .35rem}
.decision .vs{display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin:.6rem 0}
.decision .vs > div{background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius);padding:.55rem .7rem;font-size:.9rem;overflow-wrap:anywhere}
.decision .options{display:flex;flex-direction:column;gap:.45rem;margin-top:.6rem}
.decision .options .btn{justify-content:flex-start;text-align:left;width:100%}
.decision.resolved{border-color:var(--border);background:var(--bg-raised)}
.actions{border-top:1px solid var(--border);margin-top:1.5rem;padding-top:1rem}
.actionbar{position:sticky;bottom:0;background:var(--bg-raised);border-top:1px solid var(--border);padding:.65rem 0;margin-top:1.25rem;z-index:4}
.actionbar .wrap{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.actionbar .msg{flex:1 1 200px;font-size:.88rem;color:var(--text-muted)}
details{margin:.5rem 0}
summary{cursor:pointer;color:var(--text-muted);font-size:.9rem}
dl.facts{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem;font-size:.85rem;margin:.5rem 0}
dl.facts dt{color:var(--text-faint)}dl.facts dd{margin:0;font-family:var(--font-mono);overflow-wrap:anywhere}
.empty{padding:2rem 1rem;text-align:center;border:1px dashed var(--border-strong);border-radius:var(--radius);color:var(--text-muted)}
table.list{width:100%;border-collapse:collapse;font-size:.92rem}
table.list td,table.list th{border-bottom:1px solid var(--border);padding:.5rem .4rem;text-align:left;vertical-align:top}
table.list th{color:var(--text-faint);font-weight:600;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
.login{max-width:420px;margin:2.5rem auto}
.code{font-family:var(--font-mono);font-size:1.1rem;letter-spacing:.08em}
@media (max-width:640px){h1{font-size:1.3rem}.decision .vs{grid-template-columns:1fr}.who .name{display:none}main{padding-top:1rem}}
`;

/** Headers every inbox response carries. `nonce` lets exactly our own <style>/<script> run. */
export function securityHeaders(nonce) {
  return {
    'content-security-policy': [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      "img-src 'self' data:",
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
 * @param {*}      p.body       html``
 */
export function layout({ title, actor = null, nonce, csrf = '', current = '', body, footer = null }) {
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
<header class="top"><div class="wrap">
  <a class="brand" href="/inbox">Almagest<span>Review</span></a>
  ${actor ? html`<nav class="main" aria-label="Inbox">${NAV.map(([href, label, key]) => html`<a href="${safeUrl(href)}"${key === current ? raw(' aria-current="page"') : ''}>${label}</a>`)}</nav>
  <div class="who"><span class="name">${actor.display}</span>
    <form method="post" action="/inbox/logout"><input type="hidden" name="csrf" value="${csrf}"><button class="btn btn--small" type="submit">Sign out</button></form>
  </div>` : ''}
</div></header>
<main><div class="wrap">${body}</div></main>
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
