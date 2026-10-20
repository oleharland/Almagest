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
};

export function mcpConfig(config) {
  return deepMerge(MCP_DEFAULTS, config.mcp || {});
}
