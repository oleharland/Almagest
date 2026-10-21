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
 * Every review action — form or JSON — needs a signed-in browser session
 * and its CSRF token (forms: `csrf` field; JSON: `x-almagest-csrf` header).
 * Bearer tokens may read proposals; they never act on them. Every approve,
 * accept and answer carries the `headSha` the person was shown.
 */
import os from 'node:os';

import { HttpError } from '../../core/http.mjs';
import { safeNext } from '../html.mjs';
import { describe } from '../summary.mjs';
import { redirect } from '../sessions.mjs';
import { vouchedAs } from '../trust.mjs';
import { newNonce, securityHeaders } from '../web/layout.mjs';
import * as views from '../web/views.mjs';

const ACTIVE = ['open', 'approved', 'conflicted', 'changes_requested'];
const INTERNAL_KEYS = new Set(['worktree', 'staged', 'stagedPath', 'workdir']);

/**
 * API output without the server's filesystem: no worktree or staging paths,
 * no string that is an absolute path under the repo, the state dir or tmp.
 */
export function publicView(value, roots) {
  if (Array.isArray(value)) return value.map((v) => publicView(v, roots));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (INTERNAL_KEYS.has(k)) continue;
      if (typeof v === 'string' && roots.some((r) => r && v.startsWith(r))) continue;
      out[k] = publicView(v, roots);
    }
    return out;
  }
  return value;
}
const DONE = ['merged', 'merged_unaccepted', 'rejected', 'superseded'];

