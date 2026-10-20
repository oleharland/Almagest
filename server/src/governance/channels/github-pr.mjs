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
 * POST /channels/github/webhook verifies `X-Hub-Signature-256`. A merged PR
 * is recorded as the approval of the GitHub user who merged it (via `users`),
 * the proposal is marked merged, and main is fetched and fast-forwarded. A
 * merge by an unmapped or non-reviewer account is still recorded — it
 * happened — and logged as a policy violation. Mirror the policy in GitHub's
 * branch protection; GitHub is the gate on that path.
 */
import { humanActor } from '../../core/auth.mjs';
import { HttpError } from '../../core/http.mjs';
import { hmac, safeEqual } from '../signing.mjs';
import { describe, sourceName } from '../summary.mjs';
import { readRaw } from './slack.mjs';

const NS = 'governance.github';

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

export function create(ctx, cfg, { governance, merger }) {
  const { config, git, log, store } = ctx;
  const base = String(config.service.http.base_url).replace(/\/+$/, '');
  const api = String(cfg.api_url || 'https://api.github.com').replace(/\/+$/, '');
  const token = () => (cfg.token_env ? process.env[cfg.token_env] || '' : '');
  const secret = process.env[cfg.webhook_secret_env || 'GITHUB_WEBHOOK_SECRET'] || '';
  const remote = cfg.remote || config.service.git.remote;
  const main = config.service.git.main;
  const users = cfg.users || {};
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

  function actorFor(login) {
    const m = users[login];
    if (!m) return { id: `github:${login}`, kind: 'human', display: login, email: '', roles: [], teams: [], idp: 'github', unmapped: true };
    return { ...humanActor({ id: m.id, display: m.display || login, email: m.email, roles: m.roles || ['viewer'], teams: m.teams || [] }), idp: 'github' };
  }

  /** Bring local main up to the remote's, by fast-forward only. */
  async function followRemoteMain() {
    if (!remote) return;
    await git.run(['fetch', '--quiet', remote, `refs/heads/${main}`]);
    const fetched = (await git.run(['rev-parse', 'FETCH_HEAD'])).trim();
    const local = await git.revParse(main);
    if (fetched === local) return;
    const ff = await git.tryRun(['merge-base', '--is-ancestor', local, fetched]);
    if (ff === null) { log.warn('remote main is not a fast-forward of local main — leaving local main alone'); return; }
    const moved = await merger.moveMain(local, fetched, 'almagest: follow merged pull request');
    if (!moved.ok) log.warn('could not fast-forward local main after a GitHub merge', { reason: moved.reason });
  }

  function routes(http) {
    http.route('POST', '/channels/github/webhook', async (req) => {
      const raw = await readRaw(req, 5 * 1024 * 1024);
      if (!secret) throw new HttpError(503, 'github webhook secret is not configured');
      if (!verifyGithub(secret, req.headers['x-hub-signature-256'], raw)) throw new HttpError(401, 'bad signature');
      const event = req.headers['x-github-event'];
      if (event === 'ping') return { ok: true };
      if (event !== 'pull_request') return { ok: true, ignored: event };
      let payload;
      try { payload = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid JSON'); }
      const pr = payload.pull_request || {};
      if (payload.action !== 'closed') return { ok: true, ignored: payload.action };
      const p = await store.proposals.getByBranch(String(pr.head?.ref || ''));
      if (!p) return { ok: true, ignored: 'no proposal for that branch' };

      if (pr.merged) {
        const actor = actorFor(String(pr.merged_by?.login || 'unknown'));
        try { await followRemoteMain(); } catch (err) { log.warn('fetching main after a GitHub merge failed', { error: err.message }); }
        const out = await governance.recordExternalMerge(p.id, actor, { sha: String(pr.merge_commit_sha || ''), headSha: String(pr.head?.sha || ''), channel: 'github-pr' });
        return { ok: true, proposal: out.id, status: out.status, policyMet: out.merge?.policyMet };
      }
      const login = String(payload.sender?.login || '');
      const actor = actorFor(login);
      if (actor.unmapped) return { ok: true, ignored: 'closed by an unmapped GitHub user' };
      try {
        const out = await governance.reject(p.id, actor, { reason: 'Pull request closed on GitHub', channel: 'github-pr' });
        return { ok: true, proposal: out.id, status: out.status };
      } catch (err) {
        return { ok: true, ignored: err.message };
      }
    }, { raw: true });
  }

  return { kind: 'github-pr', canApprove: true, notify, routes };
}
