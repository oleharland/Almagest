/**
 * telemetry — WS5. Spec: docs/v2/spec.md → Telemetry and demand; the long
 * form, with the formula worked through and the privacy guidance, is
 * docs/v2/telemetry.md.
 *
 *   ctx.telemetry  .record(partial) → void        never throws, never blocks
 *                  .explain(slug)                 which events produced a page's score
 *                  .gaps({ limit, since })        clustered unanswered questions
 *                  .reverifyQueue()               hot pages due a re-check
 *                  .recompute() .prune() .flush() .stats() .start() .stop()
 *   ctx.demand     .get(slugs) → Map<slug, { score, rank, hot }>   .hot() → [slug]   .top(n)
 *
 * Every number here is a deterministic function of the event log and main's
 * pages. Demand is "learned" only in the sense that a decayed count is: there
 * is no model, and `explain()` can always say why.
 */
import { buildEvent, privacyOf } from './events.mjs';
import { renderDemandTsv, writeIfChanged } from './export.mjs';
import { clusterGaps } from './gaps.mjs';
import { createRecorder } from './recorder.mjs';
import { buildReverifyQueue } from './reverify.mjs';
import { computeDemand, DAY_MS, demandOptions, explainSlug } from './score.mjs';
import { registerRoutes } from './http.mjs';
import { commands as cliCommands } from './cli.mjs';

export const KV_NS = 'demand';
export const KV_REVERIFY_NS = 'demand.reverify';
export const SERVICE_ACTOR = 'svc:telemetry';

const ZERO = Object.freeze({ score: 0, rank: 0, hot: false });

