import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pseudonymize } from '../../src/core/schemas.mjs';
import { buildEvent, normalizeQuery, privacyOf, tokenize } from '../../src/telemetry/events.mjs';
import { makeCtx, NOW } from './fixtures.mjs';

const SECRET = 'test-secret';
const build = (partial, modes = {}) => buildEvent(partial, { privacy: privacyOf(modes), now: NOW, secret: SECRET });

describe('telemetry events: normalisation', () => {
  it('tokenises to a sorted, unique, stopword-free set, folding plurals and accents', () => {
    assert.deepEqual(tokenize('What is the Grid Connection fee?'), ['connection', 'fee', 'grid']);
    assert.deepEqual(tokenize('grid connection FEES for grid'), ['connection', 'fee', 'grid']);
    assert.deepEqual(tokenize('Café über'), ['cafe', 'uber']);
    assert.deepEqual(tokenize('glass status'), ['glass', 'status']);
    assert.equal(normalizeQuery('fee  for the GRID'), normalizeQuery('grid fee?'));
  });

  it('rejects an unknown privacy mode instead of falling back to plain', () => {
    assert.throws(() => privacyOf({ store_queries: 'hash' }), /store_queries/);
    assert.throws(() => privacyOf({ store_actor: 'anon' }), /store_actor/);
    assert.throws(() => privacyOf({ store_tokens: 'none' }), /store_tokens/);
  });
});

