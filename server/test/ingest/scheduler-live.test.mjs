import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createScheduler } from '../../src/ingest/scheduler.mjs';

describe('scheduler and live connectors', () => {
  it('does not schedule a live connector, and says so once', async () => {
    const warned = [];
    const synced = [];
    const ctx = {
      log: { info() {}, error() {}, warn: (msg, data) => warned.push({ msg, data }) },
      config: { sources: { connectors: [] } },
      connectors: {
        list: async () => [
          { id: 'docs', schedule: '@hourly' },
          { id: 'wr-commits', schedule: '@hourly', live: true },
        ],
        sync: async (id) => { synced.push(id); return []; },
      },
    };
    const scheduler = createScheduler(ctx, { enqueue: async () => ({}) });
    const count = await scheduler.start();
    scheduler.stop();
    assert.equal(count, 1);
    assert.deepEqual(scheduler.entries.map((e) => e.id), ['docs']);
    assert.equal(warned.length, 1);
    assert.equal(warned[0].data.connector, 'wr-commits');
    await scheduler.tick(new Date(2026, 10, 18, 12, 0, 0));
    assert.deepEqual(synced, ['docs']);
  });
});
