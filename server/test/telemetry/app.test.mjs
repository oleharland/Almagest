/**
 * Telemetry wired the way the composition root wires it: a real git repo, the
 * real snapshot of main, the real router and token auth, every other module a
 * Phase 0 stub.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { commands, createTelemetry } from '../../src/telemetry/index.mjs';
import { makeApp, makeTempRepo, rmrf } from '../helpers.mjs';
import { DAY, NOW, seed } from './fixtures.mjs';

const TOKEN = 'tel-test-token';

function wikiPage(slug, { title, confidence = 'high', lastVerified, created = '2025-01-01' }) {
  return [
    '---',
    `title: "${title}"`,
    'type: topic',
    'tier: curated',
    'origin: self',
    'status: draft',
    `confidence: ${confidence}`,
    `date_created: "${created}"`,
    ...(lastVerified ? [`last_verified: "${lastVerified}"`] : []),
    'sources: []',
    '---',
    '',
    '## Basis',
    '',
    '- [[alpha]]',
    '',
  ].join('\n');
}

const reads = (slug, n) => Array.from({ length: n }, (_, i) => ({ tool: 'get_page', ts: new Date(NOW).toISOString(), pagesRead: [slug], sessionId: `${slug}-${i}` }));

describe('telemetry through ctx', () => {
  let repo;
  let app;
  let base;
  let server;
  const prevTokens = process.env.ALMAGEST_TOKENS;

  before(async () => {
    process.env.ALMAGEST_TOKENS = `ada:viewer:${TOKEN}`;
    repo = makeTempRepo({
      files: {
        'brain/wiki/ancient.md': wikiPage('ancient', { title: 'Ancient', lastVerified: '2025-06-01' }),
        'brain/wiki/shaky.md': wikiPage('shaky', { title: 'Shaky', confidence: 'low', lastVerified: '2026-05-30' }),
        'brain/wiki/never.md': wikiPage('never', { title: 'Never verified', confidence: 'medium', created: '2026-04-01' }),
      },
    });
    app = await makeApp({
      repoRoot: repo,
      modules: { telemetry: { create: (ctx) => createTelemetry(ctx, { now: () => NOW }), commands } },
      overrides: {
        service: { http: { port: 0 } },
        telemetry: { demand: { hot_percentile: 0, min_score: 3 } },
      },
    });
    // alpha (fixture, last_verified 2026-01-05): 10 × 117 overdue = 1170
    // ancient (2025-06-01): 4 × 335 = 1340  ·  never (created 2026-04-01): 3 × 31 = 93
    // shaky (fresh, low): 8 × 1  ·  beta: no demand, not hot
    await seed(app.ctx.store, [...reads('alpha', 10), ...reads('ancient', 4), ...reads('shaky', 8), ...reads('never', 3)]);
    server = await app.start();
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await app?.stop();
    if (prevTokens === undefined) delete process.env.ALMAGEST_TOKENS;
    else process.env.ALMAGEST_TOKENS = prevTokens;
    rmrf(repo);
  });

  const get = (path, token = TOKEN) => fetch(`${base}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

  it('ranks against main’s pages (the population includes unread pages)', async () => {
    const r = await app.ctx.demand.recompute();
    assert.equal(r.population, 6);   // alpha beta gamma-claim + ancient shaky never
    assert.deepEqual([...r.hot].sort(), ['alpha', 'ancient', 'never', 'shaky']);
    assert.equal(fs.readFileSync(app.ctx.config.paths.demand, 'utf-8').split('\n')[1], 'alpha\t10.00\t1\ttrue');
  });

  it('orders the re-verify queue by score × overdue days, with reasons', async () => {
    const q = await app.ctx.telemetry.reverifyQueue();
    assert.deepEqual(q.map((x) => x.slug), ['ancient', 'alpha', 'never', 'shaky']);
    const [ancient, alpha, never, shaky] = q;
    assert.equal(ancient.overdueDays, 335);
    assert.equal(ancient.priority, 4 * 335);
    assert.equal(ancient.title, 'Ancient');
    assert.equal(alpha.lastVerified, '2026-01-05');
    assert.equal(alpha.overdueDays, Math.floor((NOW - Date.parse('2026-01-05T00:00:00Z')) / DAY) - 30);
    assert.match(alpha.reason, /days past the 30-day hot threshold/);
    assert.equal(never.reason, 'never verified');
    assert.equal(never.overdueDays, 61 - 30, 'never verified counts from date_created');
    assert.equal(never.lastVerified, null);
    assert.equal(shaky.reason, 'confidence: low');
    assert.ok(shaky.overdueDays <= 0);
    assert.ok(!q.some((x) => x.slug === 'beta'), 'not hot → not queued');
  });

  it('serves the demand API to any authenticated actor', async () => {
    assert.equal((await get('/api/demand', null)).status, 401);

    const demand = await (await get('/api/demand?top=2')).json();
    assert.equal(demand.top.length, 2);
    assert.equal(demand.top[0].slug, 'alpha');
    assert.ok(demand.hot.includes('alpha'));
    assert.equal(demand.enabled, true);
    assert.equal((await get('/api/demand?top=zero')).status, 400);

    const explain = await (await get('/api/demand/alpha')).json();
    assert.equal(explain.slug, 'alpha');
    assert.equal(explain.score, 10);
    assert.equal(explain.rank, 1);
    assert.equal(explain.byTool.get_page.counted, 10);

    const reverify = await (await get('/api/reverify')).json();
    assert.equal(reverify.queue[0].slug, 'ancient');

    app.ctx.telemetry.record({ tool: 'search', query: 'grid connection fee', answered: false, results: [] });
    const gaps = await (await get('/api/gaps?limit=5')).json();
    assert.equal(gaps.gaps.length, 1);
    assert.equal(gaps.gaps[0].representative, 'grid connection fee');
    assert.equal((await get('/api/gaps?since=yesterday-ish')).status, 400);
  });

  it('CLI commands print tables (and JSON with --json)', async () => {
    let out = '';
    const env = { ctx: app.ctx, stdout: (s) => { out += s; }, stderr: (s) => { out += s; } };
    assert.equal(await commands.demand.run(['--top', '3'], env), 0);
    assert.match(out, /rank\s+slug\s+score\s+sessions\s+hot/);
    assert.match(out, /1\s+alpha\s+10\.00\s+10\s+hot/);
    assert.match(out, /hot of 6 page\(s\)/);

    out = '';
    assert.equal(await commands.reverify.run([], env), 0);
    assert.match(out.split('\n')[2], /^ancient\s+4\.00\s+2025-06-01\s+335d/);

    out = '';
    assert.equal(await commands.gaps.run(['--json'], env), 0);
    assert.equal(JSON.parse(out).gaps[0].count, 1);

    out = '';
    assert.equal(await commands.demand.run(['--bogus'], env), 2);
    assert.match(out, /unknown argument/);
    for (const c of Object.values(commands)) assert.equal(c.needsApp, true);
  });
});
