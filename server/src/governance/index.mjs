/**
 * governance — WS3. Spec: docs/v2/spec.md → Governance; guide: docs/v2/governance.md.
 *
 * Builds ctx.governance: proposals from ingest jobs, decisions, the policy
 * engine, approvals from every configured channel, and the merge — the only
 * code in the service that moves `main`, and only after a human approved the
 * exact diff (headSha) being merged.
 *
 *   create(ctx) → service object   (registers inbox/API/channel routes, a session auth provider)
 *   commands    → CLI subcommands
 */
import { parseTokens } from '../core/auth.mjs';
import { createChannels } from './channels/index.mjs';
import { createConfirmations } from './confirmations.mjs';
import { createIdentities } from './identity.mjs';
import { createMerger, createMutex } from './merge.mjs';
import { writableMatcher } from './paths.mjs';
import { createService } from './service.mjs';
import { createSessions } from './sessions.mjs';
import { secretKey } from './signing.mjs';
import { describe } from './summary.mjs';

export async function create(ctx) {
  const { config, log } = ctx;
  const secret = secretKey({ log });
  const lock = createMutex();

  const mcpCfg = (config.governance.channels || []).find((c) => c?.kind === 'mcp') || {};
  const confirmations = createConfirmations({
    store: ctx.store,
    baseUrl: config.service.http.base_url,
    ttlMs: Number(mcpCfg.confirm_ttl_minutes || 15) * 60 * 1000,
    lock: createMutex(),
  });

  const identities = createIdentities({ store: ctx.store, log });
  const sessions = createSessions(ctx, { secret, identities, ttlHours: Number(config.service.auth.session_hours || 12) });
  ctx.auth.use(sessions.provider);
  sessions.routes(ctx.http);

  const allowed = writableMatcher({
    brainDir: config.v1.brainDir, manifestPath: config.v1.manifestPath,
    challengesPath: config.v1.challengesPath, indexDir: config.v1.indexDir,
  });
  const merger = createMerger({ git: ctx.git, config, log, allowed });
  const governance = createService(ctx, { merger, confirmations, lock, identities, allowed });

  // How channel accounts are tied to people (identity.mjs). "multi" = counting
  // people matters, so every mapping must resolve to exactly one person.
  const rules = config.governance.rules || [];
  const people = {
    mode: config.service.auth.provider,
    tokens: () => parseTokens(process.env[config.service.auth.tokens_env || 'ALMAGEST_TOKENS'] || ''),
    multi: Boolean(config.governance.separation_of_duties)
      || rules.some((r) => (r.require?.approvals || 0) > 1 || (r.require?.distinct_teams || 0) > 1),
  };
  const channels = createChannels(ctx, { governance, sessions, confirmations, secret, merger, identities, people });
  governance.channels = channels.map((c) => ({ kind: c.kind, canApprove: Boolean(c.canApprove) }));
  governance.channel = (kind) => channels.find((c) => c.kind === kind) || null;
  governance.identities = identities;   // the person registry (identity.mjs) — read-mostly, for doctor and tests

  ctx.http.route('GET', '/', async (_req, res) => {
    res.statusCode = 303;
    res.setHeader('location', '/inbox');
    res.end();
    return undefined;
  });
  return governance;
}

export const commands = {
  proposals: {
    summary: 'List proposals waiting for review',
    needsApp: true,
    async run(_argv, { ctx }) {
      const list = await ctx.governance.listProposals({ status: ['open', 'approved', 'conflicted', 'changes_requested'] });
      if (list.length === 0) { process.stdout.write('Nothing waiting for review.\n'); return 0; }
      for (const p of list) {
        const d = await ctx.governance.listDecisions(p.id);
        const info = describe(p, d);
        process.stdout.write(`${p.id}  ${info.title}\n    ${info.sentence}\n    ${ctx.config.service.http.base_url}/inbox/p/${p.id}\n`);
      }
      return 0;
    },
  },
  'inbox-digest': {
    summary: 'Send the email digest of proposals waiting for review',
    needsApp: true,
    async run(_argv, { ctx }) {
      const email = ctx.governance.channel('email');
      if (!email) { process.stderr.write('almagest: no email channel configured (governance.channels)\n'); return 1; }
      const n = await email.digest();
      process.stdout.write(`Sent ${n} digest mail${n === 1 ? '' : 's'}.\n`);
      return 0;
    },
  },
};
