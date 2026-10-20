/**
 * The Postgres driver against a real database. Runs only when
 * ALMAGEST_TEST_PG_URL is set, e.g.
 *
 *   docker run -d --rm --name almagest-pg -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16-alpine
 *   ALMAGEST_TEST_PG_URL=postgres://postgres:pw@127.0.0.1:55432/postgres npm test
 *
 * Every store gets its own throwaway schema, dropped at the end, so the suite
 * can point at a shared database without touching anything else in it.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, describe, it } from 'node:test';

import { newId } from '../../src/core/schemas.mjs';
import { storeConformance } from './store-conformance.mjs';

const URL = process.env.ALMAGEST_TEST_PG_URL || '';
const skip = URL ? false : 'ALMAGEST_TEST_PG_URL not set — Postgres store suite skipped';

const schemas = [];
const freshSchema = () => {
  const s = `almagest_test_${crypto.randomBytes(5).toString('hex')}`;
  schemas.push(s);
  return s;
};

async function make(schema = freshSchema()) {
  const { createPostgresStore } = await import('../../src/core/store/postgres.mjs');
  return createPostgresStore({ url: URL, schema, max: 4 });
}

after(async () => {
  if (!URL || schemas.length === 0) return;
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    for (const s of schemas) await client.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  } finally {
    await client.end();
  }
});

storeConformance('postgres', () => make(), { skip });

describe('store: postgres specifics', { skip }, () => {
  it('creates its schema idempotently — a second connect to the same schema is fine', async () => {
    const schema = freshSchema();
    const a = await make(schema);
    await a.kv.set('ns', 'k', { v: 1 });
    const b = await make(schema);
    assert.deepEqual(await b.kv.get('ns', 'k'), { v: 1 });
    await Promise.all([a.close(), b.close()]);
  });

  it('claims with SKIP LOCKED: concurrent workers never take the same job', async () => {
    const s = await make();
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push((await s.jobs.enqueue({ id: newId('job', 1000 + i), status: 'queued', kind: 'ingest' })).id);
    const claimed = await Promise.all(Array.from({ length: 16 }, (_, i) => s.jobs.claim(`w${i}`)));
    const got = claimed.filter(Boolean).map((j) => j.id);
    assert.equal(got.length, 12);
    assert.equal(new Set(got).size, 12, 'no job claimed twice');
    assert.deepEqual([...got].sort(), ids);
    assert.equal(claimed.filter((j) => j === null).length, 4);
    await s.close();
  });

  it('filters are typed: numbers, booleans and strings do not coerce into each other', async () => {
    const s = await make();
    await s.jobs.enqueue({ id: newId('job', 1), status: 'queued', attempts: 2, urgent: true });
    await s.jobs.enqueue({ id: newId('job', 2), status: 'queued', attempts: '2', urgent: 'true' });
    assert.equal((await s.jobs.list({ attempts: 2 })).length, 1);
    assert.equal((await s.jobs.list({ urgent: true })).length, 1);
    assert.equal((await s.jobs.list({ urgent: 'true' })).length, 1);
    assert.equal((await s.jobs.list({ attempts: [2, 3] })).length, 1);
    assert.equal((await s.jobs.list({ attempts: [] })).length, 0);
    assert.equal((await s.jobs.list({ missing: null })).length, 2, 'absent counts as null, like sqlite');
    await assert.rejects(() => s.jobs.list({ 'bad field': 1 }), /invalid filter field/);
    await s.close();
  });

  it('update merges a patch the way the other drivers do', async () => {
    const s = await make();
    const id = newId('prp');
    await s.proposals.create({ id, status: 'open', note: 'x', nested: { a: 1 } });
    const u = await s.proposals.update(id, { note: undefined, nested: { b: 2 } });
    assert.equal('note' in (await s.proposals.get(id)), false);
    assert.deepEqual(u.nested, { b: 2 }, 'shallow, like the spread');
    await assert.rejects(() => s.proposals.create({ id, status: 'dup' }), /already exists/);
    await s.close();
  });

  it('events: tool/slug filters in SQL, limit returns the latest oldest-first', async () => {
    const s = await make();
    for (let i = 0; i < 5; i++) {
      await s.events.append({ id: newId('evt', 1000 + i), ts: `2026-01-0${i + 1}T00:00:00Z`, tool: i % 2 ? 'search' : 'get_page', results: [{ slug: 'r', rank: 1 }], pagesRead: i === 4 ? ['p'] : [] });
    }
    assert.deepEqual((await s.events.query({ limit: 2 })).map((e) => e.ts), ['2026-01-04T00:00:00Z', '2026-01-05T00:00:00Z']);
    assert.equal((await s.events.query({ tool: 'search' })).length, 2);
    assert.equal((await s.events.query({ slug: 'p' })).length, 1);
    assert.equal((await s.events.query({ slug: 'r', until: '2026-01-03T00:00:00Z' })).length, 2);
    await s.close();
  });

  it('refuses to start without a url, and rejects an unsafe schema name', async () => {
    const { createPostgresStore } = await import('../../src/core/store/postgres.mjs');
    await assert.rejects(() => createPostgresStore({ url: '' }), /needs service\.store\.url/);
    await assert.rejects(() => createPostgresStore({ url: URL, schema: 'x; drop table' }), /invalid postgres schema/);
  });
});
