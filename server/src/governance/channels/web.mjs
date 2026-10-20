/**
 * channels/web.mjs — the review inbox and its JSON mirror. Always on.
 *
 *   GET  /inbox                          the queue: open questions first, then frequently-read pages, then oldest
 *   GET  /inbox/p/:id                    one proposal: facts next to their sources, questions, what's still needed
 *   POST /inbox/p/:id/approve            (+ /reject /request-changes /retry /page/:slug/accept /page/:slug/reject)
 *   POST /inbox/d/:id/resolve            answer a question
 *   GET  /inbox/reverify  /inbox/gaps  /inbox/activity
 *   GET|POST /inbox/confirm/:code        a chat's approval request, confirmed by a signed-in person
 *
 *   GET  /api/proposals  /api/proposals/:id                         any authenticated actor
 *   POST /api/proposals/:id/{approve,reject,request-changes,retry}  humans only
 *   POST /api/proposals/:id/pages/:slug/reject  /api/decisions/:id/resolve
 *   POST /api/proposals/:id/confirmations                          any actor (chat asks for a link)
 *
 * Browser POSTs need the CSRF token; API POSTs authenticated by a session
 * cookie need it too (header `x-almagest-csrf`). Bearer-token callers carry
 * no ambient credential, so they don't.
 */
import { HttpError } from '../../core/http.mjs';
import { safeNext } from '../html.mjs';
import { assertMayApprove } from '../policy.mjs';
import { describe } from '../summary.mjs';
import { redirect } from '../sessions.mjs';
import { newNonce, securityHeaders } from '../web/layout.mjs';
import * as views from '../web/views.mjs';

const ACTIVE = ['open', 'approved', 'conflicted', 'changes_requested'];
const DONE = ['merged', 'rejected', 'superseded'];

