/**
 * channels/email.mjs — per-event mails and a digest, with links into the inbox.
 *
 * Config (`governance.channels[]`):
 *
 *   - kind: email
 *     from: "Almagest <almagest@acme.com>"
 *     transport: sendmail                  # sendmail | http
 *     sendmail_path: /usr/sbin/sendmail
 *     # transport: http                    # Resend/Postmark-style JSON API
 *     # http: { url: https://api.resend.com/emails, token_env: RESEND_API_KEY, style: resend }   # style: resend | postmark
 *     recipients:                          # people who get personal sign-in links
 *       - { email: ada@acme.com, id: usr_ada, display: Ada, roles: [owner], teams: [] }
 *     to: [team@acme.com]                  # plain notifications, link only
 *     events: [proposal.created, decision.created]
 *     link_ttl_hours: 72
 *     digest_every_hours: 24               # optional; or run `almagest inbox-digest` from cron
 *
 * Personal links are signed (HMAC) and single-use: opening one shows
 * "Continue as Ada", and pressing it signs Ada in once. Opening never acts on
 * its own — mail scanners prefetch links. With `require_sso_for_approval` a
 * link only leads to the sign-in page; the mail is never a credential.
 */
import { execFile } from 'node:child_process';

import { humanActor } from '../../core/auth.mjs';
import { html } from '../html.mjs';
import { redirect } from '../sessions.mjs';
import { sign, verify } from '../signing.mjs';
import { DECISION_WORDS, describe } from '../summary.mjs';
import { LIVE } from '../policy.mjs';
import { newNonce, securityHeaders } from '../web/layout.mjs';
import * as views from '../web/views.mjs';

const header = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

