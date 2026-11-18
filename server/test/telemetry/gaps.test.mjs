import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { commands } from '../../src/telemetry/cli.mjs';
import { clusterGaps, isHit, isMiss, jaccard, markCovered } from '../../src/telemetry/gaps.mjs';
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

/** A gap as gaps() returns it: a readable one has a representative and plain queries; a hashed one has neither. */
const readable = (cluster, text, count = 1) => ({ cluster, representative: text, queries: [{ text, count }], tokens: text.split(' '), count, distinctSessions: 1, tools: {}, firstSeen: '2026-11-01T00:00:00.000Z', lastSeen: '2026-11-02T00:00:00.000Z', lookup: null, suggestion: `s ${cluster}` });
const hashed = (cluster) => ({ cluster, representative: null, queries: [], tokens: [], count: 2, distinctSessions: 1, tools: {}, firstSeen: '2026-11-01T00:00:00.000Z', lastSeen: '2026-11-02T00:00:00.000Z', lookup: null, suggestion: `s ${cluster}` });

describe('gaps: markCovered', () => {
  const ANSWERS = {
    'what is almagest': { answered: true, results: [{ slug: 'almagest', title: 'Almagest' }, { slug: 'overview', title: 'Overview' }, { slug: 'extra', title: 'Extra' }] },
    'battery warranty terms': { answered: false, results: [{ slug: 'battery', title: 'Battery' }] },
    'grid fee': { answered: true, results: [] },
  };
  const answer = async (q) => ANSWERS[q] || { answered: false, results: [] };

  it('marks an answered gap with its top two results, and leaves the others unmarked', async () => {
    const gaps = [readable('gap_a', 'what is almagest'), readable('gap_b', 'battery warranty terms')];
    const out = await markCovered(gaps, answer);
    assert.equal(out.length, 2, 'never removes a gap');
    const a = out.find((g) => g.cluster === 'gap_a');
    assert.deepEqual(a.coveredBy, [{ slug: 'almagest', title: 'Almagest' }, { slug: 'overview', title: 'Overview' }]);
    const b = out.find((g) => g.cluster === 'gap_b');
    assert.ok(!('coveredBy' in b), 'absent, not empty');
  });

  it('does not mark an answer that says answered with no results', async () => {
    const [g] = await markCovered([readable('gap_c', 'grid fee')], answer);
    assert.ok(!('coveredBy' in g));
  });

  it('asks once per readable gap, with its representative, and never for a hashed gap', async () => {
    const asked = [];
    await markCovered([readable('gap_a', 'what is almagest', 3), hashed('gap_h'), readable('gap_b', 'battery warranty terms')], async (q) => {
      asked.push(q);
      return answer(q);
    });
    assert.deepEqual(asked, ['what is almagest', 'battery warranty terms']);
  });

  it('a hashed gap is left alone and keeps its place', async () => {
    const h = hashed('gap_h');
    const [out] = await markCovered([h], async () => { throw new Error('must not be called'); });
    assert.deepEqual(out, h);
  });

  it('an answer that throws leaves that gap unmarked and does not stop the others', async () => {
    const gaps = [readable('gap_x', 'explodes here'), readable('gap_a', 'what is almagest')];
    const out = await markCovered(gaps, async (q) => { if (q === 'explodes here') throw new Error('index is broken'); return answer(q); });
    assert.ok(!('coveredBy' in out.find((g) => g.cluster === 'gap_x')));
    assert.equal(out.find((g) => g.cluster === 'gap_a').coveredBy[0].slug, 'almagest');
  });

  it('puts covered gaps after the uncovered ones, each group in its existing order', async () => {
    const gaps = [readable('gap_1', 'what is almagest'), readable('gap_2', 'battery warranty terms'), hashed('gap_3'), readable('gap_4', 'grid fee')];
    const out = await markCovered(gaps, answer);
    assert.deepEqual(out.map((g) => g.cluster), ['gap_2', 'gap_3', 'gap_4', 'gap_1']);
  });
});

describe('gaps: covered gaps from the live wiki', () => {
  /** The MCP module's search, reduced to what gaps() reads: a page that now answers "what is almagest". */
  function withSearch(ctx, search) {
    ctx.mcp = { search };
    return ctx;
  }
  const asked = (ctx, text, days, sessionId) =>
    ctx.telemetry.record({ tool: 'search', query: text, results: [], answered: false, sessionId, ts: daysAgo(days) });

  it('gaps() marks what search now answers, and orders the open ones first', async () => {
    const ctx = makeCtx();
    asked(ctx, 'What is Almagest?', 1, 's1');
    asked(ctx, 'battery warranty terms', 1, 's2');
    withSearch(ctx, async (q) => (q === 'What is Almagest?'
      ? { answered: true, results: [{ slug: 'almagest', title: 'Almagest' }] }
      : { answered: false, results: [] }));
    const gaps = await ctx.telemetry.gaps();
    assert.deepEqual(gaps.map((g) => g.representative), ['battery warranty terms', 'What is Almagest?']);
    assert.deepEqual(gaps[1].coveredBy, [{ slug: 'almagest', title: 'Almagest' }]);
    assert.ok(!('coveredBy' in gaps[0]));
  });

  it('gaps() returns the gaps unmarked when no search is reachable', async () => {
    const ctx = makeCtx();
    asked(ctx, 'What is Almagest?', 1, 's1');
    const [g] = await ctx.telemetry.gaps();
    assert.ok(!('coveredBy' in g));
  });

  it('a failing search never breaks the gap list, and is logged at debug', async () => {
    const ctx = makeCtx();
    asked(ctx, 'What is Almagest?', 1, 's1');
    withSearch(ctx, async () => { throw new Error('index not built'); });
    const gaps = await ctx.telemetry.gaps();
    assert.equal(gaps.length, 1);
    assert.ok(!('coveredBy' in gaps[0]));
    assert.ok(ctx.log.lines.some((l) => l.level === 'debug' && /coverage/.test(l.msg)), JSON.stringify(ctx.log.lines.map((l) => l.msg)));
  });

  it('almagest gaps shows a covered column, and --json carries coveredBy', async () => {
    const ctx = makeCtx();
    asked(ctx, 'What is Almagest?', 1, 's1');
    withSearch(ctx, async () => ({ answered: true, results: [{ slug: 'almagest', title: 'Almagest' }] }));
    let out = '';
    const env = { ctx, stdout: (s) => { out += s; }, stderr: (s) => { out += s; } };
    assert.equal(await commands.gaps.run([], env), 0);
    assert.match(out, /wiki answers now/);
    assert.match(out, /What is Almagest\?\s+Almagest/);
    out = '';
    assert.equal(await commands.gaps.run(['--json'], env), 0);
    assert.deepEqual(JSON.parse(out).gaps[0].coveredBy, [{ slug: 'almagest', title: 'Almagest' }]);
  });
});