describe('telemetry events: privacy modes', () => {
  const partial = { channel: 'mcp', tool: 'search', actorId: 'usr_ada', sessionId: 'sess-1', client: 'claude.ai', query: 'Grid connection fee', results: [], answered: false, latencyMs: 12.6 };

  it('plain keeps the text, and always adds the hash and token set', () => {
    const e = build(partial, { store_queries: 'plain', store_actor: 'plain' });
    assert.match(e.id, /^evt_/);
    assert.equal(e.ts, new Date(NOW).toISOString());
    assert.equal(e.query, 'Grid connection fee');
    assert.equal(e.queryHash, pseudonymize('connection fee grid', SECRET));
    assert.deepEqual(e.queryTokens, ['connection', 'fee', 'grid']);
    assert.equal(e.actorId, 'usr_ada');
    assert.equal(e.sessionId, 'sess-1');
    assert.equal(e.latencyMs, 13);
    assert.equal(e.answered, false);
    assert.equal(e.queryHashed, undefined);
  });

  it('hashed stores a keyed hash in place of the text, never the text', () => {
    const e = build(partial, { store_queries: 'hashed', store_actor: 'hashed' });
    assert.equal(e.query, pseudonymize('Grid connection fee', SECRET));
    assert.equal(e.queryHashed, true);
    assert.ok(!JSON.stringify(e).includes('Grid connection'));
    assert.deepEqual(e.queryTokens, ['connection', 'fee', 'grid'], 'tokens stay readable unless store_tokens: hashed');
    assert.equal(e.actorId, pseudonymize('usr_ada', SECRET));
    assert.equal(e.sessionId, pseudonymize('sess-1', SECRET));
  });

  it('store_tokens: hashed leaves nothing readable but keeps tokens comparable', () => {
    const a = build(partial, { store_queries: 'hashed', store_tokens: 'hashed' });
    const b = build({ ...partial, query: 'fees for grid connections' }, { store_queries: 'hashed', store_tokens: 'hashed' });
    assert.ok(!/grid|fee|connection/.test(JSON.stringify(a)));
    assert.equal(a.tokensHashed, true);
    assert.deepEqual(a.queryTokens, b.queryTokens);
  });

  it('none drops query, hash and tokens; store_actor none drops the actor but keeps a hashed session', () => {
    const e = build(partial, { store_queries: 'none', store_actor: 'none' });
    for (const k of ['query', 'queryHash', 'queryTokens']) assert.equal(e[k], undefined, k);
    assert.equal(e.actorId, undefined);
    assert.equal(e.sessionId, pseudonymize('sess-1', SECRET));
  });

  it('takes the human behind an agent actor as the actor', () => {
    const e = build({ tool: 'get_page', actor: { id: 'agent:claude', onBehalfOf: { id: 'usr_bo' } } }, { store_actor: 'plain' });
    assert.equal(e.actorId, 'usr_bo');
  });

  it('trims results to the top 10 by rank and normalises shapes', () => {
    const results = Array.from({ length: 15 }, (_, i) => ({ slug: `p${i}`, rank: 15 - i, score: i }));
    const e = build({ tool: 'search', results: [...results, { rank: 1 }, 'bare-slug'] });
    assert.equal(e.results.length, 10);
    assert.deepEqual(e.results.map((r) => r.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(e.pagesRead, []);
    assert.equal(e.answered, null);
  });

  it('keeps a valid caller ts (backfill) and the feedback verdict', () => {
    const e = build({ tool: 'feedback', ts: '2026-01-02T03:04:05Z', pagesRead: ['a', 'a'], helpful: false });
    assert.equal(e.ts, '2026-01-02T03:04:05.000Z');
    assert.deepEqual(e.pagesRead, ['a']);
    assert.equal(e.helpful, false);
    assert.throws(() => build({ query: 'no tool' }), /needs a tool/);
  });
});

describe('telemetry.record', () => {
  it('appends asynchronously, without the caller awaiting anything', async () => {
    const ctx = makeCtx();
    const ret = ctx.telemetry.record({ tool: 'get_page', pagesRead: ['alpha'] });
    assert.equal(ret, undefined);
    assert.equal((await ctx.store.events.query({})).length, 0, 'not written synchronously');
    await ctx.telemetry.flush();
    assert.equal((await ctx.store.events.query({})).length, 1);
  });

  it('never throws — not on garbage input, not when the store fails', async () => {
    const ctx = makeCtx();
    ctx.store.events.append = async () => { throw new Error('disk on fire'); };
    assert.doesNotThrow(() => ctx.telemetry.record(null));
    assert.doesNotThrow(() => ctx.telemetry.record({ query: 'x' }));
    assert.doesNotThrow(() => ctx.telemetry.record({ tool: 'search', query: 'x' }));
    await ctx.telemetry.flush();
    const s = ctx.telemetry.stats();
    assert.equal(s.rejected, 2);
    assert.equal(s.failed, 1);
    assert.ok(ctx.log.lines.some((l) => l.level === 'warn' && /append failed/.test(l.msg)));
  });

  it('a throwing store call (not just a rejected promise) is contained too', async () => {
    const ctx = makeCtx();
    ctx.store.events.append = () => { throw new Error('sync boom'); };
    ctx.telemetry.record({ tool: 'search' });
    await ctx.telemetry.flush();
    assert.equal(ctx.telemetry.stats().failed, 1);
  });

  it('bounds the buffer when the store is slow, dropping the oldest and counting it', async () => {
    const ctx = makeCtx({ telemetry: { buffer_size: 3 } });
    let release;
    const gate = new Promise((r) => { release = r; });
    const written = [];
    ctx.store.events.append = async (e) => { await gate; written.push(e.pagesRead[0]); };
    for (let i = 0; i < 6; i++) ctx.telemetry.record({ tool: 'get_page', pagesRead: [`p${i}`] });
    await new Promise((r) => setImmediate(r));
    const mid = ctx.telemetry.stats();
    assert.ok(mid.buffered <= 3, `buffered ${mid.buffered}`);
    assert.ok(mid.dropped >= 2, `dropped ${mid.dropped}`);
    release();
    await ctx.telemetry.flush();
    assert.ok(written.includes('p5'), 'the newest event survives');
    assert.equal(ctx.telemetry.stats().buffered, 0);
  });

  it('is a no-op when telemetry.enabled is false, and demand reads as zeros', async () => {
    const ctx = makeCtx({ telemetry: { enabled: false } });
    ctx.telemetry.record({ tool: 'get_page', pagesRead: ['alpha'] });
    await ctx.telemetry.flush();
    assert.equal((await ctx.store.events.query({})).length, 0);
    const m = await ctx.demand.get(['alpha']);
    assert.deepEqual(m.get('alpha'), { score: 0, rank: 0, hot: false });
    assert.deepEqual(await ctx.demand.hot(), []);
    assert.deepEqual(await ctx.telemetry.gaps(), []);
    assert.deepEqual(await ctx.telemetry.reverifyQueue(), []);
  });
});
