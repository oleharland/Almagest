import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clusterGaps, isHit, isMiss, jaccard } from '../../src/telemetry/gaps.mjs';
import { daysAgo, makeCtx, NOW } from './fixtures.mjs';

describe('gaps: pure clustering', () => {
  it('knows a miss from a hit', () => {
    assert.ok(isMiss({ tool: 'search', answered: false, results: [{ slug: 'a' }] }));
    assert.ok(isMiss({ tool: 'ask', answered: null, results: [] }));
    assert.ok(isMiss({ tool: 'report_gap' }));
    assert.ok(!isMiss({ tool: 'get_page', answered: false }));
    assert.ok(isHit({ tool: 'search', answered: null, results: [{ slug: 'a' }] }));
    assert.ok(!isHit({ tool: 'search', answered: false, results: [{ slug: 'a' }] }));
    assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
    assert.equal(jaccard([], []), 0);
  });

  it('clusters similar questions, picks the commonest phrasing, and writes a suggestion', async () => {
    const ctx = makeCtx();
    const ask = (query, days, sessionId, extra = {}) =>
      ctx.telemetry.record({ tool: 'search', query, results: [], answered: false, sessionId, ts: daysAgo(days), ...extra });
    ask('grid connection fee', 13, 's1');
    ask('Grid connection fees?', 9, 's2');
    ask('grid connection fee', 3, 's3');
    ctx.telemetry.record({ tool: 'report_gap', query: 'what is the grid connection fee', ts: daysAgo(2), sessionId: 's3' });
    ask('battery warranty terms', 1, 's4');
    ask('pizza', 1, 's5', { answered: true, results: [{ slug: 'menu', rank: 1 }] });

    const gaps = await ctx.telemetry.gaps();
    assert.equal(gaps.length, 2);
    const [grid, battery] = gaps;
    assert.equal(grid.count, 4);
    assert.equal(grid.distinctSessions, 3);
    assert.deepEqual(grid.tokens, ['connection', 'fee', 'grid']);
    assert.equal(grid.representative, 'grid connection fee');
    assert.deepEqual(grid.queries[0], { text: 'grid connection fee', count: 2 });
    assert.deepEqual(grid.tools, { search: 3, report_gap: 1 });
    assert.equal(grid.suggestion, 'No page covers "grid connection fee" — 4 requests in 13 days from 3 sessions; consider submitting a source.');
    assert.match(grid.cluster, /^gap_[0-9a-f]{12}$/);
    assert.equal(battery.count, 1);
    assert.match(battery.suggestion, /1 request in 1 day;/);
  });

  it('keeps dissimilar questions apart, and respects the threshold', () => {
    const e = (id, q, tokens) => ({ id, ts: daysAgo(1), tool: 'search', answered: false, results: [], query: q, queryTokens: tokens });
    const events = [e('1', 'grid fee', ['fee', 'grid']), e('2', 'grid capacity', ['capacity', 'grid'])];
    assert.equal(clusterGaps(events, { now: NOW, similarity: 0.5 }).length, 2);  // 1/3 < 0.5
    assert.equal(clusterGaps(events, { now: NOW, similarity: 0.3 }).length, 1);
  });

  it('an answered, similar question closes the gap; a later miss reopens it', () => {
    const miss = (id, days) => ({ id, ts: daysAgo(days), tool: 'search', answered: false, results: [], query: 'grid fee', queryTokens: ['fee', 'grid'] });
    const hit = { id: 'h', ts: daysAgo(2), tool: 'search', answered: true, results: [{ slug: 'grid-fee', rank: 1 }], query: 'grid fees', queryTokens: ['fee', 'grid'] };
    assert.equal(clusterGaps([miss('a', 5), miss('b', 4), hit], { now: NOW }).length, 0, 'answered → decays out');
    const reopened = clusterGaps([miss('a', 5), miss('b', 4), hit, miss('c', 1)], { now: NOW });
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0].count, 1);
    assert.equal(reopened[0].reopenedAfter, hit.ts);
  });

  it('hashed mode shows counts and tokens, never query text', async () => {
    const ctx = makeCtx({ telemetry: { store_queries: 'hashed' } });
    ctx.telemetry.record({ tool: 'ask', query: 'Grid connection fee', answered: false, sessionId: 'a' });
    ctx.telemetry.record({ tool: 'ask', query: 'grid connection fees', answered: false, sessionId: 'b' });
    const [g] = await ctx.telemetry.gaps();
    assert.equal(g.count, 2);
    assert.deepEqual(g.queries, []);
    assert.deepEqual(g.tokens, ['connection', 'fee', 'grid']);
    assert.equal(g.representative, 'connection fee grid');
    assert.ok(!JSON.stringify(g).includes('Grid connection fee'));
  });

  it('hashed tokens cluster but show nothing readable; none disables gaps', async () => {
    const hashed = makeCtx({ telemetry: { store_queries: 'hashed', store_tokens: 'hashed' } });
    hashed.telemetry.record({ tool: 'ask', query: 'grid connection fee', answered: false });
    hashed.telemetry.record({ tool: 'ask', query: 'grid connection fees', answered: false });
    const [g] = await hashed.telemetry.gaps();
    assert.equal(g.count, 2);
    assert.deepEqual(g.tokens, []);
    assert.equal(g.representative, null);
    assert.match(g.suggestion, /^An unanswered question \(cluster of 3 hashed tokens\) — 2 requests/);

    const none = makeCtx({ telemetry: { store_queries: 'none' } });
    none.telemetry.record({ tool: 'ask', query: 'grid connection fee', answered: false });
    assert.deepEqual(await none.telemetry.gaps(), []);
  });

  it('honours since and limit', async () => {
    const ctx = makeCtx();
    ctx.telemetry.record({ tool: 'search', query: 'old question here', answered: false, ts: daysAgo(40) });
    ctx.telemetry.record({ tool: 'search', query: 'alpha beta', answered: false, ts: daysAgo(1) });
    ctx.telemetry.record({ tool: 'search', query: 'gamma delta', answered: false, ts: daysAgo(1) });
    assert.equal((await ctx.telemetry.gaps()).length, 2, 'default window is 30 days');
    assert.equal((await ctx.telemetry.gaps({ since: daysAgo(60) })).length, 3);
    assert.equal((await ctx.telemetry.gaps({ limit: 1 })).length, 1);
  });
});
