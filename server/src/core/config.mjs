/**
 * config.mjs — the v2 sections of brain.config.yaml, with profile defaults.
 *
 * The v1 sections are parsed by `tools/lib/config.mjs`, the same loader the
 * audit uses, and exposed unchanged as `config.v1`. This file adds `service`,
 * `ingest`, `sources.connectors`, `governance` and `telemetry` on top.
 *
 * A profile (`service.profile`) only fills defaults. Nothing downstream may
 * branch on the profile name — read the resolved key instead. That is what
 * keeps "solo" and "enterprise" one code path with different settings.
 */
import path from 'node:path';

import { loadConfig as loadV1Config } from '../../../tools/lib/config.mjs';

export const PROFILES = ['solo', 'team', 'enterprise'];

const BASE = {
  service: {
    profile: 'solo',
    store: { driver: 'sqlite', path: '.almagest/almagest.db', url: '' },
    http: { host: '127.0.0.1', port: 4747, base_url: '' },
    git: { main: 'main', remote: '', push: false, worktree_dir: '.almagest/worktrees' },
    auth: { provider: 'token', tokens_env: 'ALMAGEST_TOKENS', logins_env: 'ALMAGEST_LOGINS', oidc: {} },
  },
  ingest: {
    driver: 'claude-code',
    model_tier: 'judgment',
    concurrency: 1,
    budget_usd_per_job: 5,
    timeout_minutes: 30,
    watch_raw: true,
    max_attempts: 2,
  },
  governance: {
    channels: [{ kind: 'web' }, { kind: 'mcp' }],
    separation_of_duties: false,
    require_sso_for_approval: false,
    inherit_profile_rules: true,
    channel_roles_max_age_hours: 24,
    session_roles_max_age_minutes: 60,
    rules: [],
  },
  telemetry: {
    enabled: true,
    store_queries: 'plain',
    store_actor: 'hashed',
    retention_days: 90,
    demand: { half_life_days: 14, hot_percentile: 90, min_score: 3 },
    stale_after_days_hot: 30,
  },
};

/** What each profile changes relative to BASE. Keep this table in step with docs/v2/spec.md → Profiles. */
const PROFILE_DEFAULTS = {
  solo: {
    governance: { rules: [{ when: { hot: true }, require: { approvals: 1, per_page: true } }] },
  },
  team: {
    service: { auth: { provider: 'oidc' } },
    governance: {
      channels: [{ kind: 'web' }, { kind: 'mcp' }, { kind: 'slack' }],
      separation_of_duties: true,
      rules: [{ when: { hot: true }, require: { approvals: 2, per_page: true } }],
    },
    telemetry: { store_queries: 'hashed' },
  },
  enterprise: {
    service: { store: { driver: 'postgres', url: '${DATABASE_URL}' }, auth: { provider: 'oidc' } },
    governance: {
      channels: [{ kind: 'web' }, { kind: 'slack' }, { kind: 'github-pr' }],
      separation_of_duties: true,
      require_sso_for_approval: true,
      channel_roles_max_age_hours: 8,
      session_roles_max_age_minutes: 30,
      rules: [
        { when: { hot: true }, require: { approvals: 2, per_page: true, owner_team: true } },
        { when: { decision: 'canonical_conflict' }, require: { roles: ['owner'] } },
      ],
    },
    telemetry: { store_queries: 'hashed', store_actor: 'hashed' },
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep merge for config objects. Arrays replace, they do not concatenate.
 * `governance.rules` is the one exception, and loadServiceConfig handles it
 * after the merge: see effectiveRules.
 */
export function deepMerge(...layers) {
  const out = {};
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue;
      out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : isPlainObject(v) ? deepMerge(v) : v;
    }
  }
  return out;
}

/**
 * `${VAR}` and `${VAR:-default}` in string values, the same syntax `.mcp.json`
 * uses. Expanded at load time so secrets never have to be written into the
 * committed config file.
 */
export function expandEnv(value, env = process.env) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_m, name, fallback) => env[name] ?? fallback ?? '');
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env)]));
  }
  return value;
}

/**
 * v1 `sources.remote` entries keep working: each one becomes a connector with
 * the provider's recipe, so there is one ingest path rather than two.
 */
