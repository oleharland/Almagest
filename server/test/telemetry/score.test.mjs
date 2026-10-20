import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeDemand, contributions, decay, demandOptions, explainSlug, hotCapacity, rankDemand, rankDiscount, scoreEvents,
} from '../../src/telemetry/score.mjs';
import { daysAgo, minutesAgo, NOW } from './fixtures.mjs';

const OPTS = { now: NOW, ...demandOptions({}) };
let n = 0;
const evt = (e) => ({ id: `evt_${String(n++).padStart(6, '0')}`, results: [], pagesRead: [], ...e });
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const scoreOf = (events, slug, opts = OPTS) => scoreEvents(events, opts).get(slug)?.score ?? 0;

describe('demand score: the pieces', () => {
  it('decays by half every half-life', () => {
    assert.equal(decay(0, 14), 1);
    near(decay(14, 14), 0.5);
    near(decay(28, 14), 0.25);
    assert.equal(decay(-3, 14), 1, 'a future timestamp does not count extra');
  });

  it('discounts rank like DCG', () => {
    assert.equal(rankDiscount(1), 1);
    near(rankDiscount(2), 0.631);
    near(rankDiscount(3), 0.5);
    assert.equal(rankDiscount(0), 1);
  });

  it('weighs each tool as documented', () => {
    const w = demandOptions({}).weights;
    assert.deepEqual(contributions(evt({ tool: 'get_page', pagesRead: ['a'] }), { weights: w }), [{ slug: 'a', kind: 'read', base: 1, rank: null }]);
    assert.deepEqual(contributions(evt({ tool: 'resource', pagesRead: ['a'] }), { weights: w })[0].base, 1);
    const ask = contributions(evt({ tool: 'ask', results: [{ slug: 'a', rank: 1 }, { slug: 'b', rank: 3 }] }), { weights: w });
    near(ask[0].base, 0.6);
    near(ask[1].base, 0.3);
    const search = contributions(evt({ tool: 'search', results: [1, 2, 3, 4].map((r) => ({ slug: `s${r}`, rank: r })) }), { weights: w });
    assert.deepEqual(search.map((c) => c.slug), ['s1', 's2', 's3'], 'only the top 3 search hits count');
    near(search[0].base, 0.3);
    near(search[2].base, 0.15);
    assert.equal(contributions(evt({ tool: 'feedback', pagesRead: ['a'], helpful: true }), { weights: w })[0].base, 2);
    assert.equal(contributions(evt({ tool: 'feedback', pagesRead: ['a'], helpful: false }), { weights: w })[0].base, -1);
    assert.deepEqual(contributions(evt({ tool: 'feedback', pagesRead: ['a'] }), { weights: w }), [], 'no verdict, no signal');
    assert.deepEqual(contributions(evt({ tool: 'list_sources', pagesRead: ['a'] }), { weights: w }), [], 'unweighted tools score nothing');
  });

  it('lets config override a weight, or give a new tool one', () => {
    const o = demandOptions({ weights: { search: 0.5, export_page: 0.8 } });
    assert.equal(o.weights.search, 0.5);
    assert.equal(o.weights.get_page, 1);
    assert.equal(contributions(evt({ tool: 'export_page', pagesRead: ['a'] }), o)[0].base, 0.8);
    assert.throws(() => demandOptions({ half_life_days: 0 }), /half_life_days/);
  });
});