function encodeHeader(s) {
  const v = header(s);
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString('base64')}?=`;
}

/** An RFC 5322 message, text + HTML. Every header value is stripped of CR/LF — no injection. */
export function rfc822({ from, to, subject, text, html: body }) {
  const boundary = `almagest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return [
    `From: ${header(from)}`,
    `To: ${header(to)}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text).toString('base64').replace(/.{76}/g, '$&\n'),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body).toString('base64').replace(/.{76}/g, '$&\n'),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export function create(ctx, cfg, { governance, confirmations, sessions, secret }) {
  const { config, log, store } = ctx;
  const base = String(config.service.http.base_url).replace(/\/+$/, '');
  const requireSso = Boolean(config.governance.require_sso_for_approval);
  const events = cfg.events || ['proposal.created', 'decision.created'];
  const recipients = (cfg.recipients || []).filter((r) => r?.email);
  const plain = (cfg.to || []).filter((e) => !recipients.some((r) => r.email === e));
  const ttlMs = Number(cfg.link_ttl_hours || 72) * 3600 * 1000;
  const from = cfg.from || 'Almagest <almagest@localhost>';
  const sent = [];   // last messages, for `almagest doctor`-style inspection and tests

  async function send(msg) {
    const full = { from, ...msg };
    sent.push(full);
    if (sent.length > 50) sent.shift();
    if ((cfg.transport || 'sendmail') === 'http') {
      const h = cfg.http || {};
      if (!h.url) throw new Error('email channel: http.url is not set');
      const token = h.token_env ? process.env[h.token_env] || '' : '';
      const postmark = h.style === 'postmark';
      const body = postmark
        ? { From: full.from, To: full.to, Subject: header(full.subject), TextBody: full.text, HtmlBody: full.html, MessageStream: 'outbound' }
        : { from: full.from, to: [full.to], subject: header(full.subject), text: full.text, html: full.html };
      const headers = { 'content-type': 'application/json', accept: 'application/json', ...(postmark ? { 'x-postmark-server-token': token } : { authorization: `Bearer ${token}` }) };
      const res = await fetch(h.url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`mail API responded ${res.status}`);
      return;
    }
    await new Promise((resolve, reject) => {
      const child = execFile(cfg.sendmail_path || '/usr/sbin/sendmail', ['-t', '-i'], (err) => (err ? reject(err) : resolve()));
      child.stdin.end(rfc822(full));
    });
  }

  /** A personal, signed, single-use link — or a plain inbox link when sign-in must be SSO. */
  async function linkFor(recipient, target, proposalId) {
    if (requireSso || !recipient?.id) return `${base}${target}`;
    const { code } = await confirmations.create({
      proposalId, action: 'review', ttl: ttlMs, path: target,
      recipient: { id: recipient.id, display: recipient.display || recipient.email, email: recipient.email, roles: recipient.roles || ['viewer'], teams: recipient.teams || [] },
    });
    return `${base}/inbox/l/${sign(secret, 'email-link', { c: code, exp: Date.now() + ttlMs })}`;
  }

  function compose(event, p, decisions, link, extra = {}) {
    const info = describe(p, decisions);
    const subject = {
      'proposal.created': `To review: ${info.title}`,
      'decision.created': `A question needs you: ${DECISION_WORDS[extra.decision?.kind] || 'decision'}`,
      'proposal.merged': `Added: ${info.title}`,
      'proposal.rejected': `Turned down: ${info.title}`,
      'proposal.updated': `Revised: ${info.title}`,
    }[event] || info.title;
    const lead = event === 'decision.created' ? extra.decision?.question || info.line : info.sentence;
    const text = `${subject}\n\n${lead}.\n\nOpen it: ${link}\n\n— Almagest`;
    const body = String(html`<p><strong>${subject}</strong></p><p>${lead}.</p><p><a href="${link}">Open it in the review inbox</a></p><p style="color:#6b6862">— Almagest</p>`);
    return { subject, text, html: body };
  }

  async function notify(event, payload) {
    if (!events.includes(event) || !payload?.proposal) return;
    const p = payload.proposal;
    const decisions = await governance.listDecisions(p.id);
    const target = `/inbox/p/${encodeURIComponent(p.id)}`;
    for (const r of recipients) {
      await send({ to: r.email, ...compose(event, p, decisions, await linkFor(r, target, p.id), payload) });
    }
    for (const email of plain) {
      await send({ to: email, ...compose(event, p, decisions, `${base}${target}`, payload) });
    }
  }

  /** One mail per person listing everything still waiting. */
  async function digest() {
    const open = await store.proposals.list({ status: LIVE });
    if (open.length === 0) return 0;
    const lines = [];
    for (const p of open) {
      const d = await governance.listDecisions(p.id);
      lines.push({ p, info: describe(p, d) });
    }
    const subject = `${open.length} proposal${open.length === 1 ? '' : 's'} waiting for review`;
    let n = 0;
    for (const to of [...recipients, ...plain.map((email) => ({ email }))]) {
      const link = await linkFor(to.id ? to : null, '/inbox', open[0].id);
      const text = `${subject}\n\n${lines.map(({ info }) => `- ${info.title}: ${info.line}`).join('\n')}\n\nOpen the inbox: ${link}\n`;
      const body = String(html`<p><strong>${subject}</strong></p><ul>${lines.map(({ info }) => html`<li><strong>${info.title}</strong> — ${info.line}</li>`)}</ul><p><a href="${link}">Open the review inbox</a></p>`);
      await send({ to: to.email, subject, text, html: body });
      n++;
    }
    return n;
  }

  function routes(http) {
    const respond = (render, status = 200) => { const nonce = newNonce(); return { status, headers: securityHeaders(nonce), html: String(render(nonce)) }; };
    const gone = (state) => respond((nonce) => views.messagePage({
      title: 'Link not usable', nonce,
      text: state === 'used' ? 'This link has already been used. Sign in to open the inbox.' : 'This link has expired or is not valid. Sign in to open the inbox.',
      link: { href: '/inbox/login', label: 'Sign in' },
    }), state === 'unknown' ? 404 : 410);

    http.route('GET', '/inbox/l/:token', async (req, res, { params }) => {
      const v = verify(secret, 'email-link', params.token);
      if (!v?.c) return gone('expired');
      const rec = await confirmations.peek(v.c);
      if (rec.state !== 'ok' || !rec.recipient) return gone(rec.state);
      if (requireSso) { redirect(res, `/inbox/login?next=${encodeURIComponent(rec.target || '/inbox')}`); return undefined; }
      const csrf = sessions.csrfToken(req, res);
      return respond((nonce) => views.continueAsPage({ display: rec.recipient.display, code: params.token, csrf, nonce }));
    });

    http.route('POST', '/inbox/l/:token', async (req, res, { params, body }) => {
      if (!sessions.checkCsrf(req, body?.csrf)) return respond((nonce) => views.messagePage({ title: 'That form expired', text: 'Open the link from the email again.', nonce }), 403);
      const v = verify(secret, 'email-link', params.token);
      if (!v?.c) return gone('expired');
      let rec;
      try { rec = await confirmations.consume(v.c); } catch (err) { return gone(err.state || 'unknown'); }
      if (!rec.recipient) return gone('unknown');
      if (requireSso) { redirect(res, `/inbox/login?next=${encodeURIComponent(rec.target || '/inbox')}`); return undefined; }
      const actor = humanActor({ ...rec.recipient });
      await sessions.issue(res, actor, 'email-link');
      redirect(res, rec.target || '/inbox');
      return undefined;
    });
  }

  if (cfg.digest_every_hours) {
    const timer = setInterval(() => digest().catch((err) => log.warn('email digest failed', { error: err.message })), Number(cfg.digest_every_hours) * 3600 * 1000);
    timer.unref?.();
  }

  return { kind: 'email', canApprove: false, notify, routes, digest, send, sent };
}
