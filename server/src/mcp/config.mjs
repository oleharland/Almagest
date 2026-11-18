/**
 * config.mjs — the `mcp:` section of brain.config.yaml, with defaults.
 *
 * Core passes the section through untouched (`ctx.config.mcp`); the defaults
 * live here, next to the code that reads them. docs/v2/mcp.md documents every
 * key.
 */
import { deepMerge } from '../core/config.mjs';

export const MCP_DEFAULTS = {
  stdio_role: 'owner',              // `almagest mcp` on your own clone, no ALMAGEST_TOKEN
  allow_anonymous: false,           // HTTP: unauthenticated requests become a read-only viewer
  allow_url_fetch: false,           // submit_source { url } — off unless turned on
  url_fetch: { max_bytes: 5 * 1024 * 1024, timeout_ms: 10_000, max_redirects: 5 },
  submit_max_bytes: 1024 * 1024,
  builtin_oauth: true,              // token mode only: OAuth 2.1 front door for claude.ai
  oauth: { access_token_ttl_seconds: 3600, refresh_token_ttl_seconds: 30 * 86400, code_ttl_seconds: 120, max_clients: 500 },
  allowed_origins: [],
  allowed_hosts: [],
  session_idle_minutes: 30,
  max_sessions: 500,
  refresh_seconds: 60,              // remote deployments (service.git.remote set): fetch + re-pin interval
  local_refresh_seconds: 10,        // re-check local main this often before answering
  git_webhook_secret_env: 'ALMAGEST_GIT_WEBHOOK_SECRET',
  search: { min_score: 0.2, min_coverage: 0.5, limit: 8 },
  ask: { token_budget: 2500, pages: 5 },
  get_page: { max_body_chars: 60_000, excerpt_chars: 400 },
  // Live lookup (docs/v2/live-lookup.md): when no reviewed page answers, look in source text, staged snapshots, then connectors; the `live` step reads current state from live connectors.
  lookup: {
    enabled: false,
    min_role: 'contributor',        // who may receive unreviewed passages (steps staged and connectors)
    steps: ['sources', 'staged', 'connectors', 'live'],
    timeout_ms: 8000,               // for the whole lookup
    max_fetch: 3,                   // documents fetched per question, across connectors
    send_query: true,               // false: the connectors step is off
    negative_ttl_minutes: 60,
    rate: { per_caller_per_minute: 6, per_connector_per_minute: 30 },
    ingest: 'auto',                 // auto | off
    max_ingest_per_day: 20,
  },
};

/**
 * How one `ask` budget (`ask.token_budget`, or the caller's max_tokens) is
 * shared when live lookup answers. The context sections `ask` returns for one
 * question (canonical pages, weak page matches, passages) together stay within
 * it. Passages get what the other two leave: 1 - canonical - weak (0.6 here).
 */
export const LOOKUP_BUDGET_SPLIT = { canonical: 0.25, weak: 0.15 };

export function mcpConfig(config) {
  return deepMerge(MCP_DEFAULTS, config.mcp || {});
}
