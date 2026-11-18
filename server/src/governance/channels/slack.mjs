/**
 * channels/slack.mjs — notifications with buttons, and the button endpoint.
 *
 * Config (`governance.channels[]`):
 *
 *   - kind: slack
 *     webhook_env: SLACK_WEBHOOK_URL            incoming webhook for notifications
 *     signing_secret_env: SLACK_SIGNING_SECRET  verifies button presses
 *     events: [proposal.created, decision.created, proposal.merged]
 *     users:                                    Slack user id → Almagest person
 *       U024BE7LH: { id: usr_ada, display: Ada, email: ada@acme.com, roles: [reviewer], teams: [engineering] }
 *
 * POST /channels/slack/actions checks `X-Slack-Signature` (v0 HMAC over
 * `v0:<timestamp>:<body>`), refuses anything older than five minutes or seen
 * before, and refuses Slack users that are not in `users`. "Approve" calls
 * ctx.governance.approve as the mapped person — resolved by email to the one
 * canonical person (identity.mjs), never trusted as an id — and only for the
 * version (headSha) the message showed. Under single sign-on the person's
 * roles are the ones from their last inbox sign-in, and only while younger
 * than `governance.channel_roles_max_age_hours`; after that the button tells
 * them to sign in again. Everything else links to the inbox. With `require_sso_for_approval`, there is no Approve button at all —
 * only a link into the inbox, where sign-in happens.
 */
import { HttpError } from '../../core/http.mjs';
import { validateMappings } from '../identity.mjs';
import { hmac, safeEqual } from '../signing.mjs';
import { vouch } from '../trust.mjs';
import { DECISION_WORDS, describe } from '../summary.mjs';
import { LIVE } from '../policy.mjs';

const REPLAY_WINDOW_S = 300;

/** Slack mrkdwn escaping: the three characters Slack itself reserves. */
export const slackEscape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifySlack(secret, headers, rawBody, { now = Date.now(), seen = null } = {}) {
  const ts = String(headers['x-slack-request-timestamp'] || '');
  const sig = String(headers['x-slack-signature'] || '');
  if (!secret) return { ok: false, reason: 'slack signing secret is not configured' };
  if (!ts || !sig) return { ok: false, reason: 'missing signature' };
  if (!/^\d+$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > REPLAY_WINDOW_S) return { ok: false, reason: 'request is too old' };
  const expected = `v0=${hmac(secret, `v0:${ts}:${rawBody}`, 'hex')}`;
  if (!safeEqual(expected, sig)) return { ok: false, reason: 'bad signature' };
  if (seen) {
    for (const [k, until] of seen) if (until < now) seen.delete(k);
    if (seen.has(sig)) return { ok: false, reason: 'replayed request' };
    seen.set(sig, now + REPLAY_WINDOW_S * 1000);
  }
  return { ok: true };
}