export function create(ctx, cfg, { governance, sessions, confirmations }) {
  const { store, log } = ctx;

  function respond(req, res, render, { status = 200 } = {}) {
    const nonce = newNonce();
    return { status, headers: securityHeaders(nonce), html: String(render(nonce)) };
  }

  /** Human with a browser (or bearer) identity; anyone else is sent to sign in. */
  function requireHuman(req, res, actor, url) {
    if (actor?.kind === 'human') return true;
    if (actor) {
      res.statusCode = 403;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('The review inbox is for people. Agents use the API or the MCP tools.');
      return false;
    }
    redirect(res, `/inbox/login?next=${encodeURIComponent(safeNext(url.pathname + url.search))}`);
    return false;
  }

  /** Inbox forms act only for a signed-in browser session — never for a bearer token. */
  function notBrowser(req, res) {
    return respond(req, res, (nonce) => views.messagePage({ title: 'Sign in first', text: 'Inbox buttons work only in a signed-in browser. Scripts use the /api endpoints.', nonce, link: { href: '/inbox/login', label: 'Sign in' } }), { status: 403 });
  }

  /** "Why is this page hot?" from telemetry, best effort. */
  async function hotReasons(p) {
    const out = {};
    for (const c of (p.changes || []).filter((x) => x.hot)) {
      try {
        const e = await ctx.telemetry?.explain?.(c.slug);
        if (e) out[c.slug] = e;
      } catch { /* telemetry down: the badge still shows, without the why */ }
    }
    return out;
  }

  function canActOn(p, actor) {
    try {
      assertMayApprove(p, actor, { ...governance.options, scope: 'all', channel: 'web' });
      return { ok: true, why: '' };
    } catch (err) {
      return { ok: false, why: err.message };
    }
  }

  async function queueItems(filters) {
    const status = filters.show === 'done' ? DONE : filters.show === 'all' ? undefined : ACTIVE;
    const proposals = await store.proposals.list(status ? { status } : {});
    const items = [];
    for (const p of proposals) {
      const decisions = await store.decisions.listByProposal(p.id);
      const info = describe(p, decisions);
      if (filters.questions && !info.openDecisions) continue;
      if (filters.hot && !info.hot) continue;
      if (filters.q) {
        const hay = `${info.title} ${info.line} ${p.source?.id || ''} ${(p.changes || []).map((c) => `${c.slug} ${c.title}`).join(' ')}`.toLowerCase();
        if (!hay.includes(filters.q.toLowerCase())) continue;
      }
      items.push({ proposal: p, info });
    }
    items.sort((a, b) =>
      (b.info.openDecisions > 0) - (a.info.openDecisions > 0)
      || (b.info.hot > 0) - (a.info.hot > 0)
      || (filters.show === 'done' ? String(b.proposal.updatedAt).localeCompare(String(a.proposal.updatedAt)) : String(a.proposal.createdAt).localeCompare(String(b.proposal.createdAt))));
    return items;
  }

  async function renderProposal(req, res, actor, id, { flash = null, status = 200 } = {}) {
    const csrf = sessions.csrfToken(req, res, actor);
    const ev = await governance.evaluate(id).catch((err) => { if (err.status === 404) return null; throw err; });
    if (!ev) {
      return respond(req, res, (nonce) => views.messagePage({ title: 'Not found', text: 'There is no proposal with that link.', actor, csrf, nonce, link: { href: '/inbox', label: 'Back to the inbox' } }), { status: 404 });
    }
    const why = await hotReasons(ev.proposal);
    return respond(req, res, (nonce) => views.proposalPage({
      proposal: ev.proposal, decisions: ev.decisions, evaluation: ev.evaluation,
      actor, csrf, nonce, canAct: canActOn(ev.proposal, actor), flash, why,
    }), { status });
  }

  /**
   * Run an inbox POST: CSRF, then the action; success → 303 back with a
   * fixed message key (never reflected text), failure → the page re-rendered
   * with the error.
   */
  async function post(req, res, { actor, body, url }, backTo, fn, message) {
    if (!requireHuman(req, res, actor, url)) return undefined;
    if (!actor.session) return notBrowser(req, res);
    if (!sessions.checkCsrf(req, body?.csrf, actor)) {
      return respond(req, res, (nonce) => views.messagePage({ title: 'That form expired', text: 'Go back, reload the page and try again.', nonce, link: { href: backTo, label: 'Back' } }), { status: 403 });
    }
    try {
      const out = await fn();
      const key = typeof message === 'function' ? message(out) : message;
      redirect(res, `${backTo}${backTo.includes('?') ? '&' : '?'}m=${encodeURIComponent(key)}`);
      return undefined;
    } catch (err) {
      if ((err.status || 500) >= 500) log.error('inbox action failed', { path: url.pathname, error: err.stack || err.message });
      const id = backTo.match(/^\/inbox\/p\/([^/?#]+)/)?.[1];
      if (id) {
        return renderProposal(req, res, actor, decodeURIComponent(id), { flash: { error: true, text: err.status && err.status < 500 ? err.message : 'Something went wrong. Nothing was changed.' }, status: err.status || 500 });
      }
      return respond(req, res, (nonce) => views.messagePage({ title: "That didn't work", text: err.status && err.status < 500 ? err.message : 'Something went wrong.', nonce, link: { href: '/inbox', label: 'Back to the inbox' } }), { status: err.status || 500 });
    }
  }

  const flashFrom = (query) => (query.m && views.MESSAGES[query.m] ? { text: views.MESSAGES[query.m] } : null);
  const mergedOr = (key) => (p) => (p?.status === 'merged' ? 'merged' : key);

  function routes(http) {
    http.route('GET', '/inbox', async (req, res, { actor, query, url }) => {
      if (!requireHuman(req, res, actor, url)) return undefined;
      const filters = {
        show: ['active', 'done', 'all'].includes(query.show) ? query.show : 'active',
        q: String(query.q || '').slice(0, 200),
        questions: query.questions === '1',
        hot: query.hot === '1',
      };
      const items = await queueItems(filters);
      const csrf = sessions.csrfToken(req, res, actor);
      return respond(req, res, (nonce) => views.queuePage({ items, filters, actor, csrf, nonce, flash: flashFrom(query) }));
    });

    http.route('GET', '/inbox/p/:id', async (req, res, { actor, params, query, url }) => {
      if (!requireHuman(req, res, actor, url)) return undefined;
      return renderProposal(req, res, actor, params.id, { flash: flashFrom(query) });
    });

    const back = (id) => `/inbox/p/${encodeURIComponent(id)}`;
    http.route('POST', '/inbox/p/:id/approve', (req, res, a) =>
      post(req, res, a, back(a.params.id), () => governance.approve(a.params.id, a.actor, { scope: 'all', channel: 'web' }), mergedOr('approved')));
    http.route('POST', '/inbox/p/:id/page/:slug/accept', (req, res, a) =>
      post(req, res, a, back(a.params.id), () => governance.approve(a.params.id, a.actor, { scope: a.params.slug, channel: 'web' }), mergedOr('page_accepted')));
    http.route('POST', '/inbox/p/:id/page/:slug/reject', (req, res, a) =>
      post(req, res, a, back(a.params.id), () => governance.rejectPage(a.params.id, a.params.slug, a.actor, { channel: 'web' }), 'page_rejected'));
    http.route('POST', '/inbox/p/:id/request-changes', (req, res, a) =>
      post(req, res, a, back(a.params.id), () => governance.requestChanges(a.params.id, a.actor, { feedback: a.body?.feedback, channel: 'web' }), 'changes_requested'));
    http.route('POST', '/inbox/p/:id/reject', (req, res, a) =>
      post(req, res, a, back(a.params.id), () => governance.reject(a.params.id, a.actor, { reason: a.body?.reason, channel: 'web' }), 'rejected'));
    http.route('POST', '/inbox/p/:id/retry', (req, res, a) =>
      post(req, res, a, back(a.params.id), () => governance.retryMerge(a.params.id, a.actor, { channel: 'web' }), mergedOr('retried')));
    http.route('POST', '/inbox/d/:id/resolve', async (req, res, a) => {
      const d = await governance.getDecision(a.params.id);
      const to = d ? back(d.proposalId) : '/inbox';
      return post(req, res, a, to, () => governance.resolveDecision(a.params.id, a.actor, { optionId: a.body?.optionId, note: a.body?.note, channel: 'web' }), 'resolved');
    });

    http.route('GET', '/inbox/reverify', async (req, res, { actor, url }) => {
      if (!requireHuman(req, res, actor, url)) return undefined;
      let items = [];
      let error = '';
      try { items = (await ctx.telemetry?.reverifyQueue?.()) || []; }
      catch (err) { error = 'The re-check list isn\'t available — usage tracking is not running.'; log.debug('reverifyQueue unavailable', { error: err.message }); }
      const csrf = sessions.csrfToken(req, res, actor);
      return respond(req, res, (nonce) => views.reverifyPage({ items, error, actor, csrf, nonce }));
    });

    http.route('GET', '/inbox/gaps', async (req, res, { actor, url }) => {
      if (!requireHuman(req, res, actor, url)) return undefined;
      let items = [];
      let error = '';
      try { items = (await ctx.telemetry?.gaps?.({ limit: 50 })) || []; }
      catch (err) { error = 'Unanswered questions aren\'t available — usage tracking is not running.'; log.debug('gaps unavailable', { error: err.message }); }
      const csrf = sessions.csrfToken(req, res, actor);
      return respond(req, res, (nonce) => views.gapsPage({ items, error, actor, csrf, nonce }));
    });

    http.route('GET', '/inbox/activity', async (req, res, { actor, url }) => {
      if (!requireHuman(req, res, actor, url)) return undefined;
      const entries = await store.audit.list({ order: 'desc', limit: 200 });
      const titles = new Map();
      for (const e of entries) {
        if (!String(e.target).startsWith('prp_') || titles.has(e.target)) continue;
        const p = await store.proposals.get(e.target);
        titles.set(e.target, p?.title || '');
      }
      const csrf = sessions.csrfToken(req, res, actor);
      return respond(req, res, (nonce) => views.activityPage({ entries, titles, actor, csrf, nonce }));
    });

    // A chat asked for an approval; a signed-in person confirms it here.
    http.route('GET', '/inbox/confirm/:code', async (req, res, { actor, params, url }) => {
      if (!requireHuman(req, res, actor, url)) return undefined;
      const rec = await confirmations.peek(params.code);
      if (rec.state !== 'ok') return confirmGone(req, res, rec.state, actor);
      const ev = await governance.evaluate(rec.proposalId).catch(() => null);
      if (!ev) return confirmGone(req, res, 'unknown', actor);
      const csrf = sessions.csrfToken(req, res, actor);
      return respond(req, res, (nonce) => views.confirmPage({ rec, proposal: ev.proposal, decisions: ev.decisions, actor, csrf, nonce, code: params.code, canAct: canActOn(ev.proposal, actor) }));
    });

    http.route('POST', '/inbox/confirm/:code', async (req, res, { actor, params, body, url }) => {
      if (!requireHuman(req, res, actor, url)) return undefined;
      if (!actor.session) return notBrowser(req, res);
      if (!sessions.checkCsrf(req, body?.csrf, actor)) {
        return respond(req, res, (nonce) => views.messagePage({ title: 'That form expired', text: 'Open the link again and retry.', nonce }), { status: 403 });
      }
      let rec;
      try { rec = await confirmations.consume(params.code, actor); }
      catch (err) { return confirmGone(req, res, err.state || 'unknown', actor); }
      if ((body?.do === 'approve' && rec.action === 'approve') || (body?.do === 'reject' && rec.action === 'reject')) {
        try {
          const p = rec.action === 'approve'
            ? await governance.approve(rec.proposalId, actor, { scope: 'all', channel: 'mcp' })
            : await governance.reject(rec.proposalId, actor, { reason: String(body?.reason || '').slice(0, 2000), channel: 'mcp' });
          const m = rec.action === 'reject' ? 'rejected' : p.status === 'merged' ? 'merged' : 'approved';
          redirect(res, `/inbox/p/${encodeURIComponent(rec.proposalId)}?m=${m}`);
          return undefined;
        } catch (err) {
          return renderProposal(req, res, actor, rec.proposalId, { flash: { error: true, text: err.status && err.status < 500 ? err.message : 'Something went wrong.' }, status: err.status || 500 });
        }
      }
      redirect(res, `/inbox/p/${encodeURIComponent(rec.proposalId)}`);
      return undefined;
    });

    // ── JSON API ─────────────────────────────────────────────────────────────

    http.route('GET', '/api/proposals', async (_req, _res, { query }) => {
      const filter = {};
      if (query.status) filter.status = String(query.status).split(',');
      if (query.limit) filter.limit = Math.min(500, Number(query.limit) || 50);
      filter.order = 'desc';
      const list = await governance.listProposals(filter);
      const out = [];
      for (const p of list) {
        const decisions = await store.decisions.listByProposal(p.id);
        const info = describe(p, decisions);
        out.push({
          id: p.id, status: p.status, title: info.title, summary: info.sentence, branch: p.branch, headSha: p.headSha,
          openDecisions: info.openDecisions, hot: info.hot, url: `${ctx.config.service.http.base_url}/inbox/p/${p.id}`,
          createdAt: p.createdAt, updatedAt: p.updatedAt,
        });
      }
      return { proposals: out };
    }, { auth: 'any' });

    http.route('GET', '/api/proposals/:id', async (_req, _res, { params }) => {
      const ev = await governance.evaluate(params.id);
      return { proposal: ev.proposal, decisions: ev.decisions, evaluation: ev.evaluation };
    }, { auth: 'any' });

    /** API POSTs: humans only (router), plus CSRF when the credential was a cookie. */
    const api = (fn) => async (req, res, a) => {
      // Tokens the MCP OAuth front door issued are for /mcp only, never for review actions.
      if (/^Bearer\s+alm_at_/i.test(req.headers.authorization || '') && !a.actor.session) {
        throw new HttpError(403, 'MCP access tokens cannot act on proposals — use the inbox');
      }
      if (a.actor.session && !sessions.checkCsrf(req, req.headers['x-almagest-csrf'] || a.body?.csrf, a.actor)) {
        throw new HttpError(403, 'missing or invalid CSRF token');
      }
      const channel = a.actor.session ? 'web' : 'cli';
      return fn(a, channel);
    };
    const human = { auth: 'human' };
    http.route('POST', '/api/proposals/:id/approve', api(({ params, body, actor }, channel) =>
      governance.approve(params.id, actor, { scope: body?.scope || 'all', channel })), human);
    http.route('POST', '/api/proposals/:id/reject', api(({ params, body, actor }, channel) =>
      governance.reject(params.id, actor, { reason: body?.reason, channel })), human);
    http.route('POST', '/api/proposals/:id/request-changes', api(({ params, body, actor }, channel) =>
      governance.requestChanges(params.id, actor, { feedback: body?.feedback, channel })), human);
    http.route('POST', '/api/proposals/:id/retry', api(({ params, actor }, channel) =>
      governance.retryMerge(params.id, actor, { channel })), human);
    http.route('POST', '/api/proposals/:id/pages/:slug/reject', api(({ params, actor }, channel) =>
      governance.rejectPage(params.id, params.slug, actor, { channel })), human);
    http.route('POST', '/api/decisions/:id/resolve', api(({ params, body, actor }, channel) =>
      governance.resolveDecision(params.id, actor, { optionId: body?.optionId, note: body?.note, channel })), human);
    http.route('POST', '/api/proposals/:id/confirmations', async (_req, _res, { params, body, actor }) =>
      governance.createConfirmation(params.id, actor.kind === 'agent' ? actor.onBehalfOf || actor : actor, body?.action || 'approve'), { auth: 'any' });
  }

  function confirmGone(req, res, state, actor) {
    const text = state === 'used' ? 'This link has already been used. Ask again in the chat, or open the inbox.'
      : state === 'expired' ? 'This link has expired. Ask again in the chat, or open the inbox.'
        : 'This link is not valid.';
    const csrf = sessions.csrfToken(req, res, actor);
    return respond(req, res, (nonce) => views.messagePage({ title: 'Link not usable', text, actor, csrf, nonce, link: { href: '/inbox', label: 'Open the inbox' } }), { status: state === 'unknown' ? 404 : 410 });
  }

  return {
    kind: 'web',
    canApprove: true,
    routes,
    notify() {},   // the inbox is pull: it shows the store's current state
  };
}
