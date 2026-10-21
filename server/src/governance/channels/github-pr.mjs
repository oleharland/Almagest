/**
 * channels/github-pr.mjs — the v1 workflow, for teams that live in GitHub.
 *
 * Config (`governance.channels[]`):
 *
 *   - kind: github-pr
 *     repo: acme/brain
 *     token_env: GITHUB_TOKEN               # contents:write + pull_requests:write
 *     webhook_secret_env: GITHUB_WEBHOOK_SECRET
 *     api_url: https://api.github.com       # GitHub Enterprise: https://ghe.acme.com/api/v3
 *     users:                                # GitHub login → Almagest person
 *       octocat: { id: usr_ada, display: Ada, email: ada@acme.com, roles: [reviewer], teams: [engineering] }
 *
 * On a new or revised proposal it pushes the branch to `service.git.remote`
 * and opens (or updates) a pull request whose body is the plain-language
 * summary plus a link to the inbox. It never merges through the API.
 *
 * POST /channels/github/webhook verifies `X-Hub-Signature-256` and acts only
 * on pull requests from `repo` itself into main — a fork's PR with the same
 * branch name is ignored. A merged PR is put to the policy first, as the
 * approval of the GitHub user who merged it (via `users`): a mapped human
 * reviewer, separation of duties, the reviewed head. Only if that holds is
 * `merge_commit_sha` fetched — that commit, not the remote's tip — and local
 * main moved to it, after its parents are checked to be exactly (local main,
 * reviewed head) and it passes the same path check and audit as an inbox
 * merge (merge.mjs → acceptExternal). Anything else leaves local main alone
 * and marks the proposal `merged_unaccepted` with the reason, logged as a
 * policy violation. Almagest stays the gate for its own main; GitHub's
 * branch protection is defence in depth, not the gate.
 */
import { HttpError } from '../../core/http.mjs';
import { validateMappings } from '../identity.mjs';
import { hmac, safeEqual } from '../signing.mjs';
import { vouch } from '../trust.mjs';
import { describe, sourceName } from '../summary.mjs';
import { readRaw } from './slack.mjs';

const NS = 'governance.github';
const DELIVERIES = 'governance.github.delivery';

export function verifyGithub(secret, signature, rawBody) {
  if (!secret) return false;
  const expected = `sha256=${hmac(secret, rawBody, 'hex')}`;
  return safeEqual(expected, String(signature || ''));
}

