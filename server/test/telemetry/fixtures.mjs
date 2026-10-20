/**
 * fixtures.mjs — a minimal ctx for telemetry unit tests: memory store, real
 * bus, memory logger, a fake snapshot. Tests that need git use makeApp().
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBus } from '../../src/core/bus.mjs';
import { deepMerge } from '../../src/core/config.mjs';
import { createMemoryLogger } from '../../src/core/log.mjs';
import { createMemoryStore } from '../../src/core/store/memory.mjs';
import { createTelemetry } from '../../src/telemetry/index.mjs';

export const DAY = 86_400_000;
export const NOW = Date.parse('2026-06-01T12:00:00Z');
export const iso = (ms) => new Date(ms).toISOString();
export const daysAgo = (d, from = NOW) => iso(from - d * DAY);
export const minutesAgo = (m, from = NOW) => iso(from - m * 60_000);

/** A page shaped like loadWiki() output, only the fields telemetry reads. */
export function page(slug, extra = {}) {
  return { id: slug, slug, title: extra.title || slug.replace(/-/g, ' '), tier: 'curated', confidence: 'high', lastVerified: '2026-05-25', dateCreated: '2026-01-01', ...extra };
}

/**
 * @param {object} [options]
 * @param {object} [options.telemetry]  merged over the defaults
 * @param {object[]} [options.pages]
 * @param {object} [options.store]
 * @param {object} [options.ingest]
 * @param {() => number} [options.now]
 */
export function makeCtx({ telemetry = {}, pages = [], store, ingest, now = () => NOW } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-tel-'));
  const log = createMemoryLogger();
  const ctx = {
    config: {
      telemetry: deepMerge({
        enabled: true, store_queries: 'plain', store_actor: 'hashed', retention_days: 90,
        demand: { half_life_days: 14, hot_percentile: 90, min_score: 3 }, stale_after_days_hot: 30,
      }, telemetry),
      paths: { demand: path.join(dir, '.almagest', 'demand.tsv') },
    },
    store: store || createMemoryStore(),
    bus: createBus({ log }),
    log,
    snapshot: { load: async () => ({ sha: 'x', pages }) },
    ingest: ingest || { enqueue: async () => { throw new Error('ingest.enqueue is not implemented yet (Phase 0 stub)'); } },
    dir,
  };
  ctx.telemetry = createTelemetry(ctx, { now });
  return ctx;
}

/** Events straight into the store, bypassing record() — for scoring scenarios with fixed timestamps. */
export async function seed(store, events) {
  let i = 0;
  for (const e of events) {
    await store.events.append({ id: `evt_${String(i++).padStart(6, '0')}`, results: [], pagesRead: [], answered: null, ...e });
  }
}

export function read(slug, ts, sessionId) {
  return { tool: 'get_page', ts, pagesRead: [slug], ...(sessionId ? { sessionId } : {}) };
}
