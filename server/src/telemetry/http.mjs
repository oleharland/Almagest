/**
 * http.mjs — the demand API. Read-only, any authenticated actor: demand is
 * aggregate data, and in hashed mode the gap list carries no query text.
 *
 *   GET /api/demand?top=N      ranked pages (top N, default 20) + the hot list
 *   GET /api/demand/:slug      explain one page's score
 *   GET /api/gaps?limit&since  clustered unanswered questions
 *   GET /api/reverify          hot pages due a re-check, most urgent first
 *
 * `?refresh=1` on /api/demand recomputes before answering.
 */
import { HttpError } from '../core/http.mjs';

function intParam(value, fallback, max = 1000) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `expected a positive integer, got "${value}"`);
  return Math.min(n, max);
}

export function registerRoutes(http, { telemetry, demand }) {
  http.route('GET', '/api/demand', async (_req, _res, { query }) => {
    const top = intParam(query.top, 20);
    if (query.refresh === '1' || query.refresh === 'true') await demand.recompute({ reason: 'api' });
    const entries = await demand.top(top);
    const stats = telemetry.stats();
    return { enabled: telemetry.enabled, computedAt: stats.computedAt, hot: await demand.hot(), top: entries };
  }, { auth: 'any' });

  http.route('GET', '/api/demand/:slug', async (_req, _res, { params }) => telemetry.explain(params.slug), { auth: 'any' });

  http.route('GET', '/api/gaps', async (_req, _res, { query }) => {
    if (query.since && Number.isNaN(new Date(query.since).getTime())) throw new HttpError(400, `since is not a date: "${query.since}"`);
    return { gaps: await telemetry.gaps({ limit: intParam(query.limit, 20), since: query.since || undefined }) };
  }, { auth: 'any' });

  http.route('GET', '/api/reverify', async () => ({ queue: await telemetry.reverifyQueue() }), { auth: 'any' });
}
