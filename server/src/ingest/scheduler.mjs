/**
 * scheduler.mjs — the `schedule` trigger. Each connector with a `schedule`
 * gets `ctx.connectors.sync(id)` when its cron fires, and every SourceRef that
 * comes back becomes one ingest job.
 *
 * One timer for all connectors, re-armed at each minute boundary. A connector
 * whose previous sync is still running is skipped rather than stacked: a slow
 * provider should cost one late sync, not a pile of concurrent ones. The fire
 * time is remembered per minute so a timer that wakes twice in the same
 * minute does not sync twice.
 */
import { parseCron } from './cron.mjs';

export function createScheduler(ctx, { enqueue, now = () => new Date() }) {
  const { log } = ctx;
  let timer = null;
  let entries = [];
  const inflight = new Set();
  const lastFired = new Map();

  async function connectors() {
    try {
      const list = await ctx.connectors.list();
      if (Array.isArray(list)) return list;
    } catch { /* stub or not ready — config is the fallback */ }
    return ctx.config.sources.connectors || [];
  }

  async function fire(entry) {
    if (inflight.has(entry.id)) {
      log.warn('schedule: previous sync still running — skipped', { connector: entry.id });
      return [];
    }
    inflight.add(entry.id);
    const jobs = [];
    try {
      const refs = (await ctx.connectors.sync(entry.id)) || [];
      for (const ref of refs) {
        try {
          jobs.push(await enqueue({ kind: 'ingest', source: ref, trigger: 'schedule', requestedBy: 'svc:ingest' }));
        } catch (err) {
          log.error('schedule: enqueue failed', { connector: entry.id, ref: ref?.id, error: err.message });
        }
      }
      log.info('schedule: synced', { connector: entry.id, items: refs.length });
    } catch (err) {
      log.error('schedule: sync failed', { connector: entry.id, error: err.message });
    } finally {
      inflight.delete(entry.id);
    }
    return jobs;
  }

  /** Fire every connector whose cron matches `at`. Exposed for tests. */
  async function tick(at = now()) {
    const minute = Math.floor(at.getTime() / 60000);
    const due = entries.filter((e) => e.cron.matches(at) && lastFired.get(e.id) !== minute);
    for (const e of due) lastFired.set(e.id, minute);
    return (await Promise.all(due.map(fire))).flat();
  }

  function arm() {
    const at = now();
    const delay = 60000 - (at.getSeconds() * 1000 + at.getMilliseconds()) + 50;
    timer = setTimeout(async () => {
      try { await tick(); } finally { if (timer) arm(); }
    }, delay);
    timer.unref?.();
  }

  return {
    async start() {
      entries = [];
      for (const c of await connectors()) {
        if (!c?.schedule) continue;
        try { entries.push({ id: c.id, cron: parseCron(c.schedule) }); }
        catch (err) { log.error('schedule: bad cron — connector will not sync on a schedule', { connector: c.id, error: err.message }); }
      }
      if (entries.length) {
        log.info('scheduler started', { connectors: entries.map((e) => `${e.id} (${e.cron.expr})`) });
        arm();
      }
      return entries.length;
    },
    stop() {
      clearTimeout(timer);
      timer = null;
    },
    tick,
    fire,
    get entries() { return entries; },
  };
}