export async function readRaw(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export function create(ctx, cfg, { governance, identities, people }) {
  const { log, config } = ctx;
  const webhook = cfg.webhook_env ? process.env[cfg.webhook_env] || '' : '';
  const signingSecret = process.env[cfg.signing_secret_env || 'SLACK_SIGNING_SECRET'] || '';
  const users = cfg.users || {};
  const events = cfg.events || ['proposal.created', 'decision.created', 'proposal.merged'];
  const base = String(config.service.http.base_url).replace(/\/+$/, '');
  const requireSso = Boolean(config.governance.require_sso_for_approval);
  const seen = new Map();
  validateMappings('governance.channels[slack].users', Object.entries(users), { mode: people.mode, multi: people.multi, tokenIds: people.tokens().map((t) => t.actor.id) });
  if (!webhook) log.warn('slack channel: no webhook configured — notifications are off', { webhook_env: cfg.webhook_env || '' });

  function message(event, p, decisions, extra = {}) {
    const info = describe(p, decisions);
    const url = `${base}/inbox/p/${encodeURIComponent(p.id)}`;
    const headline = {
      'proposal.created': `New material to review: ${info.title}`,
      'proposal.updated': `Updated and ready to review again: ${info.title}`,
      'decision.created': `A question needs you: ${DECISION_WORDS[extra.decision?.kind] || 'decision'}`,
      'proposal.merged': `Added to the knowledge base: ${info.title}`,
      'proposal.rejected': `Turned down: ${info.title}`,
    }[event] || info.title;
    const detail = event === 'decision.created' ? extra.decision?.question || info.line : info.sentence;
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `*${slackEscape(headline)}*\n${slackEscape(detail)}` } }];
    if (LIVE.includes(p.status) && event !== 'proposal.merged') {
      const elements = [];
      if (!requireSso && info.openDecisions === 0 && p.audit?.exit === 0) {
        elements.push({
          type: 'button', style: 'primary', action_id: 'almagest_approve',
          text: { type: 'plain_text', text: 'Approve' },
          value: JSON.stringify({ p: p.id, h: p.headSha }),
          confirm: {
            title: { type: 'plain_text', text: 'Approve this?' },
            text: { type: 'mrkdwn', text: slackEscape(`${info.line}. It is added to the knowledge base once every requirement is met.`) },
            confirm: { type: 'plain_text', text: 'Approve' }, deny: { type: 'plain_text', text: 'Not yet' },
          },
        });
      }
      elements.push({ type: 'button', action_id: 'almagest_changes', text: { type: 'plain_text', text: 'Request changes' }, url: `${url}#request-changes` });
      elements.push({ type: 'button', action_id: 'almagest_open', text: { type: 'plain_text', text: info.openDecisions ? 'Answer questions' : requireSso ? 'Review and approve' : 'Open' }, url });
      blocks.push({ type: 'actions', elements });
    } else {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${url}|Open in the inbox>` }] });
    }
    return { text: `${headline} — ${detail}`, blocks };
  }

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`slack responded ${res.status}`);
  }

  async function notify(event, payload) {
    if (!webhook || !events.includes(event) || !payload?.proposal) return;
    const decisions = await governance.listDecisions(payload.proposal.id);
    await post(webhook, message(event, payload.proposal, decisions, payload));
  }

  function routes(http) {
    http.route('POST', '/channels/slack/actions', async (req, res) => {
      const raw = await readRaw(req);
      const check = verifySlack(signingSecret, req.headers, raw, { seen });
      if (!check.ok) throw new HttpError(signingSecret ? 401 : 503, check.reason);

      let payload;
      try { payload = JSON.parse(new URLSearchParams(raw).get('payload') || '{}'); } catch { throw new HttpError(400, 'invalid payload'); }
      const action = payload.actions?.[0];
      if (payload.type !== 'block_actions' || action?.action_id !== 'almagest_approve') return { ok: true };

      const reply = async (text) => {
        const url = String(payload.response_url || '');
        if (url.startsWith('https://hooks.slack.com/')) {
          await post(url, { response_type: 'ephemeral', replace_original: false, text }).catch((err) => log.warn('slack reply failed', { error: err.message }));
        }
        return { response_type: 'ephemeral', replace_original: false, text };
      };

      let value = {};
      try { value = JSON.parse(action.value || '{}'); } catch { /* handled below */ }
      const inbox = `${base}/inbox/p/${encodeURIComponent(String(value.p || ''))}`;
      const mapped = users[payload.user?.id];
      if (!mapped) {
        log.warn('slack approval from an unmapped user refused', { slackUser: payload.user?.id || '' });
        return reply(`Your Slack account isn't linked to Almagest, so it can't approve. Ask an administrator to add it, or approve in the inbox: ${inbox}`);
      }
      if (requireSso) return reply(`Approvals need single sign-on. Open the inbox to approve: ${inbox}`);

      const p = value.p ? await governance.getProposal(String(value.p)) : null;
      if (!p) return reply('That proposal no longer exists.');
      if (value.h !== p.headSha) return reply(`This proposal changed after this message was sent. Please look at it again in the inbox: ${inbox}`);

      let who;
      try {
        who = await identities.resolveMapped(mapped, { mode: people.mode, tokens: people.tokens() });
      } catch (err) {
        return reply(`Your Almagest mapping is misconfigured (${err.message}). Ask an administrator.`);
      }
      if (who.refused) return reply(`${who.refused} You can also approve in the inbox: ${inbox}`);
      // Vouched: Slack signed this request and the mapping resolved to one person (trust.mjs).
      const actor = vouch({ ...who.actor, idp: 'slack' }, 'slack');
      try {
        const out = await governance.approve(p.id, actor, { scope: 'all', channel: 'slack', headSha: String(value.h || '') });
        if (out.status === 'merged') return reply('Approved — it is now part of the knowledge base.');
        const { evaluation } = await governance.evaluate(p.id);
        return reply(`Approved. ${evaluation.ready ? '' : evaluation.explanation}`.trim());
      } catch (err) {
        return reply(err.status && err.status < 500 ? err.message : 'Something went wrong. Please approve in the inbox.');
      }
    }, { raw: true });
  }

  return { kind: 'slack', canApprove: !requireSso, notify, routes, message };
}