export function create(ctx, cfg, { governance, sessions, confirmations }) {
  const { store, log } = ctx;
  const roots = [ctx.repoRoot, ctx.config.paths?.state, ctx.config.paths?.worktrees, os.tmpdir(), '/private/var/', '/var/folders/']
    .filter(Boolean).map((r) => String(r));
  const pub = (v) => publicView(v, roots);

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

  const isBrowser = (actor) => vouchedAs(actor) === 'session' && Boolean(actor?.session?.sid);

  /** Review actions happen only in a signed-in browser session — never with a bearer token. */
  function notBrowser(req, res) {
    return respond(req, res, (nonce) => views.messagePage({ title: 'Sign in first', text: 'Review actions work only in a signed-in browser. Tokens can read proposals but never approve, reject or answer.', nonce, link: { href: '/inbox/login', label: 'Sign in' } }), { status: 403 });
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

  const canActOn = (p, actor) => governance.mayApprove(p, actor);

  /** A chat's approval request carried into the review page (?confirm=<code>). */
  async function chatRequest(code, proposalId) {
    if (!code) return null;
    const rec = await confirmations.peek(code);
    if (rec.state !== 'ok' || rec.proposalId !== proposalId) return null;
    return { code, action: rec.action, onBehalfOf: rec.onBehalfOf, headSha: rec.headSha };
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

  async function renderProposal(req, res, actor, id, { flash = null, status = 200, confirm = '' } = {}) {
    const csrf = sessions.csrfToken(req, res, actor);
    const ev = await governance.evaluate(id).catch((err) => { if (err.status === 404) return null; throw err; });
    if (!ev) {
      return respond(req, res, (nonce) => views.messagePage({ title: 'Not found', text: 'There is no proposal with that link.', actor, csrf, nonce, link: { href: '/inbox', label: 'Back to the inbox' } }), { status: 404 });
    }
    const why = await hotReasons(ev.proposal);
    const canAct = await canActOn(ev.proposal, actor);
    const chat = await chatRequest(confirm, ev.proposal.id);
    return respond(req, res, (nonce) => views.proposalPage({
      proposal: ev.proposal, decisions: ev.decisions, evaluation: ev.evaluation,
      actor, csrf, nonce, canAct, flash, why, chat,
    }), { status });
  }

  /**
   * Run an inbox POST: CSRF, then the action; success → 303 back with a
   * fixed message key (never reflected text), failure → the page re-rendered
   * with the error.
   */
  async function post(req, res, { actor, body, url }, backTo, fn, message) {
    if (!requireHuman(req, res, actor, url)) return undefined;
    if (!isBrowser(actor)) return notBrowser(req, res);
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
        return renderProposal(req, res, actor, decodeURIComponent(id), { flash: { error: true, text: err.status && err.status < 500 ? err.message : 'Something went wrong. Nothing was changed.' }, status: err.status || 500, confirm: body?.confirm });
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
      return renderProposal(req, res, actor, params.id, { flash: flashFrom(query), confirm: String(query.confirm || '') });
    });

    const back = (id) => `/inbox/p/${encodeURIComponent(id)}`;
    /**
     * The person answered a chat's request on the full review page. The
     * action is theirs; the code only attributes it (channel `mcp`) and is
     * used up once the action went through.
     */
    const viaChat = async (a, action) => {
      const chat = await chatRequest(String(a.body?.confirm || ''), a.params.id);
      return chat && chat.action === action ? chat : null;
    };
    const spend = (chat, actor) => chat && confirmations.consume(chat.code, actor).catch(() => {});

    http.route('POST', '/inbox/p/:id/approve', (req, res, a) =>
      post(req, res, a, back(a.params.id), async () => {
        const chat = await viaChat(a, 'approve');
        const out = await governance.approve(a.params.id, a.actor, { scope: 'all', channel: chat ? 'mcp' : 'web', headSha: a.body?.headSha });
        await spend(chat, a.actor);
        return out;
      }, mergedOr('approved')));
    http.route('POST', '/inbox/p/:id/page/:slug/accept', (req, res, a) =>
      post(req, res, a, back(a.params.id), () => governance.approve(a.params.id, a.actor, { scope: a.params.slug, channel: 'web', headSha: a.body?.headSha }), mergedOr('page_accepted')));
    http.route('POST', '/inbox/p/:id/page/:slug/reject', (req, res, a) =>
      post(req, res, a, back(a.params.id), () => governance.rejectPage(a.params.id, a.params.slug, a.actor, { channel: 'web' }), 'page_rejected'));
    http.route('POST', '/inbox/p/:id/request-changes', (req, res, a) =>
      post(req, res, a, back(a.params.id), () => governance.requestChanges(a.params.id, a.actor, { feedback: a.body?.feedback, channel: 'web' }), 'changes_requested'));
    http.route('POST', '/inbox/p/:id/reject', (req, res, a) =>
      post(req, res, a, back(a.params.id), async () => {
        const chat = await viaChat(a, 'reject');
        const out = await governance.reject(a.params.id, a.actor, { reason: a.body?.reason, channel: chat ? 'mcp' : 'web' });
        await spend(chat, a.actor);
        return out;
      }, 'rejected'));
    http.route('POST', '/inbox/p/:id/retry', (req, res, a) =>
      post(req, res, a, back(a.params.id), () => governance.retryMerge(a.params.id, a.actor, { channel: 'web' }), mergedOr('retried')));
    http.route('POST', '/inbox/d/:id/resolve', async (req, res, a) => {
      const d = await governance.getDecision(a.params.id);
      const to = d ? back(d.proposalId) : '/inbox';
      return post(req, res, a, to, () => governance.resolveDecision(a.params.id, a.actor, { optionId: a.body?.optionId, note: a.body?.note, channel: 'web', headSha: a.body?.headSha }), 'resolved');
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

    // A chat asked for an approval. The link only leads to the full review —
    // the person approves there, on the version they can see, like any other.
    http.route('GET', '/inbox/confirm/:code', async (req, res, { actor, params, url }) => {
      if (!requireHuman(req, res, actor, url)) return undefined;
      const rec = await confirmations.peek(params.code);
      if (rec.state !== 'ok') return confirmGone(req, res, rec.state, actor);
      redirect(res, `/inbox/p/${encodeURIComponent(rec.proposalId)}?confirm=${encodeURIComponent(params.code)}`);
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
      return pub({ proposal: ev.proposal, decisions: ev.decisions, evaluation: ev.evaluation });
    }, { auth: 'any' });

    /**
     * API actions: a signed-in browser session plus its CSRF token, exactly as
     * the forms. A bearer token — ALMAGEST_TOKENS, an OIDC access token, an
     * MCP OAuth token — is refused here even when it belongs to a reviewer:
     * an agent with the token in its environment must not be able to approve.
     */
    const api = (fn) => async (req, res, a) => {
      if (!isBrowser(a.actor)) throw new HttpError(403, 'Review actions need a signed-in browser session. Tokens can only read proposals.');
      if (!sessions.checkCsrf(req, req.headers['x-almagest-csrf'] || a.body?.csrf, a.actor)) {
        throw new HttpError(403, 'missing or invalid CSRF token');
      }
      return pub(await fn(a, 'web'));
    };
    const human = { auth: 'human' };
    http.route('POST', '/api/proposals/:id/approve', api(({ params, body, actor }, channel) =>
      governance.approve(params.id, actor, { scope: body?.scope || 'all', channel, headSha: body?.headSha })), human);
    http.route('POST', '/api/proposals/:id/reject', api(({ params, body, actor }, channel) =>
      governance.reject(params.id, actor, { reason: body?.reason, channel })), human);
    http.route('POST', '/api/proposals/:id/request-changes', api(({ params, body, actor }, channel) =>
      governance.requestChanges(params.id, actor, { feedback: body?.feedback, channel })), human);
    http.route('POST', '/api/proposals/:id/retry', api(({ params, actor }, channel) =>
      governance.retryMerge(params.id, actor, { channel })), human);
    http.route('POST', '/api/proposals/:id/pages/:slug/reject', api(({ params, actor }, channel) =>
      governance.rejectPage(params.id, params.slug, actor, { channel })), human);
    http.route('POST', '/api/decisions/:id/resolve', api(({ params, body, actor }, channel) =>
      governance.resolveDecision(params.id, actor, { optionId: body?.optionId, note: body?.note, channel, headSha: body?.headSha })), human);
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