function sameList(a = [], b = []) {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

/** The resolved `telemetry:` block — config values over the module's defaults. */
export function telemetrySettings(telemetry = {}) {
  return {
    enabled: telemetry.enabled !== false,
    privacy: privacyOf(telemetry),
    demand: demandOptions(telemetry.demand),
    retentionDays: Number(telemetry.retention_days ?? 90),
    staleAfterDaysHot: Number(telemetry.stale_after_days_hot ?? 30),
    recomputeMs: Math.max(1, Number(telemetry.recompute_seconds ?? 300)) * 1000,
    autoReverify: telemetry.auto_reverify === true,
    bufferSize: Number(telemetry.buffer_size ?? 1000),
    gaps: {
      similarity: Number(telemetry.gaps?.similarity ?? 0.5),
      windowDays: Number(telemetry.gaps?.window_days ?? 30),
      minCount: Number(telemetry.gaps?.min_count ?? 1),
    },
  };
}

/**
 * @param {object} ctx   the composition-root ctx (config, store, bus, log, http, snapshot; ingest read lazily)
 * @param {object} [options]
 * @param {() => number} [options.now]   clock, epoch ms — tests pin it
 */
export function createTelemetry(ctx, { now = () => Date.now() } = {}) {
  const { config, store, bus, snapshot } = ctx;
  const log = ctx.log?.child ? ctx.log.child({ module: 'telemetry' }) : ctx.log;
  const settings = telemetrySettings(config.telemetry);
  const { enabled } = settings;
  const exportPath = config.paths?.demand || '';

  const recorder = createRecorder({
    store,
    log,
    maxBuffer: settings.bufferSize,
    build: (partial) => buildEvent(partial, { privacy: settings.privacy, now: now() }),
  });

  let latest = null;                 // { computedAt, population, hot, entries }
  let bySlug = new Map();
  let cacheLoaded = false;
  let inflight = null;
  const timers = [];
  let mergeTimer = null;

  const isoAgo = (nowMs, days) => new Date(nowMs - days * DAY_MS).toISOString();

  function setLatest(record) {
    latest = record;
    bySlug = new Map(record.entries.map((e) => [e.slug, e]));
  }

  async function loadCache() {
    if (cacheLoaded) return;
    cacheLoaded = true;
    try {
      const cached = await store.kv.get(KV_NS, 'latest');
      if (cached && Array.isArray(cached.entries)) setLatest(cached);
    } catch (err) {
      log?.warn('demand cache unreadable', { error: err.message });
    }
  }

  /** main's pages, or null when there is no snapshot to read (no git, tests). */
  async function mainPages() {
    try {
      return (await snapshot.load()).pages;
    } catch (err) {
      log?.debug('snapshot unavailable; demand ranks scored slugs only', { error: err.message });
      return null;
    }
  }

  function eventsSince(nowMs, extra = {}) {
    return store.events.query({ since: isoAgo(nowMs, settings.retentionDays), ...extra });
  }

  async function exportTsv(record) {
    if (!exportPath) return false;
    try {
      return writeIfChanged(exportPath, renderDemandTsv(record.entries));
    } catch (err) {
      log?.warn('demand export failed', { file: exportPath, error: err.message });
      return false;
    }
  }

  async function autoReverify(record, pages, nowMs) {
    const queue = buildReverifyQueue({ entries: record.entries, pages: pages || [], now: nowMs, staleAfterDays: settings.staleAfterDaysHot });
    const enqueued = [];
    for (const item of queue) {
      // Canonical pages change by human edit only; an agent job could not touch them.
      if (item.tier === 'canonical') continue;
      const mark = await store.kv.get(KV_REVERIFY_NS, item.slug);
      if (mark && nowMs - new Date(mark.at).getTime() < settings.staleAfterDaysHot * DAY_MS) continue;
      try {
        const job = await ctx.ingest.enqueue({
          kind: 'reverify',
          source: null,
          slug: item.slug,
          trigger: 'demand',
          requestedBy: SERVICE_ACTOR,
          instructions: `Re-verify [[${item.slug}]] against its cited sources and update last_verified. ` +
            `Why now: ${item.reason}. Demand score ${item.score}, rank ${item.rank}.`,
        });
        await store.kv.set(KV_REVERIFY_NS, item.slug, { at: new Date(nowMs).toISOString(), jobId: job?.id ?? null, reason: item.reason });
        enqueued.push(item.slug);
      } catch (err) {
        // The Phase 0 ingest stub throws; so does a real one with its queue down.
        // Not marked, so the next recompute tries again.
        log?.warn('reverify enqueue failed', { slug: item.slug, error: err.message });
        break;
      }
    }
    return enqueued;
  }

  async function recompute({ reason = 'manual' } = {}) {
    if (!enabled) return { computedAt: new Date(now()).toISOString(), population: 0, hot: [], entries: [], changed: false };
    if (inflight) return inflight;
    inflight = (async () => {
      await loadCache();
      await recorder.flush();
      const nowMs = now();
      const [events, pages] = await Promise.all([eventsSince(nowMs), mainPages()]);
      const result = computeDemand(events, { now: nowMs, pages: pages ? pages.map((p) => p.id) : [], ...settings.demand });
      const record = {
        computedAt: result.computedAt,
        population: result.population,
        hot: result.hot,
        // Only scored pages are kept: a page with no demand reads as zeros either way.
        entries: result.entries
          .filter((e) => e.score > 0)
          .map(({ slug, score, rank, hot, distinctSessions }) => ({ slug, score, rank, hot, distinctSessions })),
      };
      const changed = !sameList(latest?.hot, record.hot);
      try {
        await store.kv.set(KV_NS, 'latest', record);
      } catch (err) {
        log?.warn('demand cache write failed', { error: err.message });
      }
      setLatest(record);
      if (changed) bus?.emit('demand.updated', { hot: [...record.hot] });
      const exported = await exportTsv(record);
      const reverified = settings.autoReverify ? await autoReverify(record, pages, nowMs) : [];
      log?.debug('demand recomputed', { reason, events: events.length, hot: record.hot.length, changed, exported });
      return { ...record, changed, exported, reverified };
    })().finally(() => { inflight = null; });
    return inflight;
  }

  async function ensureLatest() {
    await loadCache();
    if (!latest) await recompute({ reason: 'first read' });
    return latest;
  }

  async function prune() {
    if (!enabled) return 0;
    const nowMs = now();
    const before = isoAgo(nowMs, settings.retentionDays);
    try {
      const removed = await store.events.prune(before);
      await store.kv.set('telemetry', 'lastPrune', { at: new Date(nowMs).toISOString(), before, removed });
      log?.debug('events pruned', { before, removed });
      return removed;
    } catch (err) {
      log?.warn('event prune failed', { error: err.message });
      return 0;
    }
  }

  const telemetry = {
    enabled,
    settings,

    /** Spec: never throws, never blocks. Returns nothing on purpose. */
    record(partial) {
      if (!enabled) return;
      recorder.record(partial);
    },

    flush: () => recorder.flush(),
    stats: () => ({ enabled, ...recorder.stats(), computedAt: latest?.computedAt ?? null, hot: latest?.hot.length ?? 0 }),
    recompute,
    prune,

    async explain(slug) {
      const cached = enabled ? (await ensureLatest(), bySlug.get(slug)) : null;
      const nowMs = now();
      const events = enabled ? (await recorder.flush(), await eventsSince(nowMs, { slug })) : [];
      const detail = explainSlug(events, slug, { now: nowMs, ...settings.demand });
      return {
        ...detail,
        rank: cached?.rank ?? 0,
        hot: cached?.hot ?? false,
        distinctSessions: cached?.distinctSessions ?? 0,
        computedAt: latest?.computedAt ?? null,
        hotRule: { percentile: settings.demand.hotPercentile, minScore: settings.demand.minScore, population: latest?.population ?? 0 },
      };
    },

    async gaps({ limit = 20, since } = {}) {
      if (!enabled) return [];
      await recorder.flush();
      const nowMs = now();
      const from = since ? new Date(since).toISOString() : isoAgo(nowMs, settings.gaps.windowDays);
      const events = await store.events.query({ since: from });
      return clusterGaps(events, {
        now: nowMs,
        limit: Number(limit) || 20,
        similarity: settings.gaps.similarity,
        minCount: settings.gaps.minCount,
        showQueries: settings.privacy.queries === 'plain',
      });
    },

    async reverifyQueue() {
      if (!enabled) return [];
      const record = await ensureLatest();
      const pages = (await mainPages()) || [];
      return buildReverifyQueue({ entries: record.entries, pages, now: now(), staleAfterDays: settings.staleAfterDaysHot });
    },

    async start() {
      if (!enabled || timers.length) return;
      await loadCache();
      const every = (ms, fn) => {
        const t = setInterval(() => fn().catch((err) => log?.error('telemetry timer failed', { error: err.message })), ms);
        t.unref?.();
        timers.push(t);
      };
      every(settings.recomputeMs, () => recompute({ reason: 'interval' }));
      every(DAY_MS, prune);
      // First pass in the background: start() must not wait on a full event scan.
      const first = setTimeout(() => { prune().then(() => recompute({ reason: 'start' })).catch(() => {}); }, 0);
      first.unref?.();
      timers.push(first);
    },

    async stop() {
      for (const t of timers.splice(0)) { clearInterval(t); clearTimeout(t); }
      if (mergeTimer) { clearTimeout(mergeTimer); mergeTimer = null; }
      await recorder.flush().catch(() => {});
      await inflight?.catch(() => {});
    },
  };

  ctx.demand = {
    async get(slugs = []) {
      const list = [...slugs];
      if (!enabled) return new Map(list.map((s) => [s, { ...ZERO }]));
      await ensureLatest();
      return new Map(list.map((s) => {
        const e = bySlug.get(s);
        return [s, e ? { score: e.score, rank: e.rank, hot: e.hot } : { ...ZERO }];
      }));
    },
    async hot() {
      if (!enabled) return [];
      return [...(await ensureLatest()).hot];
    },
    async top(n = 20) {
      if (!enabled) return [];
      return (await ensureLatest()).entries.slice(0, n).map((e) => ({ ...e }));
    },
    recompute,
  };

  // A merge moves main: new pages, new last_verified stamps. Recompute shortly
  // after (the snapshot refreshes itself on the same event), coalescing bursts.
  if (enabled && bus) {
    bus.on('proposal.merged', () => {
      if (mergeTimer) return;
      mergeTimer = setTimeout(() => {
        mergeTimer = null;
        recompute({ reason: 'merge' }).catch((err) => log?.warn('recompute after merge failed', { error: err.message }));
      }, 1000);
      mergeTimer.unref?.();
    });
  }

  if (ctx.http) registerRoutes(ctx.http, { telemetry, demand: ctx.demand });
  return telemetry;
}

export async function create(ctx) {
  return createTelemetry(ctx);
}

export const commands = cliCommands;
