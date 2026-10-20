import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, describe, it } from 'node:test';

import { createTelemetry, KV_NS, KV_REVERIFY_NS } from '../../src/telemetry/index.mjs';
import { renderDemandTsv } from '../../src/telemetry/export.mjs';
import { DAY, daysAgo, makeCtx, NOW, page, read, seed } from './fixtures.mjs';

const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function ctxFor(opts) { const c = makeCtx(opts); dirs.push(c.dir); return c; }

const PAGES = ['alpha', 'beta', 'gamma', 'delta', 'eps'].map((s) => page(s));
/** n reads of `slug`, each from its own session, `days` ago. */
const reads = (slug, n, days = 0) => Array.from({ length: n }, (_, i) => read(slug, daysAgo(days), `${slug}-${days}-${i}`));

describe('demand service', () => {
  it('ranks, caches in kv, and answers get() / hot() with zeros for unknown slugs', async () => {
    const ctx = ctxFor({ pages: PAGES });
    await seed(ctx.store, [...reads('alpha', 5), ...reads('beta', 2)]);
    const r = await ctx.demand.recompute();
    assert.deepEqual(r.hot, ['alpha']);
    assert.equal(r.population, 5);
    const m = await ctx.demand.get(['alpha', 'beta', 'nope']);
    assert.deepEqual(m.get('alpha'), { score: 5, rank: 1, hot: true });
    assert.deepEqual(m.get('beta'), { score: 2, rank: 2, hot: false });
    assert.deepEqual(m.get('nope'), { score: 0, rank: 0, hot: false });
    assert.deepEqual(await ctx.demand.hot(), ['alpha']);
    const cached = await ctx.store.kv.get(KV_NS, 'latest');
    assert.equal(cached.computedAt, new Date(NOW).toISOString());
    assert.deepEqual(cached.hot, ['alpha']);
    assert.ok(!JSON.stringify(cached).includes('query'), 'the cache holds aggregates only');
  });

  it('a fresh process reads the kv cache instead of recomputing', async () => {
    const ctx = ctxFor({ pages: PAGES });
    await ctx.store.kv.set(KV_NS, 'latest', { computedAt: 'then', population: 1, hot: ['cached'], entries: [{ slug: 'cached', score: 9, rank: 1, hot: true }] });
    assert.deepEqual(await ctx.demand.hot(), ['cached']);
  });

  it('get() computes on first use when nothing is cached', async () => {
    const ctx = ctxFor({ pages: PAGES });
    await seed(ctx.store, reads('gamma', 4));
    assert.deepEqual((await ctx.demand.get(['gamma'])).get('gamma'), { score: 4, rank: 1, hot: true });
  });

  it('emits demand.updated only when the hot list changes', async () => {
    const ctx = ctxFor({ pages: PAGES });
    const seen = [];
    ctx.bus.on('demand.updated', (p) => seen.push(p.hot));
    await ctx.demand.recompute();                         // nothing hot → nothing to say
    await seed(ctx.store, reads('alpha', 4));
    await ctx.demand.recompute();                         // alpha turns hot
    await seed(ctx.store, reads('alpha', 1));
    await ctx.demand.recompute();                         // score moved, hot list did not
    await ctx.bus.drain();
    assert.deepEqual(seen, [['alpha']]);
  });

  it('includes events recorded a moment ago (record → recompute flushes first)', async () => {
    const ctx = ctxFor({ pages: PAGES });
    for (let i = 0; i < 3; i++) ctx.telemetry.record({ tool: 'get_page', pagesRead: ['delta'], sessionId: `s${i}` });
    const r = await ctx.demand.recompute();
    assert.deepEqual(r.hot, ['delta']);
  });

  it('exports demand.tsv after a recompute, aggregates only, write-if-changed', async () => {
    const ctx = ctxFor({ pages: PAGES, telemetry: { store_queries: 'plain' } });
    await seed(ctx.store, [...reads('alpha', 4), { tool: 'search', ts: daysAgo(0), query: 'secret plans', results: [{ slug: 'beta', rank: 1 }] }]);
    const first = await ctx.demand.recompute();
    assert.equal(first.exported, true);
    const file = ctx.config.paths.demand;
    const text = fs.readFileSync(file, 'utf-8');
    assert.equal(text, 'slug\tscore\trank\thot\nalpha\t4.00\t1\ttrue\nbeta\t0.30\t2\tfalse\n');
    assert.ok(!text.includes('secret'));
    const mtime = fs.statSync(file).mtimeMs;
    const second = await ctx.demand.recompute();
    assert.equal(second.exported, false, 'unchanged bytes are not rewritten');
    assert.equal(fs.statSync(file).mtimeMs, mtime);
    assert.equal(renderDemandTsv([]), 'slug\tscore\trank\thot\n');
  });

  it('prunes events past retention_days', async () => {
    const ctx = ctxFor({ telemetry: { retention_days: 30 } });
    await seed(ctx.store, [read('a', daysAgo(45)), read('a', daysAgo(31)), read('a', daysAgo(29))]);
    assert.equal(await ctx.telemetry.prune(), 2);
    assert.equal((await ctx.store.events.query({})).length, 1);
    assert.equal((await ctx.store.kv.get('telemetry', 'lastPrune')).removed, 2);
  });

  it('only scores events inside the retention horizon', async () => {
    const ctx = ctxFor({ telemetry: { retention_days: 30 } });
    await seed(ctx.store, [...reads('old', 10, 40), ...reads('new', 1, 1)]);
    const r = await ctx.demand.recompute();
    assert.deepEqual(r.entries.map((e) => e.slug), ['new']);
  });

  it('explain() pairs the score with the cached rank and the hot rule', async () => {
    const ctx = ctxFor({ pages: PAGES });
    await seed(ctx.store, [...reads('alpha', 3), read('alpha', daysAgo(20), 'x')]);
    const x = await ctx.telemetry.explain('alpha');
    assert.equal(x.rank, 1);
    assert.equal(x.hot, true);
    assert.equal(x.byTool.get_page.counted, 4);
    assert.equal(x.trend.direction, 'rising');
    assert.deepEqual(x.hotRule, { percentile: 90, minScore: 3, population: 5 });
    const unknown = await ctx.telemetry.explain('nope');
    assert.equal(unknown.score, 0);
    assert.equal(unknown.rank, 0);
    assert.equal(unknown.events, 0);
  });

  it('start() / stop() run the recompute and prune timers, unref’d', async () => {
    const ctx = ctxFor({ pages: PAGES, telemetry: { recompute_seconds: 0.02 } });
    await seed(ctx.store, reads('beta', 4));
    const updated = ctx.bus.waitFor('demand.updated', (p) => p.hot.includes('beta'), 2000);
    await ctx.telemetry.start();
    await updated;
    await ctx.telemetry.stop();
    assert.ok(ctx.telemetry.stats().computedAt);
  });

  it('recomputes after a merge', async () => {
    const ctx = ctxFor({ pages: PAGES });
    await seed(ctx.store, reads('eps', 5));
    const updated = ctx.bus.waitFor('demand.updated', (p) => p.hot.includes('eps'), 3000);
    ctx.bus.emit('proposal.merged', { proposal: { id: 'prp_x' }, actor: null });
    await updated;
    await ctx.telemetry.stop();
  });
});