describe('demand score: aggregation', () => {
  it('sums decayed weights — the worked example in docs/v2/telemetry.md', () => {
    // Three reads today, an ask (rank 2) a half-life ago, a top search hit two half-lives ago.
    const events = [
      evt({ tool: 'get_page', ts: daysAgo(0), pagesRead: ['grid'], sessionId: 's1' }),
      evt({ tool: 'get_page', ts: daysAgo(0), pagesRead: ['grid'], sessionId: 's2' }),
      evt({ tool: 'get_page', ts: daysAgo(0), pagesRead: ['grid'], sessionId: 's3' }),
      evt({ tool: 'ask', ts: daysAgo(14), results: [{ slug: 'x', rank: 1 }, { slug: 'grid', rank: 2 }], sessionId: 's4' }),
      evt({ tool: 'search', ts: daysAgo(28), results: [{ slug: 'grid', rank: 1 }], sessionId: 's5' }),
    ];
    // 3 × 1.0 + 0.6 × 0.631 × 0.5 + 0.3 × 1 × 0.25 = 3 + 0.189 + 0.075
    near(scoreOf(events, 'grid'), 3.264);
    assert.equal(scoreEvents(events, OPTS).get('grid').distinctSessions, 5);
  });

  it('dedupes one session hammering one page inside 10 minutes, keeping the strongest signal', () => {
    const same = [0, 1, 2, 3, 9].map((m) => evt({ tool: 'get_page', ts: minutesAgo(30 - m), pagesRead: ['a'], sessionId: 's1' }));
    near(scoreOf(same, 'a'), 1, 0.01);
    assert.equal(scoreEvents(same, OPTS).get('a').deduped, 4);

    const mixed = [
      evt({ tool: 'search', ts: minutesAgo(10), results: [{ slug: 'a', rank: 1 }], sessionId: 's1' }),
      evt({ tool: 'get_page', ts: minutesAgo(8), pagesRead: ['a'], sessionId: 's1' }),
    ];
    near(scoreOf(mixed, 'a'), 1, 0.01);   // the read, not read + search

    const apart = [
      evt({ tool: 'get_page', ts: minutesAgo(30), pagesRead: ['a'], sessionId: 's1' }),
      evt({ tool: 'get_page', ts: minutesAgo(19), pagesRead: ['a'], sessionId: 's1' }),
    ];
    near(scoreOf(apart, 'a'), 2, 0.01);   // 11 minutes apart → two windows

    const anon = [0, 1].map(() => evt({ tool: 'get_page', ts: minutesAgo(5), pagesRead: ['a'] }));
    near(scoreOf(anon, 'a'), 2, 0.01);    // no session, no actor → no dedupe

    const byActor = [0, 1].map(() => evt({ tool: 'get_page', ts: minutesAgo(5), pagesRead: ['a'], actorId: 'h1' }));
    near(scoreOf(byActor, 'a'), 1, 0.01); // no session but one actor → one window
  });

  it('feedback adds and subtracts, latest verdict per window wins, and the total is clamped at 0', () => {
    const up = [evt({ tool: 'get_page', ts: daysAgo(0), pagesRead: ['a'], sessionId: 's1' }), evt({ tool: 'feedback', ts: daysAgo(0), pagesRead: ['a'], helpful: true, sessionId: 's1' })];
    near(scoreOf(up, 'a'), 3);   // a read and a feedback are different signals — both count
    const down = [evt({ tool: 'feedback', ts: daysAgo(0), pagesRead: ['a'], helpful: false, sessionId: 's1' })];
    assert.equal(scoreOf(down, 'a'), 0, 'negative alone clamps to 0');
    const s = scoreEvents(down, OPTS).get('a');
    assert.equal(s.negative, -1);
    assert.equal(s.distinctSessions, 0, 'a complaint is not a reader');
    const changedMind = [
      evt({ tool: 'feedback', ts: minutesAgo(5), pagesRead: ['a'], helpful: true, sessionId: 's1' }),
      evt({ tool: 'feedback', ts: minutesAgo(4), pagesRead: ['a'], helpful: false, sessionId: 's1' }),
      evt({ tool: 'get_page', ts: minutesAgo(3), pagesRead: ['a'], sessionId: 's2' }),
      evt({ tool: 'get_page', ts: minutesAgo(3), pagesRead: ['a'], sessionId: 's3' }),
    ];
    near(scoreOf(changedMind, 'a'), 1, 0.01);   // 2 reads − 1 (latest verdict)
  });
});