function remoteAsConnectors(remote) {
  return (remote || []).map((r, i) => ({
    id: r.id || `${r.provider}-${String(r.repo || i).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
    mcp: r.provider,
    recipe: r.provider,
    select: { repo: r.repo, paths: r.paths || [], branch: r.branch || '' },
    schedule: r.schedule || '',
    label: r.label || '',
    tier: r.tier || 'evidence',
    snapshot: 'commit',
    fromV1Remote: true,
  }));
}

function describeRule(rule) {
  return `when ${JSON.stringify(rule.when || {})} require ${JSON.stringify(rule.require || {})}`;
}

/**
 * The profile's rules plus the configured ones. Rules only ever add — they
 * combine by max and union (governance/policy.mjs) — so appending can never
 * weaken the profile, while replacing silently would: an enterprise that adds
 * one `label: legal` rule would otherwise lose the hot-page and
 * canonical_conflict rules. `inherit_profile_rules: false` is the explicit way
 * to drop them, and it is announced in `warnings`.
 */
function effectiveRules(profile, configured, merged, warnings) {
  const own = configured == null ? [] : merged.rules;   // a bare `rules:` in YAML is null
  if (!Array.isArray(own)) return own;   // governance/policy.mjs rejects it with a message
  const fromProfile = structuredClone(PROFILE_DEFAULTS[profile].governance?.rules || []);
  if (merged.inherit_profile_rules !== false) return [...fromProfile, ...own];
  if (fromProfile.length) {
    warnings.push(`governance.inherit_profile_rules is false — the ${profile} profile's rules are dropped: ${fromProfile.map(describeRule).join('; ')}`);
  }
  return own;
}

/**
 * Settings that contradict what the profile promises. The spec says
 * enterprise *requires* OIDC, not that it defaults to it.
 * @returns {string[]}
 */
export function configErrors(config) {
  const errors = [];
  const provider = config.service.auth?.provider;
  if (config.profile === 'enterprise' && provider !== 'oidc') {
    errors.push(`service.profile: enterprise requires service.auth.provider: oidc (got "${provider}") — set up OIDC, or use profile team`);
  }
  return errors;
}

/**
 * @param {string} repoRoot
 * @param {object} [options]
 * @param {string} [options.configPath]
 * @param {object} [options.overrides]  merged last — tests and CLI flags
 * @param {object} [options.env]
 * @param {boolean} [options.validate]  false: return a config that fails configErrors() instead of throwing (doctor)
 */
export function loadServiceConfig(repoRoot, options = {}) {
  const { configPath, overrides = {}, env = process.env, validate = true } = options;
  const v1 = loadV1Config(repoRoot, configPath);
  const raw = v1.raw;

  const profile = raw.service?.profile || overrides.service?.profile || 'solo';
  if (!PROFILES.includes(profile)) {
    throw new Error(`service.profile must be one of ${PROFILES.join(' | ')} (got "${profile}")`);
  }

  const merged = expandEnv(
    deepMerge(
      BASE,
      PROFILE_DEFAULTS[profile],
      { service: raw.service, ingest: raw.ingest, governance: raw.governance, telemetry: raw.telemetry, mcp: raw.mcp },
      overrides,
    ),
    env,
  );
  merged.service.profile = profile;
  const warnings = [];
  merged.governance.rules = effectiveRules(profile, overrides.governance?.rules ?? raw.governance?.rules, merged.governance, warnings);
  if (merged.service.auth?.oidc?.default_role !== undefined) {
    // auth-oidc.mjs still reads the singular; the plural is the documented key.
    warnings.push(`service.auth.oidc.default_role is deprecated — write default_roles: [${merged.service.auth.oidc.default_role}]`);
  }
  // Container platforms hand the listen address over in the environment (PORT
  // on Fly, Railway, Cloud Run); it wins over the committed config.
  if (env.ALMAGEST_HTTP_HOST) merged.service.http.host = env.ALMAGEST_HTTP_HOST;
  if (env.ALMAGEST_PORT || env.PORT) merged.service.http.port = Number(env.ALMAGEST_PORT || env.PORT);
  if (env.ALMAGEST_BASE_URL) merged.service.http.base_url = env.ALMAGEST_BASE_URL;
  if (!merged.service.http.base_url) {
    merged.service.http.base_url = `http://${merged.service.http.host}:${merged.service.http.port}`;
  }

  const sources = raw.sources || {};
  const connectors = [
    ...expandEnv(sources.connectors || [], env),
    ...remoteAsConnectors(sources.remote),
    ...(overrides.connectors || []),
  ];

  const resolve = (p) => (p ? path.resolve(repoRoot, p) : '');

  const config = {
    repoRoot,
    v1,
    profile,
    service: merged.service,
    ingest: merged.ingest,
    governance: merged.governance,
    telemetry: merged.telemetry,
    mcp: merged.mcp || {},           // defaults live in server/src/mcp/config.mjs
    sources: { localPath: String(sources.local?.path || 'brain/raw'), connectors },
    agent: raw.agent || {},
    paths: {
      state: resolve('.almagest'),
      store: merged.service.store.driver === 'sqlite' ? resolve(merged.service.store.path) : '',
      worktrees: resolve(merged.service.git.worktree_dir),
      spool: resolve('.almagest/spool'),
      demand: resolve('.almagest/demand.tsv'),
      mcpJson: resolve('.mcp.json'),
    },
    /** Startup notices, logged by app.mjs and printed by doctor. */
    warnings,
  };
  const errors = validate ? configErrors(config) : [];
  if (errors.length) throw new Error(errors.join('\n'));
  return config;
}

/** The model a capability tier maps to on the configured harness, or '' when unmapped. */
export function modelForTier(config, tier) {
  const harness = config.agent?.harness;
  return String(config.agent?.profiles?.[harness]?.[tier] || '');
}