export function prBody(p, decisions, base) {
  const info = describe(p, decisions);
  const url = `${base}/inbox/p/${encodeURIComponent(p.id)}`;
  const pages = (p.changes || []).filter((c) => c.pageStatus !== 'rejected')
    .map((c) => `- **${c.title}** (${c.action === 'create' ? 'new page' : c.action}) — ${c.claims.length} fact change${c.claims.length === 1 ? '' : 's'}`);
  return [
    `${info.line}, from “${sourceName(p.source)}”.`,
    '',
    ...pages,
    '',
    info.openDecisions ? `**${info.openDecisions} question${info.openDecisions === 1 ? '' : 's'} must be answered before this can merge.**` : '',
    `Review each fact next to its source passage in the inbox: ${url}`,
    '',
    `Merging this pull request counts as your approval and is recorded by Almagest (proposal \`${p.id}\`, reviewed head \`${String(p.headSha).slice(0, 7)}\`).`,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

export function create(ctx, cfg, { governance, identities, people }) {
  const { config, git, log, store } = ctx;
  const base = String(config.service.http.base_url).replace(/\/+$/, '');
  const api = String(cfg.api_url || 'https://api.github.com').replace(/\/+$/, '');
  const token = () => (cfg.token_env ? process.env[cfg.token_env] || '' : '');
  const secret = process.env[cfg.webhook_secret_env || 'GITHUB_WEBHOOK_SECRET'] || '';
  const remote = cfg.remote || config.service.git.remote;
  const main = config.service.git.main;
  const users = cfg.users || {};
  validateMappings('governance.channels[github-pr].users', Object.entries(users), { mode: people.mode, multi: people.multi, tokenIds: people.tokens().map((t) => t.actor.id) });
  if (!cfg.repo || !remote) log.warn('github-pr channel: repo or service.git.remote not set — pull requests are off');

  async function gh(method, route, body) {
    const res = await fetch(`${api}${route}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'almagest',
        authorization: `Bearer ${token()}`, ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${route} → ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  async function notify(event, { proposal: p }) {
    if (!p || !cfg.repo || !remote) return;
    const pr = await store.kv.get(NS, p.id);
    if (event === 'proposal.created' || event === 'proposal.updated') {
      if (!['open', 'conflicted'].includes(p.status)) return;
      await git.run(['push', '--quiet', remote, `refs/heads/${p.branch}:refs/heads/${p.branch}`]);
      const decisions = await governance.listDecisions(p.id);
      const body = prBody(p, decisions, base);
      if (!pr) {
        const made = await gh('POST', `/repos/${cfg.repo}/pulls`, { title: describe(p, decisions).title, head: p.branch, base: main, body });
        await store.kv.set(NS, p.id, { number: made.number, url: made.html_url });
      } else {
        await gh('PATCH', `/repos/${cfg.repo}/pulls/${pr.number}`, { body });
      }
    } else if (pr && event === 'proposal.merged' && p.merge?.method !== 'github-pr') {
      await gh('POST', `/repos/${cfg.repo}/issues/${pr.number}/comments`, { body: `Added through the Almagest inbox (merge ${String(p.merge?.sha || '').slice(0, 7)}).` });
      if (!config.service.git.push) await gh('PATCH', `/repos/${cfg.repo}/pulls/${pr.number}`, { state: 'closed' });
    } else if (pr && event === 'proposal.rejected') {
      await gh('POST', `/repos/${cfg.repo}/issues/${pr.number}/comments`, { body: 'Turned down in the Almagest inbox.' });
      await gh('PATCH', `/repos/${cfg.repo}/pulls/${pr.number}`, { state: 'closed' });
    }
  }

  /**
   * The person behind a GitHub login: mapped through `users`, then resolved
   * by email to the canonical person (identity.mjs). Anyone else is recorded
   * as who they were — and cannot approve.
   */
  async function actorFor(login) {
    const m = users[login];
    const stranger = (why) => ({ id: `github:${login}`, kind: 'human', display: login, email: '', roles: [], teams: [], idp: 'github', unmapped: true, why });
    if (!m) return stranger('not mapped');
    const who = await identities.resolveMapped(m, { mode: people.mode, tokens: people.tokens() });
    if (who.refused) return stranger(who.refused);
    return vouch({ ...who.actor, idp: 'github' }, 'github-pr');
  }

  /**
   * Bring the merge commit itself into the local object store — never a
   * branch tip. Fetching by id needs a server that allows it (GitHub does);
   * failing that, main is fetched and the commit must be in what came back.
   * Nothing here moves a ref.
   */
  async function fetchCommit(sha) {
    if (!remote || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) return;
    if ((await git.tryRun(['fetch', '--quiet', '--no-tags', remote, sha])) !== null) return;
    await git.run(['fetch', '--quiet', '--no-tags', remote, `refs/heads/${main}`]);
  }

  /** A PR from this repo into main — not a fork's branch that happens to share the name. */
  function fromThisRepo(pr) {
    const headRepo = String(pr.head?.repo?.full_name || '').toLowerCase();
    return Boolean(cfg.repo) && headRepo === String(cfg.repo).toLowerCase() && pr.base?.ref === main;
  }

  function routes(http) {
    http.route('POST', '/channels/github/webhook', async (req) => {
      const raw = await readRaw(req, 5 * 1024 * 1024);
      if (!secret) throw new HttpError(503, 'github webhook secret is not configured');
      if (!verifyGithub(secret, req.headers['x-hub-signature-256'], raw)) throw new HttpError(401, 'bad signature');
      const event = req.headers['x-github-event'];
      // GitHub redelivers on timeouts and lets people press "Redeliver": act once per delivery.
      const delivery = String(req.headers['x-github-delivery'] || '');
      if (delivery) {
        if (await store.kv.get(DELIVERIES, delivery)) return { ok: true, duplicate: true };
        await store.kv.set(DELIVERIES, delivery, { at: new Date().toISOString(), event: String(event || '') });
      }
      try {
        if (event === 'ping') return { ok: true };
        if (event !== 'pull_request') return { ok: true, ignored: event };
        let payload;
        try { payload = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid JSON'); }
        const pr = payload.pull_request || {};
        if (payload.action !== 'closed') return { ok: true, ignored: payload.action };
        if (!fromThisRepo(pr)) {
          log.warn('github webhook: ignoring a pull request that is not from this repository into main', {
            pr: pr.number, head: String(pr.head?.repo?.full_name || ''), branch: String(pr.head?.ref || ''), base: String(pr.base?.ref || ''),
          });
          return { ok: true, ignored: 'not a pull request from this repository into main' };
        }
        const p = await store.proposals.getByBranch(String(pr.head?.ref || ''));
        if (!p) return { ok: true, ignored: 'no proposal for that branch' };

        if (pr.merged) {
          const actor = await actorFor(String(pr.merged_by?.login || 'unknown'));
          const out = await governance.recordExternalMerge(p.id, actor, {
            sha: String(pr.merge_commit_sha || ''), headSha: String(pr.head?.sha || ''), channel: 'github-pr', fetch: fetchCommit,
          });
          return { ok: true, proposal: out.id, status: out.status, policyMet: out.merge?.policyMet, accepted: out.merge?.accepted === true, ...(out.merge?.reason ? { reason: out.merge.reason } : {}) };
        }
        const login = String(payload.sender?.login || '');
        const actor = await actorFor(login);
        if (actor.unmapped) return { ok: true, ignored: 'closed by an unmapped GitHub user' };
        try {
          const out = await governance.reject(p.id, actor, { reason: 'Pull request closed on GitHub', channel: 'github-pr' });
          return { ok: true, proposal: out.id, status: out.status };
        } catch (err) {
          return { ok: true, ignored: err.message };
        }
      } catch (err) {
        // Not handled: let GitHub's retry through instead of swallowing it as a duplicate.
        if (delivery) await store.kv.delete(DELIVERIES, delivery);
        throw err;
      }
    }, { raw: true });
  }

  return { kind: 'github-pr', canApprove: true, notify, routes };
}