describe('demand ranking', () => {
  it('hot = top hot_percentile of all pages AND at or above min_score', () => {
    const pages = Array.from({ length: 20 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const scores = new Map([
      ['p00', { score: 10, distinctSessions: 4 }],
      ['p01', { score: 5, distinctSessions: 2 }],
      ['p02', { score: 4, distinctSessions: 2 }],
      ['p03', { score: 2.5, distinctSessions: 1 }],
    ]);
    assert.equal(hotCapacity(20, 90), 2);
    const r = rankDemand(scores, { pages, hotPercentile: 90, minScore: 3 });
    assert.deepEqual(r.hot, ['p00', 'p01'], 'p02 clears the floor but is outside the top 10%');
    assert.equal(r.population, 20);
    assert.equal(r.entries.find((e) => e.slug === 'p02').rank, 3);

    const floor = rankDemand(scores, { pages, hotPercentile: 50, minScore: 3 });
    assert.deepEqual(floor.hot, ['p00', 'p01', 'p02'], 'p03 is inside the top half but under min_score');

    const none = rankDemand(new Map(), { pages, hotPercentile: 90, minScore: 0 });
    assert.deepEqual(none.hot, [], 'a score of zero is never hot, whatever the floor');
  });

  it('a small wiki still has a hot page (capacity rounds up)', () => {
    assert.equal(hotCapacity(3, 90), 1);
    const r = rankDemand(new Map([['a', { score: 4, distinctSessions: 1 }]]), { pages: ['a', 'b', 'c'], hotPercentile: 90, minScore: 3 });
    assert.deepEqual(r.hot, ['a']);
  });

  it('breaks ties by distinct sessions, then slug', () => {
    const scores = new Map([['b', { score: 3, distinctSessions: 1 }], ['a', { score: 3, distinctSessions: 1 }], ['c', { score: 3, distinctSessions: 3 }]]);
    assert.deepEqual(rankDemand(scores, { hotPercentile: 0, minScore: 0 }).entries.map((e) => e.slug), ['c', 'a', 'b']);
  });

  it('computeDemand stamps computedAt and ranks scored slugs outside the page list', () => {
    const r = computeDemand([evt({ tool: 'get_page', ts: daysAgo(1), pagesRead: ['orphan'] })], { ...OPTS, pages: ['a'] });
    assert.equal(r.computedAt, new Date(NOW).toISOString());
    assert.equal(r.entries[0].slug, 'orphan');
    assert.equal(r.population, 2);
  });
});

describe('explain', () => {
  it('names the contributing events, counts per tool, dedupes, and the trend', () => {
    const events = [
      evt({ tool: 'get_page', ts: daysAgo(20), pagesRead: ['a'], sessionId: 'old' }),
      evt({ tool: 'get_page', ts: daysAgo(2), pagesRead: ['a'], sessionId: 's1' }),
      evt({ tool: 'get_page', ts: daysAgo(2), pagesRead: ['a'], sessionId: 's1' }),
      evt({ tool: 'search', ts: daysAgo(1), results: [{ slug: 'a', rank: 2 }], sessionId: 's2' }),
      evt({ tool: 'get_page', ts: daysAgo(1), pagesRead: ['other'], sessionId: 's2' }),
    ];
    const x = explainSlug(events, 'a', OPTS);
    assert.equal(x.events, 4);
    assert.equal(x.deduped, 1);
    assert.deepEqual(x.byTool.get_page.counted, 2);
    assert.deepEqual(x.byTool.get_page.deduped, 1);
    assert.equal(x.byTool.search.counted, 1);
    assert.equal(x.topContributors[0].tool, 'get_page');
    assert.equal(x.topContributors.length, 3);
    near(x.score, scoreOf(events, 'a'));
    assert.equal(x.trend.direction, 'rising');
    near(x.trend.current, 1 + 0.3 * rankDiscount(2));
    assert.equal(x.trend.previous, 1);
    assert.match(x.formula, /0\.5\^\(age_days \/ 14\)/);
  });
});
