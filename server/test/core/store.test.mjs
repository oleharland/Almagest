import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { newId } from '../../src/core/schemas.mjs';
import { createMemoryStore } from '../../src/core/store/memory.mjs';
import { createSqliteStore } from '../../src/core/store/sqlite.mjs';

// One suite, both drivers: the memory store is only a valid test double while
// it behaves exactly like sqlite.
for (const [name, make] of [['memory', createMemoryStore], ['sqlite', () => createSqliteStore({ file: ':memory:' })]]) {
  describe(`store: ${name}`, () => {
    it('enqueues and claims jobs oldest-first, exactly once', async () => {
      const s = make();
      const a = await s.jobs.enqueue({ id: newId('job', 1000), status: 'queued', kind: 'ingest' });
      await s.jobs.enqueue({ id: newId('job', 2000), status: 'queued', kind: 'ingest' });
      const first = await s.jobs.claim('w1');
      assert.equal(first.id, a.id);
      assert.equal(first.status, 'running');
      assert.equal(first.attempts, 1);
      assert.ok(await s.jobs.claim('w2'));
      assert.equal(await s.jobs.claim('w3'), null);
      await s.close();
    });

    it('filters by equality, arrays, booleans; orders and limits', async () => {
      const s = make();
      for (const [i, status] of ['open', 'merged', 'open'].entries()) {
        await s.proposals.create({ id: newId('prp', 1000 + i), status, branch: `ingest/b${i}`, hot: i === 2 });
      }
      assert.equal((await s.proposals.list({ status: 'open' })).length, 2);
      assert.equal((await s.proposals.list({ status: ['open', 'merged'] })).length, 3);
      assert.equal((await s.proposals.list({ hot: true })).length, 1);
      const desc = await s.proposals.list({ order: 'desc', limit: 1 });
      assert.equal(desc[0].branch, 'ingest/b2');
      assert.equal((await s.proposals.getByBranch('ingest/b1')).status, 'merged');
      await s.close();
    });

    it('update merges a patch and keeps the id', async () => {
      const s = make();
      const d = await s.decisions.create({ id: newId('dec'), proposalId: 'prp_x', status: 'open' });
      const u = await s.decisions.update(d.id, { status: 'resolved', id: 'tampered' });
      assert.equal(u.id, d.id);
      assert.equal(u.status, 'resolved');
      assert.equal((await s.decisions.listByProposal('prp_x')).length, 1);
      await assert.rejects(() => s.decisions.update('dec_missing', {}), /not found/);
      await s.close();
    });

    it('queries and prunes events by time, tool and slug', async () => {
      const s = make();
      await s.events.append({ id: newId('evt'), ts: '2026-01-01T00:00:00Z', tool: 'search', results: [{ slug: 'alpha', rank: 1 }], pagesRead: [] });
      await s.events.append({ id: newId('evt'), ts: '2026-02-01T00:00:00Z', tool: 'get_page', results: [], pagesRead: ['beta'] });
      assert.equal((await s.events.query({ since: '2026-01-15T00:00:00Z' })).length, 1);
      assert.equal((await s.events.query({ slug: 'alpha' })).length, 1);
      assert.equal((await s.events.query({ tool: 'get_page', slug: 'beta' })).length, 1);
      assert.equal(await s.events.prune('2026-01-15T00:00:00Z'), 1);
      assert.equal((await s.events.query({})).length, 1);
      await s.close();
    });

    it('audit is append-only and kv round-trips', async () => {
      const s = make();
      await s.audit.append({ id: newId('aud'), action: 'proposal.approve', target: 'prp_1' });
      assert.equal(s.audit.update, undefined);
      assert.equal(s.audit.delete, undefined);
      assert.equal((await s.audit.list({ action: 'proposal.approve' })).length, 1);
      await s.kv.set('cursor', 'drive', { since: 'x' });
      assert.deepEqual(await s.kv.get('cursor', 'drive'), { since: 'x' });
      assert.equal((await s.kv.list('cursor')).length, 1);
      await s.kv.delete('cursor', 'drive');
      assert.equal(await s.kv.get('cursor', 'drive'), null);
      await s.close();
    });
  });
}
