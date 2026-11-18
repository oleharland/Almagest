import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clusterGaps } from '../../src/telemetry/gaps.mjs';
import { commands } from '../../src/telemetry/cli.mjs';
import { daysAgo, makeCtx, NOW } from './fixtures.mjs';

const lookup = (extra = {}) => ({ step: 'connectors', steps: ['sources', 'staged', 'connectors'], connectorsAsked: 1, fetched: 1, cacheHits: 0, latencyMs: 40, incomplete: false, skipped: [], queued: [], ...extra });
const miss = (id, query, days, tokens, extra) => ({
  id, ts: daysAgo(days), tool: 'ask', answered: false, results: [], query, queryTokens: tokens, sessionId: `s${id}`,
  ...(extra ? { extra } : {}),
});

describe('gaps: what live lookup did', () => {
  it('summarises served count, last step, connectors and job ids; null without lookup', () => {
    const tokens = ['grid', 'fee'];
    const events = [
      miss('1', 'grid fee', 9, tokens, { lookup: lookup({ step: 'staged', queued: [] }) }),
      miss('2', 'grid fee', 6, tokens),
      miss('3', 'grid fee', 3, tokens, { lookup: lookup({ step: 'connectors', connectors: ['team-drive'], queued: ['job_b'] }) }),
      miss('4', 'grid fee', 2, tokens, { lookup: lookup({ step: 'connectors', connectors: ['team-drive'], queued: ['job_a', 'job_b'], connectorsAsked: 2 }) }),
      miss('5', 'grid fee', 1, tokens, { lookup: lookup({ step: null, queued: [] }) }),   // lookup ran, found nothing
      miss('6', 'battery', 1, ['battery']),
    ];
    const [grid, battery] = clusterGaps(events, { now: NOW });
    assert.deepEqual(grid.lookup, { served: 3, lastStep: 'connectors', connectors: ['team-drive'], connectorsAsked: 1 + 1 + 2 + 1, jobs: ['job_a', 'job_b'] });
    assert.equal(battery.lookup, null);
  });

  it('adds one sentence to the suggestion only when lookup served it', () => {
    const tokens = ['grid', 'fee'];
    const base = 'No page covers "grid fee" — 1 request in 1 day; consider submitting a source.';
    const a = clusterGaps([miss('1', 'grid fee', 1, tokens, { lookup: lookup({ connectors: ['team-drive'], queued: ['job_1'] }) })], { now: NOW })[0];
    assert.equal(a.suggestion, `${base} Served 1 time from team-drive; an ingest job is queued.`);
    const b = clusterGaps([1, 2, 3, 4].map((i) => miss(String(i), 'grid fee', 1, tokens, { lookup: lookup({ connectors: ['team-drive'] }) }))
      .map((e, i) => ({ ...e, sessionId: 's1', ts: daysAgo(1 - i / 100) })), { now: NOW })[0];
    assert.match(b.suggestion, /Served 4 times from team-drive; nothing is queued\.$/);
    const c = clusterGaps([miss('1', 'grid fee', 1, tokens, { lookup: lookup({ step: 'staged' }) })], { now: NOW })[0];
    assert.match(c.suggestion, /Served 1 time from staged documents; nothing is queued\.$/);
    // lookup ran but served nothing: wording untouched
    const d = clusterGaps([miss('1', 'grid fee', 1, tokens, { lookup: lookup({ step: null }) })], { now: NOW })[0];
    assert.equal(d.suggestion, base);
    assert.equal(d.lookup.served, 0);
    // no lookup at all: unchanged
    assert.equal(clusterGaps([miss('1', 'grid fee', 1, tokens)], { now: NOW })[0].suggestion, base);
    for (const g of [a, b, c]) assert.ok(!/[—–]/.test(g.suggestion.split('source.')[1]), 'no dashes in the added sentence');
  });
});

describe('gaps: the recorder keeps the lookup summary', () => {
  it('stores extra.lookup from ask-style events and drops anything else', async () => {
    const ctx = makeCtx();
    ctx.telemetry.record({
      tool: 'ask', query: 'grid fee', answered: false, results: [], sessionId: 's1', ts: daysAgo(1),
      lookup: { ...lookup({ queued: ['job_1'] }), passage: 'secret text', title: 'Board deck' },
    });
    const [g] = await ctx.telemetry.gaps();
    assert.equal(g.lookup.served, 1);
    assert.deepEqual(g.lookup.jobs, ['job_1']);
    const stored = JSON.stringify(await ctx.store.events.query({}));
    assert.ok(!stored.includes('secret text') && !stored.includes('Board deck'));
  });

  it('keeps the ids of the connectors asked, and the gap names them', async () => {
    const ctx = makeCtx();
    ctx.telemetry.record({
      tool: 'ask', query: 'grid fee', answered: false, results: [], sessionId: 's1', ts: daysAgo(1),
      lookup: lookup({ connectors: ['team-drive', 'wiki'], queued: ['job_1'] }),
    });
    const [g] = await ctx.telemetry.gaps();
    assert.deepEqual(g.lookup.connectors, ['team-drive', 'wiki']);
    assert.match(g.suggestion, /Served 1 time from team-drive, wiki;/);
  });

  it('prints lookup in the CLI table, the suggestion and --json', async () => {
    const ctx = makeCtx();
    ctx.telemetry.record({ tool: 'ask', query: 'grid fee', answered: false, results: [], sessionId: 's1', ts: daysAgo(1), lookup: lookup({ queued: ['job_1'] }) });
    ctx.telemetry.record({ tool: 'search', query: 'battery warranty', answered: false, results: [], sessionId: 's2', ts: daysAgo(1) });
    let out = '';
    const env = { ctx, stdout: (s) => { out += s; }, stderr: (s) => { out += s; } };
    assert.equal(await commands.gaps.run([], env), 0);
    assert.match(out, /lookup/);
    assert.match(out, /served 1, queued/);
    assert.match(out, /→ No page covers "grid fee".*Served 1 time from a connected source; an ingest job is queued\./);
    out = '';
    assert.equal(await commands.gaps.run(['--json'], env), 0);
    const gaps = JSON.parse(out).gaps;
    assert.equal(gaps.find((g) => g.representative === 'grid fee').lookup.served, 1);
    assert.equal(gaps.find((g) => g.representative === 'battery warranty').lookup, null);

    // without any lookup the table has no lookup column
    const plain = makeCtx();
    plain.telemetry.record({ tool: 'search', query: 'battery warranty', answered: false, results: [], ts: daysAgo(1) });
    out = '';
    await commands.gaps.run([], { ctx: plain, stdout: (s) => { out += s; }, stderr: () => {} });
    assert.ok(!/lookup/.test(out));
  });
});