describe('auto_reverify', () => {
  const stale = [page('alpha', { lastVerified: '2026-01-01' }), page('beta'), page('canon', { tier: 'canonical', lastVerified: '2025-01-01' })];

  it('is off by default', async () => {
    const calls = [];
    const ctx = ctxFor({ pages: stale, ingest: { enqueue: async (j) => { calls.push(j); return { id: 'job_1' }; } } });
    await seed(ctx.store, reads('alpha', 5));
    await ctx.demand.recompute();
    assert.equal(calls.length, 0);
  });

  it('enqueues one reverify job per hot page per threshold window, never for canonical pages', async () => {
    let t = NOW;
    const calls = [];
    const ctx = ctxFor({
      pages: stale,
      now: () => t,
      telemetry: { auto_reverify: true, demand: { hot_percentile: 0 } },
      ingest: { enqueue: async (j) => { calls.push(j); return { id: `job_${calls.length}` }; } },
    });
    await seed(ctx.store, [...reads('alpha', 5), ...reads('canon', 5), ...reads('beta', 5)]);
    const r = await ctx.demand.recompute();
    assert.deepEqual(r.reverified, ['alpha']);
    assert.equal(calls[0].kind, 'reverify');
    assert.equal(calls[0].trigger, 'demand');
    assert.equal(calls[0].slug, 'alpha');
    assert.equal(calls[0].requestedBy, 'svc:telemetry');
    assert.match(calls[0].instructions, /\[\[alpha\]\].*days past the 30-day hot threshold/);
    assert.equal((await ctx.store.kv.get(KV_REVERIFY_NS, 'alpha')).jobId, 'job_1');

    await ctx.demand.recompute();
    assert.equal(calls.length, 1, 'not again inside the window');
    t += 31 * DAY;
    await seed(ctx.store, reads('alpha', 5, 0).map((e) => ({ ...e, ts: new Date(t).toISOString() })));
    await ctx.demand.recompute();
    assert.equal(calls.length, 2, 'again once the window has passed');
  });

  it('survives the Phase 0 ingest stub throwing, and retries next time', async () => {
    const ctx = ctxFor({ pages: stale, telemetry: { auto_reverify: true } });
    await seed(ctx.store, reads('alpha', 5));
    const r = await ctx.demand.recompute();
    assert.deepEqual(r.reverified, []);
    assert.equal(await ctx.store.kv.get(KV_REVERIFY_NS, 'alpha'), null);
    assert.ok(ctx.log.lines.some((l) => /reverify enqueue failed/.test(l.msg)));
  });
});

describe('createTelemetry config', () => {
  it('rejects an unknown privacy mode at startup', () => {
    const ctx = makeCtx();
    dirs.push(ctx.dir);
    ctx.config.telemetry.store_queries = 'sometimes';
    assert.throws(() => createTelemetry(ctx), /store_queries/);
  });
});
